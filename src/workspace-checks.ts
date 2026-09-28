import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentGuarantees, ExecutionEnvironment } from "./execution-environment.js";
import { terminalOutputText } from "./terminal-output.js";
import type { Workspace, WorkspaceSnapshot } from "./workspace.js";

export type CheckOutcome = "passed" | "failed" | "timed_out" | "cancelled" | "not_started" | "unconfirmed" | "changed_files";

/** Which verifier produced a result (decision 015). */
export type VerifierKind = "command" | "oxlint" | "lemmascript";

/**
 * What one verifier observed about one exact workspace tree: its outcome, the
 * claim a pass establishes, and what it does not establish.
 */
export interface CheckResult {
  readonly verifier: VerifierKind;
  /** What ran, as the operator reads it: the command, or the verifier and file. */
  readonly command: string;
  readonly claim: string;
  readonly limits: string;
  readonly tree: string;
  /** The provider that ran the check and what it enforced. */
  readonly environment: string;
  readonly guarantees: EnvironmentGuarantees;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The end of combined stdout and stderr, as a terminal would show it: without colors or redrawn progress. */
  readonly output: string;
}

const outputLimit = 8 * 1024;
const defaultTimeoutSeconds = 15 * 60;

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

/**
 * Run each approved command in the session's environment against the reviewed
 * snapshot, and record which environment produced the result. A check that
 * changes tracked or new files no longer describes that snapshot.
 */
export async function runChecks(environment: ExecutionEnvironment, workspace: Workspace, snapshot: WorkspaceSnapshot,
  commands: readonly string[], signal: AbortSignal, timeoutSeconds: number = defaultTimeoutSeconds):
Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    let output = "";
    const run = await environment.run(command, { cwd: workspace.checkout, timeoutSeconds, signal,
      onOutput: (chunk) => { output = (output + chunk.toString("utf8")).slice(-outputLimit); } });
    const unchanged = workspace.snapshot().tree === snapshot.tree;
    const outcome: CheckOutcome = run.outcome === "exited"
      ? !unchanged ? "changed_files" : run.exitCode === 0 ? "passed" : "failed"
      : run.outcome;
    results.push({ verifier: "command", command, claim: `\`${command}\` exits with code 0 on this tree`,
      limits: "Establishes only what the command itself tests.", tree: snapshot.tree, environment: environment.provider,
      guarantees: environment.guarantees, outcome, exitCode: run.exitCode, durationMs: Date.now() - started,
      output: terminalOutputText(output) });
    if (outcome === "cancelled" || outcome === "unconfirmed" || outcome === "changed_files") break;
  }
  return results;
}
