import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentGuarantees, ExecutionEnvironment } from "./execution-environment.js";
import { terminalOutputText } from "./terminal-output.js";
import { type CheckOrigin, type CheckOutcome, checkOrigin } from "./verification/check-origin-rule.js";
import type { Workspace, WorkspaceSnapshot } from "./workspace.js";

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
  /** For a command that failed or timed out: how it ended on the candidate's base, and so whose failure it is (decision 039). */
  readonly base?: BaseCheck;
}

/** One command's run on the candidate's base, in the same environment. */
export interface BaseCheck {
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly origin: CheckOrigin;
}

/**
 * Base runs already made, by command, base and environment: the base does not
 * change between correction rounds, so a round does not pay for it again.
 */
export type BaseRuns = Map<string, Pick<BaseCheck, "outcome" | "exitCode">>;

/** What the base run says about a failure, as the operator and the reviewers read it. */
export function describeBase(base: BaseCheck): string {
  const ended = `${base.outcome.replace("_", " ")}${base.exitCode === null ? "" : ` (exit ${base.exitCode})`}`;
  if (base.origin === "introduced") return "passes without these changes, so the failure comes with them";
  if (base.origin === "preexisting") return `also ${ended} without these changes, so it does not come from them`;
  return `without these changes: ${ended}, so whether the failure comes with these changes is unknown`;
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

interface CommandRun {
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly output: string;
}

async function runCommand(environment: ExecutionEnvironment, workspace: Workspace, command: string, signal: AbortSignal,
  timeoutSeconds: number, unchanged: () => boolean): Promise<CommandRun> {
  let output = "";
  const run = await environment.run(command, { cwd: workspace.checkout, timeoutSeconds, signal,
    onOutput: (chunk) => { output = (output + chunk.toString("utf8")).slice(-outputLimit); } });
  const outcome: CheckOutcome = run.outcome === "exited"
    ? !unchanged() ? "changed_files" : run.exitCode === 0 ? "passed" : "failed"
    : run.outcome;
  return { outcome, exitCode: run.exitCode, output };
}

function failing(outcome: CheckOutcome): boolean { return outcome === "failed" || outcome === "timed_out"; }

/**
 * Run each failing command again on the base, as a commit queue retries a
 * failure without the patch, and record whose failure it is. The base is
 * checked out only once, for all of them, and only if a run is not known yet.
 */
async function attributeFailures(environment: ExecutionEnvironment, workspace: Workspace, snapshot: WorkspaceSnapshot,
  results: readonly CheckResult[], signal: AbortSignal, timeoutSeconds: number, baseRuns: BaseRuns): Promise<CheckResult[]> {
  const key = (command: string): string => JSON.stringify([environment.provider, snapshot.base, command]);
  const missing = results.filter((result) => failing(result.outcome) && !baseRuns.has(key(result.command)));
  if (missing.length > 0 && !signal.aborted) {
    await workspace.atBase(snapshot, async (intact) => {
      for (const result of missing) {
        if (signal.aborted) return;
        const run = await runCommand(environment, workspace, result.command, signal, timeoutSeconds, intact);
        // A cancelled or unconfirmed run says nothing about the base, so it is not remembered.
        if (run.outcome !== "cancelled" && run.outcome !== "unconfirmed") {
          baseRuns.set(key(result.command), { outcome: run.outcome, exitCode: run.exitCode });
        }
        // Later commands would run on a changed base; they stay unknown.
        if (run.outcome === "changed_files") return;
      }
    });
  }
  return results.map((result) => {
    if (!failing(result.outcome)) return result;
    const base = baseRuns.get(key(result.command)) ?? { outcome: "not_started" as const, exitCode: null };
    return { ...result, base: { ...base, origin: checkOrigin(result.outcome, base.outcome) } };
  });
}

export interface CheckOptions {
  readonly timeoutSeconds?: number;
  /** Base runs to reuse and extend; without it, each call runs the base afresh. */
  readonly baseRuns?: BaseRuns;
}

/**
 * Run each approved command in the session's environment against the reviewed
 * snapshot, and record which environment produced the result. A check that
 * changes tracked or new files no longer describes that snapshot. A command
 * that fails or times out runs again on the snapshot's base (decision 039).
 */
export async function runChecks(environment: ExecutionEnvironment, workspace: Workspace, snapshot: WorkspaceSnapshot,
  commands: readonly string[], signal: AbortSignal, options: CheckOptions = {}): Promise<readonly CheckResult[]> {
  const timeoutSeconds = options.timeoutSeconds ?? defaultTimeoutSeconds;
  const results: CheckResult[] = [];
  for (const command of commands) {
    const started = Date.now();
    const run = await runCommand(environment, workspace, command, signal, timeoutSeconds,
      () => workspace.snapshot().tree === snapshot.tree);
    results.push({ verifier: "command", command, claim: `\`${command}\` exits with code 0 on this tree`,
      limits: "Establishes only what the command itself tests.", tree: snapshot.tree, environment: environment.provider,
      guarantees: environment.guarantees, outcome: run.outcome, exitCode: run.exitCode, durationMs: Date.now() - started,
      output: terminalOutputText(run.output) });
    if (run.outcome === "cancelled" || run.outcome === "unconfirmed" || run.outcome === "changed_files") break;
  }
  return attributeFailures(environment, workspace, snapshot, results, signal, timeoutSeconds, options.baseRuns ?? new Map());
}
