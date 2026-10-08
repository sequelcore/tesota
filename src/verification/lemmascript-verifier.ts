import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type Evidence, contentHash } from "../evidence.js";
import { type ProcessRun, runProcess } from "../process.js";
import { type ProofOutcome, proofOutcome } from "./proof-outcome-rule.js";

const timeoutMs = 5 * 60_000;
const limits = "Proves only the annotated properties of the translated functions, within LemmaScript's supported " +
  "TypeScript subset. It says nothing about unannotated code, or whether the properties are what was asked.";

/** The `//@` annotation lines of a LemmaScript source, as written. */
export function annotations(source: string): string[] {
  return source.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("//@"));
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

/** The `.dfy` LemmaScript used: its configuration can keep proofs in another folder, which its "Generated:" line names. */
function proofPath(root: string, path: string, printed: string): string {
  const generated = /^Generated: (.+)\.gen\s*$/mu.exec(printed)?.[1];
  return generated === undefined ? path.replace(/\.ts$/u, ".dfy") : relative(root, generated).split("\\").join("/");
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
