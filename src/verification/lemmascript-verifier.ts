import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hostProvider } from "../host-environment.js";
import type { WorkspaceSnapshot } from "../workspace.js";
import type { CheckResult } from "../workspace-checks.js";
import type { ContentReader } from "./oxlint-verifier.js";

const timeoutMs = 5 * 60_000;
const outputLimit = 8 * 1024;
const limits = "Proves only the annotated properties of the translated functions, within LemmaScript's supported " +
  "TypeScript subset. It says nothing about unannotated code, or whether the properties are what was asked.";

/** The `//@` annotation lines of a LemmaScript source, as written. */
export function annotations(source: string): string[] {
  return source.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("//@"));
}

interface Run { readonly status: number | null; readonly output: string; readonly error: boolean; readonly timedOut: boolean }

function run(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<Run> {
  return new Promise((settle) => {
    let output = "";
    const child = spawn(executable, [...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-outputLimit); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const stop = (): void => { child.kill(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    const finish = (result: Run): void => { clearTimeout(timer); signal.removeEventListener("abort", stop); settle(result); };
    child.once("error", (error) => { finish({ status: null, output: error.message, error: true, timedOut }); });
    child.once("close", (status) => { finish({ status, output, error: false, timedOut }); });
  });
}

function lscEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("lemmascript/package.json")), "tools", "dist", "lsc.js");
}

/** Whether Dafny answers on this computer, which every LemmaScript proof needs. */
export async function dafnyInstalled(signal: AbortSignal): Promise<boolean> {
  return (await run("dafny", ["--version"], tmpdir(), signal)).status === 0;
}

/** One `lsc check` of one file: how it ended, and the end of what it printed. */
export interface ProofRun {
  readonly outcome: "passed" | "failed" | "timed_out" | "cancelled" | "not_started";
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

/**
 * LemmaScript with Dafny on one TypeScript source, with its `.dfy` companion
 * when there is one. Both are copied to a private directory, because `lsc`
 * writes generated proof files next to its input, so the caller's files never
 * change.
 */
export async function proveSource(name: string, source: string, companion: string | undefined,
  signal: AbortSignal): Promise<ProofRun> {
  const started = Date.now();
  const directory = await mkdtemp(join(tmpdir(), "tesota-lemmascript-"));
  try {
    await writeFile(join(directory, name), source, { mode: 0o600 });
    if (companion !== undefined) await writeFile(join(directory, name.replace(/\.ts$/u, ".dfy")), companion, { mode: 0o600 });
    const proof = await run(process.execPath, [lscEntry(), "check", "--backend=dafny", name], directory, signal);
    const outcome = signal.aborted ? "cancelled" : proof.timedOut ? "timed_out" : proof.error ? "not_started" :
      proof.status === 0 ? "passed" : "failed";
    return { outcome, exitCode: proof.status, output: proof.output, durationMs: Date.now() - started };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * LemmaScript with Dafny on the candidate's added and modified TypeScript
 * files that carry `//@` annotations, each proved by `proveSource`.
 */
export async function runLemmaScriptVerifier(snapshot: WorkspaceSnapshot, read: ContentReader,
  signal: AbortSignal): Promise<CheckResult[]> {
  const targets = snapshot.changes.flatMap((change) => {
    if (change.status === "deleted" || !change.path.endsWith(".ts")) return [];
    const source = read(snapshot.tree, change.path);
    return source !== undefined && annotations(source).length > 0 ? [{ path: change.path, source }] : [];
  });
  if (targets.length === 0) return [];
  const installed = await dafnyInstalled(signal);
  const results: CheckResult[] = [];
  for (const target of targets) {
    const proved = annotations(target.source);
    const base = { verifier: "lemmascript" as const, command: `lemmascript ${target.path}`, tree: snapshot.tree, limits,
      claim: `LemmaScript and Dafny prove these annotations of ${target.path}:\n${proved.map((line) => `  ${line}`).join("\n")}`,
      environment: "host", guarantees: hostProvider.guarantees, exitCode: null };
    if (!installed) {
      results.push({ ...base, outcome: "not_started", durationMs: 0, output: "Dafny is not installed, so nothing was proved." });
      continue;
    }
    const companion = read(snapshot.tree, target.path.replace(/\.ts$/u, ".dfy"));
    const proof = await proveSource(basename(target.path), target.source, companion, signal);
    results.push({ ...base, ...proof });
    if (signal.aborted) break;
  }
  return results;
}
