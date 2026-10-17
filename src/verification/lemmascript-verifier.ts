import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative } from "node:path";
import { type Evidence, contentHash } from "../evidence.js";
import { type ProcessRun, runProcess } from "../process.js";
import { parseJson } from "../json.js";
import { type ProofOutcome, proofOutcome } from "./proof-outcome-rule.js";

const timeoutMs = 5 * 60_000;
const limits = "Proves only the annotated properties of the translated functions, within LemmaScript's supported " +
  "TypeScript subset. It says nothing about unannotated code, or whether the properties are what was asked.";

/** The `//@` annotation lines of a LemmaScript source, as written. */
export function annotations(source: string): string[] {
  return source.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("//@"));
}

/** The specification keywords LemmaScript 0.6.4 reads with an expression (`parseAnnotations` in its `extract.js`). */
const specificationWord = "(?:requires|ensures|contract|invariant|decreases|done_with|type)";
const specificationLine = new RegExp(String.raw`^//@\s*${specificationWord}\b`, "u");
const readSpecification = new RegExp(String.raw`^//@ ${specificationWord} +\S`, "u");

/**
 * Whether LemmaScript skips a `//@` specification line without a word: one
 * that names a keyword it reads with an expression, such as `ensures`, but
 * not as `//@ <keyword> <expression>`, with a single space after `//@` and a
 * space after the keyword. `//@   ensures x`, `//@ensures x` and an
 * `//@ ensures` with nothing after it are all left out of the proof, which
 * then checks less than the file says. A misspelled keyword is not caught.
 */
export function unreadSpecification(line: string): boolean {
  const text = line.trim();
  return specificationLine.test(text) && !readSpecification.test(text);
}

/** The specification lines of `source` LemmaScript skips (`unreadSpecification`), with their line numbers. */
export function unreadSpecifications(source: string): { line: number; text: string }[] {
  return source.split(/\r?\n/u).flatMap((text, k) => unreadSpecification(text) ? [{ line: k + 1, text: text.trim() }] : []);
}

/** LemmaScript's and Dafny's processes, run so that a timeout or a stop ends Dafny's too (`runProcess`). */
function run(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<ProcessRun> {
  return runProcess(executable, args, cwd, signal, timeoutMs);
}

/** Resolved when a proof runs, not when the extension loads, so Pi opens even where LemmaScript is missing. */
function lscEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("lemmascript/package.json")), "tools", "dist", "lsc.js");
}

/** Whether Dafny answers on this computer, which every LemmaScript proof needs. */
export async function dafnyInstalled(signal: AbortSignal): Promise<boolean> {
  return (await run("dafny", ["--version"], tmpdir(), signal)).exitCode === 0;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

/** `lsc regen`, then `lsc check` when regen succeeded and nothing stopped it, as LemmaScript orders them. */
async function regenThenCheck(root: string, path: string, signal: AbortSignal):
  Promise<readonly [ProcessRun, ProcessRun | undefined]> {
  const lsc = (...command: string[]): Promise<ProcessRun> =>
    run(process.execPath, [lscEntry(), ...command, "--backend=dafny", path], root, signal);
  const regen = await lsc("regen", "--no-verify");
  return [regen, regen.ended === "exited" && regen.exitCode === 0 && !signal.aborted ? await lsc("check") : undefined];
}

function outcomeOf(regen: ProcessRun, check: ProcessRun | undefined, signal: AbortSignal): ProofOutcome {
  const verified = Number([...(check?.output ?? "").matchAll(/finished with (\d+) verified/gu)].at(-1)?.[1] ?? 0);
  return proofOutcome(signal.aborted, regen.ended === "timed_out" || check?.ended === "timed_out",
    regen.ended !== "not_started" && check?.ended !== "not_started", regen.exitCode === 0, check?.exitCode ?? -1, verified);
}

/** `path` by its real name: its nearest folder that exists, resolved, and the rest as given. */
function realName(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realName(parent), basename(path));
  }
}

/**
 * `path` relative to `root`, with `/`, both by their real names: LemmaScript
 * prints real paths, and a project may be reached through a link, as macOS's
 * temporary folder `/var` is one to `/private/var`, or by a short name, as
 * Windows' `RUNNER~1` (#472).
 */
function within(root: string, path: string): string {
  return relative(realName(root), realName(path)).split("\\").join("/");
}

/** The `.dfy` LemmaScript used: its configuration can keep proofs in another folder, which its "Generated:" line names. */
function proofPath(root: string, path: string, printed: string): string {
  const generated = /^Generated: (.+)\.gen\s*$/mu.exec(printed)?.[1];
  return generated === undefined ? path.replace(/\.ts$/u, ".dfy") : within(root, generated);
}

/** The folder `lsc config` says LemmaScript keeps `source`'s proof in, relative to `root`; undefined when it cannot say. */
async function proofFolder(root: string, source: string, signal: AbortSignal): Promise<string | undefined> {
  const config = await run(process.execPath, [lscEntry(), "config", source], root, signal);
  if (config.ended !== "exited" || config.exitCode !== 0) return undefined;
  try {
    const { artifactDir } = JSON.parse(config.output.slice(config.output.indexOf("{"))) as { artifactDir?: unknown };
    return typeof artifactDir === "string" ? within(root, artifactDir) : undefined;
  } catch { return undefined; }
}

/** The `proof-dir` a `lemmascript.json` sets, if the file is there and sets one. */
async function configuredProofDir(path: string): Promise<string | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined) return undefined;
  try {
    const proofDir = (parseJson(text) as Record<string, unknown>)["proof-dir"];
    return typeof proofDir === "string" ? proofDir : undefined;
  } catch { return undefined; }
}

const skippedFolders = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);
const scanLimit = 20_000;

/**
 * The files of the project at `root`, relative to it with `/`: at most
 * `scanLimit` entries, skipping dependency, build and hidden folders, which
 * hold no source of the project's own.
 */
export function* projectFiles(root: string): Generator<string> {
  const folders = [""];
  let seen = 0;
  while (folders.length > 0 && seen < scanLimit) {
    const folder = folders.pop() ?? "";
    let entries: Dirent[];
    try { entries = readdirSync(join(root, folder), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory() && !skippedFolders.has(entry.name) && !entry.name.startsWith(".")) folders.push(path);
      else if (entry.isFile()) yield path;
    }
  }
}

/**
 * The TypeScript sources whose LemmaScript proof is `proof`, a `.dfy` or
 * `.dfy.gen` relative to `root`. LemmaScript keeps a proof beside its source
 * unless a `lemmascript.json` sets `proof-dir`, which mirrors the source's
 * folder, relative to the configuration's, under that one (LemmaScript's
 * DESIGN_CONFIG.md, §3.3). So the candidates are the source beside the proof
 * and the one each `lemmascript.json` of the project (`projectFiles`)
 * mirrors there, and a candidate counts only when `lsc config` maps its
 * proof to `proof`'s folder, as LemmaScript itself resolves it. Candidates
 * the caller proves anyway (`known`) are left out unasked, since each
 * question starts a process and `lsc regen` rewrites a proof's `.dfy.gen`
 * whenever it proves its source.
 */
export async function proofSources(root: string, proof: string, signal: AbortSignal, known: ReadonlySet<string> = new Set()):
  Promise<string[]> {
  const folder = posix.dirname(proof);
  const name = `${posix.basename(proof).replace(/\.dfy(\.gen)?$/u, "")}.ts`;
  const candidates = new Set([posix.join(folder, name)]);
  for (const config of projectFiles(root)) {
    if (posix.basename(config) !== "lemmascript.json") continue;
    const at = posix.dirname(config);
    const proofDir = await configuredProofDir(join(root, config));
    // Rooted at `/` so that the folders compare as given, never against the working directory.
    const mirrored = proofDir === undefined ? undefined : posix.relative(posix.join("/", at, proofDir), posix.join("/", folder));
    if (mirrored !== undefined && !mirrored.startsWith("..")) candidates.add(posix.join(at, mirrored, name));
  }
  const sources: string[] = [];
  for (const source of [...candidates].sort()) {
    if (!known.has(source) && !source.startsWith("..") && await readIfPresent(join(root, source)) !== undefined &&
      await proofFolder(root, source, signal) === folder) sources.push(source);
  }
  return sources;
}

/**
 * LemmaScript with Dafny on one TypeScript file of the project at `root`,
 * `path` relative to it, run in place as LemmaScript's own workflow runs it:
 * `lsc regen` merges the changed source into the file's `.dfy`, keeping its
 * proof additions, then `lsc check` proves it. Proving in a copy would leave
 * the project's `.dfy` behind the source, which an independent `lsc check`
 * then rejects. The evidence covers the source and its `.dfy` as they are
 * after the run; a run that verified nothing is vacuous, never proved (`proofOutcome`).
 */
export async function proveFile(root: string, path: string, signal: AbortSignal): Promise<Evidence> {
  const started = Date.now();
  const source = await readIfPresent(join(root, path));
  const claim = `LemmaScript and Dafny prove these annotations of ${path}:\n` +
    annotations(source ?? "").map((line) => `  ${line}`).join("\n");
  const evidence = async (outcome: ProofOutcome, output: string, proof: string): Promise<Evidence> => {
    const files = [path, proof];
    const content = await Promise.all(files.map(async (file) => ({ path: file, content: await readIfPresent(join(root, file)) })));
    return { verifier: "lemmascript", claim, limits, outcome, output, durationMs: Date.now() - started, files,
      contentHash: contentHash(content) };
  };
  if (!await dafnyInstalled(signal)) {
    return evidence(proofOutcome(signal.aborted, false, false, false, -1, 0), "Dafny is not installed, so nothing was proved.",
      proofPath(root, path, ""));
  }
  const [regen, check] = await regenThenCheck(root, path, signal);
  const outcome = outcomeOf(regen, check, signal);
  const printed = (check ?? regen).output.trimEnd();
  const output = outcome === "vacuous"
    ? `${printed}\nLemmaScript verified nothing in this file, so nothing was proved.` : printed;
  return evidence(outcome, output, proofPath(root, path, `${regen.output}\n${check?.output ?? ""}`));
}

/**
 * How LemmaScript with Dafny ends on `source` alone, as file `name` in a
 * temporary folder: with no `.dfy` beside it, regen generates the program
 * without proof additions. Proof-based mutation proves its mutants this way,
 * so the project is never touched.
 */
export async function proveSource(name: string, source: string, signal: AbortSignal): Promise<ProofOutcome> {
  const directory = await mkdtemp(join(tmpdir(), "tesota-lemmascript-"));
  try {
    await writeFile(join(directory, name), source);
    const [regen, check] = await regenThenCheck(directory, name, signal);
    return outcomeOf(regen, check, signal);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
