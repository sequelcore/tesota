import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative } from "node:path";
import { type Evidence, contentHash } from "../evidence.js";
import { type ProcessRun, runProcess } from "../process.js";
import { inBinary } from "../binary.js";
import { parseJson } from "../json.js";
import { type ProofOutcome, proofOutcome } from "./proof-outcome-rule.js";
import { typescript } from "../typescript-source.js";
import type { ts as TypeScript } from "ts-morph";

const timeoutMs = 5 * 60_000;
const limits = "Proves only the annotated properties of the translated functions, within LemmaScript's supported " +
  "TypeScript subset. It says nothing about unannotated code, or whether the properties are what was asked.";

/** Dependency-owned clauses and selection, with source text from extract and semantic facts from info --typed (#772). */
export type ProofInfo = { readonly status: "unavailable"; readonly reason: string } | {
  readonly status: "read";
  readonly functions: readonly { readonly name: string; readonly clauses: readonly string[]; readonly bodyClauses: readonly string[] }[];
  readonly trusted: readonly { readonly name: string; readonly annotation: string }[];
  readonly semanticGap?: string;
};

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Read complete stdout up to 8 MiB; runProcess's human-readable tail is not a machine document. */
async function infoJson(root: string, path: string, typed: boolean, signal: AbortSignal): Promise<unknown> {
  const command = lscCommand();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const ran = await runProcess(command.executable, [...command.args, ...typed ? ["info", "--typed"] : ["extract"], path],
    root, signal, timeoutMs, undefined, { env: { ...process.env, LSC_RUN_LOG: "false" }, onStdout: (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) overflow = true;
      if (!overflow) chunks.push(chunk);
    } });
  if (overflow || ran.ended !== "exited" || ran.exitCode !== 0) throw new Error(overflow ? "LemmaScript metadata exceeds 8 MiB" : ran.output || ran.ended);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function clauses(fn: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const key of ["requires", "ensures", "contract"]) {
    const lines = fn[key] ?? [];
    if (!strings(lines)) throw new Error(`LemmaScript's ${key} metadata is not a list of clauses`);
    result.push(...lines.map((text) => `//@ ${key} ${text.trim()}`));
  }
  if (typeof fn["decreases"] === "string") result.push(`//@ decreases ${fn["decreases"].trim()}`);
  return result;
}

/** Body specifications are read from the dependency's raw IR, never reconstructed from extraction rules. */
function bodyClauses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(bodyClauses);
  if (!object(value)) return [];
  const found = Object.values(value).flatMap(bodyClauses);
  if (strings(value["invariants"])) found.push(...value["invariants"].map((text) => `//@ invariant ${text.trim()}`));
  if (typeof value["decreases"] === "string") found.push(`//@ decreases ${value["decreases"].trim()}`);
  if (value["kind"] === "assert" && typeof value["expr"] === "string") found.push(`//@ ${value["assumed"] === true ? "assume" : "assert"} ${value["expr"].trim()}`);
  return found;
}

/** Top-level functions and qualified class methods as the dependency reports them. */
function reportedFunctions(module: Record<string, unknown>): unknown[] {
  if (!Array.isArray(module["functions"]) || !Array.isArray(module["classes"])) throw new Error("Invalid LemmaScript function inventory");
  return [...module["functions"], ...module["classes"].flatMap((cls: unknown) => {
    if (!object(cls) || typeof cls["name"] !== "string" || !Array.isArray(cls["methods"])) throw new Error("Invalid LemmaScript class inventory");
    return cls["methods"].map((method: unknown) => {
      if (!object(method) || typeof method["name"] !== "string") throw new Error("Invalid LemmaScript method inventory");
      return { ...method, name: `${cls["name"]}.${method["name"]}` };
    });
  })];
}

/** Inspect the actual project file without writing any output beside it. */
export async function fileInfo(root: string, path: string, signal: AbortSignal): Promise<ProofInfo> {
  try {
    const raw = await infoJson(root, path, false, signal);
    if (!object(raw) || !Array.isArray(raw["functions"]) || !Array.isArray(raw["externs"])) throw new Error("Invalid LemmaScript extraction metadata");
    const functions = [...reportedFunctions(raw), ...raw["externs"]].map((fn: unknown) => {
      if (!object(fn)) throw new Error("Invalid LemmaScript function metadata");
      const name = fn["name"] ?? fn["qualified"];
      if (typeof name !== "string") throw new Error("LemmaScript function metadata has no name");
      return { name, clauses: clauses(fn), bodyClauses: bodyClauses(fn["body"]) };
    });
    try {
      const typed = await infoJson(root, path, true, signal);
      if (!object(typed) || typed["schema"] !== 1 || !Array.isArray(typed["functions"])) throw new Error("Unsupported LemmaScript typed-info schema");
      const trusted = reportedFunctions(typed).flatMap((fn: unknown) => {
        if (!object(fn) || typeof fn["name"] !== "string" || !strings(fn["bodyKinds"])) throw new Error("Invalid LemmaScript semantic metadata");
        const annotations = [...fn["autohavoc"] === true ? ["//@ autohavoc"] : [], ...fn["forcePure"] === true ? ["//@ pure"] : [],
          ...fn["bodyKinds"].includes("havoc") ? ["havoc in translated body"] : [],
          ...fn["isPure"] === false ? ["impure function"] : []];
        return annotations.map((annotation) => ({ name: fn["name"] as string, annotation }));
      });
      return { status: "read", functions, trusted };
    } catch (error) {
      return { status: "read", functions, trusted: [], semanticGap: error instanceof Error ? error.message : String(error) };
    }
  } catch (error) { return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
}

// Standalone historical sources and mutation fixtures have no project to inspect. Cache only successful, immutable
// source inspections, bounded to 32 entries; actual project inspections always read their current configuration.
const sourceInfos = new Map<string, ProofInfo>();
export async function sourceInfo(path: string, source: string, signal: AbortSignal = new AbortController().signal): Promise<ProofInfo> {
  const key = contentHash([{ path, content: source }]);
  const cached = sourceInfos.get(key);
  if (cached !== undefined && !signal.aborted) return cached;
  const directory = await mkdtemp(join(tmpdir(), "tesota-proof-info-"));
  try {
    const name = basename(path);
    await writeFile(join(directory, name), source);
    const info = await fileInfo(directory, name, signal);
    if (info.status === "read" && info.semanticGap === undefined && !signal.aborted) {
      if (sourceInfos.size >= 32) sourceInfos.delete(sourceInfos.keys().next().value ?? "");
      sourceInfos.set(key, info);
    }
    return info;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** The `//@` annotation lines of a LemmaScript source, as written. */
export function annotations(source: string): string[] {
  return source.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("//@"));
}

function functionRanges(ts: typeof TypeScript, file: TypeScript.SourceFile, source: string):
  { start: number; end: number; name: string; skipped: boolean }[] {
  const ranges: { start: number; end: number; name: string; skipped: boolean }[] = [];
  const leading = (start: number): boolean => (ts.getLeadingCommentRanges(source, start) ?? [])
    .some(({ pos, end }) => source.slice(pos, end).trim() === "//@ skip");
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) ranges.push({ start: statement.pos, end: statement.end,
      name: statement.name.text, skipped: leading(statement.pos) });
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && ts.isArrowFunction(declaration.initializer)) {
        ranges.push({ start: statement.pos, end: statement.end, name: declaration.name.text, skipped: leading(statement.pos) });
      }
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      for (const method of statement.members) if (ts.isMethodDeclaration(method)) ranges.push({ start: method.pos, end: method.end,
        name: `${statement.name.text}.${method.name.getText(file)}`, skipped: leading(statement.pos) || leading(method.pos) });
    }
  }
  return ranges;
}

/** Specification lines absent from LemmaScript's attached clauses. The parser supplies positions, not selection. */
export async function unreadSpecifications(source: string, inspected?: ProofInfo): Promise<{ line: number; text: string }[]> {
  const info = inspected ?? await sourceInfo("source.ts", source);
  const ts = typescript();
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const ranges = functionRanges(ts, file, source);
  const attached = new Map(info.status === "read" ? info.functions.map((fn) => [fn.name, [...fn.clauses, ...fn.bodyClauses]]) : []);
  const unread: { line: number; text: string }[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const text = scanner.getTokenText().trim();
    if (!text.startsWith("//@") || /^\/\/@ (?:verify|skip|extern|pure|impure|autohavoc|backend|option|lean-module|type)(?:\s|$)/u.test(text)) continue;
    const position = scanner.getTokenPos();
    const owner = ranges.find(({ start, end }) => position >= start && position < end);
    // Deliberately omitted functions are already named as trust/selection limits, not silent attachment failures.
    if (owner?.skipped === true || owner !== undefined && info.status === "read" && !attached.has(owner.name)) continue;
    const clauses = owner === undefined ? [] : attached.get(owner.name) ?? [];
    const normalized = text.replace(/^(\/\/@ \w+) +/u, "$1 ");
    const at = clauses.indexOf(normalized);
    if (at >= 0) clauses.splice(at, 1);
    else unread.push({ line: file.getLineAndCharacterOfPosition(position).line + 1, text });
  }
  return unread;
}

/**
 * LemmaScript's and Dafny's processes, run so that a timeout or a stop ends Dafny's too (`runProcess`).
 * LemmaScript records each run in `.lemmascript/` at the project's root unless told not to; Tesota writes
 * nothing into the project but the proof itself.
 */
function run(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<ProcessRun> {
  return runProcess(executable, args, cwd, signal, timeoutMs, undefined, { env: { ...process.env, LSC_RUN_LOG: "false" } });
}

/**
 * `lsc` with `args`, run as its own process: from a checkout, its script on
 * the runtime running Tesota, resolved when a proof runs rather than when the
 * extension loads, so Tesota opens even where LemmaScript is missing; in a
 * binary, which embeds LemmaScript, the binary's own `__lsc` command (#472).
 */
export function lscCommand(): { executable: string; args: readonly string[] } {
  if (inBinary) return { executable: process.execPath, args: ["__lsc"] };
  const require = createRequire(import.meta.url);
  return { executable: process.execPath, args: [join(dirname(require.resolve("lemmascript/package.json")), "tools", "dist", "lsc.js")] };
}

function lsc(args: readonly string[], cwd: string, signal: AbortSignal): Promise<ProcessRun> {
  const command = lscCommand();
  return run(command.executable, [...command.args, ...args], cwd, signal);
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
  const command = (...name: string[]): Promise<ProcessRun> => lsc([...name, "--backend=dafny", path], root, signal);
  const regen = await command("regen", "--no-verify");
  return [regen, regen.ended === "exited" && regen.exitCode === 0 && !signal.aborted ? await command("check") : undefined];
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
  const config = await lsc(["config", source], root, signal);
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
  let proofInfo: ProofInfo | undefined;
  let unread: readonly { line: number; text: string }[] = [];
  let claim = `LemmaScript and Dafny prove these annotations of ${path}:\n` +
    annotations(source ?? "").map((line) => `  ${line}`).join("\n");
  const evidence = async (outcome: ProofOutcome, output: string, proof: string): Promise<Evidence> => {
    const files = [path, proof];
    const content = await Promise.all(files.map(async (file) => ({ path: file, content: await readIfPresent(join(root, file)) })));
    return { verifier: "lemmascript", claim, limits, outcome, output, durationMs: Date.now() - started, files,
      contentHash: contentHash(content), ...proofInfo === undefined ? {} : { proofInfo },
      ...unread.length === 0 ? {} : { unreadSpecifications: unread } };
  };
  if (!await dafnyInstalled(signal)) {
    return evidence(proofOutcome(signal.aborted, false, false, false, -1, 0), "Dafny is not installed, so nothing was proved.",
      proofPath(root, path, ""));
  }
  const [regen, check] = await regenThenCheck(root, path, signal);
  const outcome = outcomeOf(regen, check, signal);
  if ((outcome === "passed" || outcome === "vacuous") && !signal.aborted) {
    proofInfo = await fileInfo(root, path, signal);
    if (outcome === "passed") unread = await unreadSpecifications(source ?? "", proofInfo);
    claim = proofInfo.status === "unavailable" ? `Proof scope for ${path} is unavailable: ${proofInfo.reason}`
      : `LemmaScript and Dafny checked these attached clauses of ${path}, within the recorded trust limits:\n` +
        proofInfo.functions.flatMap((fn) => [...fn.clauses, ...fn.bodyClauses].map((line) => `  ${fn.name}: ${line}`)).join("\n");
  }
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
