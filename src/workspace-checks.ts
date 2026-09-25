import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace, WorkspaceSnapshot } from "./workspace.js";

export type CheckOutcome = "passed" | "failed" | "timed_out" | "cancelled" | "not_started" | "changed_files";

/** What one check command observed about one exact workspace tree. */
export interface CheckResult {
  readonly command: string;
  readonly tree: string;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The end of combined stdout and stderr. */
  readonly output: string;
}

const outputLimit = 8 * 1024;
const defaultTimeoutMs = 15 * 60 * 1000;

function packageRunner(checkout: string): string {
  if (existsSync(join(checkout, "bun.lock")) || existsSync(join(checkout, "bun.lockb"))) return "bun run";
  if (existsSync(join(checkout, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(checkout, "yarn.lock"))) return "yarn run";
  return "npm run";
}

function packageScripts(checkout: string): readonly string[] {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("scripts" in manifest)) return [];
    const scripts = manifest.scripts;
    return typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : [];
  } catch { return []; }
}

/** Commands the repository appears to use for checking itself. The operator approves or replaces them. */
export function suggestChecks(checkout: string): readonly string[] {
  const scripts = packageScripts(checkout);
  if (scripts.length > 0) {
    const runner = packageRunner(checkout);
    if (scripts.includes("check")) return [`${runner} check`];
    return ["typecheck", "lint", "test"].filter((name) => scripts.includes(name)).map((name) => `${runner} ${name}`);
  }
  if (existsSync(join(checkout, "Cargo.toml"))) return ["cargo test"];
  if (existsSync(join(checkout, "go.mod"))) return ["go test ./..."];
  return [];
}

function stopProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

function runCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<{
  outcome: "exited" | "timed_out" | "cancelled" | "not_started"; exitCode: number | null; output: string;
}> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve({ outcome: "cancelled", exitCode: null, output: "" }); return; }
    let output = "";
    let stopped: "timed_out" | "cancelled" | undefined;
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-outputLimit); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = (reason: "timed_out" | "cancelled"): void => {
      if (stopped !== undefined || child.pid === undefined) return;
      stopped = reason;
      stopProcessTree(child.pid);
    };
    const timer = setTimeout(() => { stop("timed_out"); }, timeoutMs);
    const abort = (): void => { stop("cancelled"); };
    signal.addEventListener("abort", abort, { once: true });
    const finish = (result: { outcome: "exited" | "timed_out" | "cancelled" | "not_started"; exitCode: number | null }): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ ...result, output });
    };
    child.once("error", () => { finish({ outcome: stopped ?? "not_started", exitCode: null }); });
    child.once("close", (code) => { finish({ outcome: stopped ?? "exited", exitCode: code }); });
  });
}

/**
 * Run each approved command in the workspace against the reviewed snapshot. A
 * check that changes tracked or new files no longer describes that snapshot.
 */
export async function runChecks(workspace: Workspace, snapshot: WorkspaceSnapshot, commands: readonly string[],
  signal: AbortSignal, timeoutMs: number = defaultTimeoutMs): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    const run = await runCommand(command, workspace.checkout, signal, timeoutMs);
    const unchanged = workspace.snapshot().tree === snapshot.tree;
    const outcome: CheckOutcome = run.outcome === "exited"
      ? !unchanged ? "changed_files" : run.exitCode === 0 ? "passed" : "failed"
      : run.outcome;
    results.push({ command, tree: snapshot.tree, outcome, exitCode: run.exitCode,
      durationMs: Date.now() - started, output: run.output });
    if (outcome === "cancelled" || outcome === "changed_files") break;
  }
  return results;
}
