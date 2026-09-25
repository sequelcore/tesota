import type { TesotaShellProgress } from "./shell-progress.js";
import type { WorkspaceChange } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

export type WorkResult =
  | Readonly<{ status: "completed"; reply: string; changes: readonly WorkspaceChange[] }>
  | Readonly<{ status: "failed"; reason: string }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "unsettled" }>;

export type ReviewResult =
  | Readonly<{ status: "ready"; changes: readonly WorkspaceChange[]; checks: readonly CheckResult[] }>
  | Readonly<{ status: "cancelled" }>;

export type ApplyResult =
  | Readonly<{ status: "applied"; changes: readonly WorkspaceChange[] }>
  | Readonly<{ status: "conflict"; reason: string; paths: readonly string[] }>
  | Readonly<{ status: "uncertain"; applied: readonly string[] }>;

export interface TesotaShellDependencies {
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly report?: (progress: TesotaShellProgress) => void;
  /** Run one request in the workspace and report the pending changes afterwards. */
  readonly work: (request: string) => Promise<WorkResult>;
  /** Checks the operator approved earlier, or null when none were chosen yet. */
  readonly checks: () => readonly string[] | null;
  readonly suggestChecks: () => readonly string[];
  readonly setChecks: (commands: readonly string[]) => void;
  /** Snapshot the pending changes, run the approved checks on them and present the review. */
  readonly review: (checks: readonly string[]) => Promise<ReviewResult>;
  readonly apply: () => Promise<ApplyResult>;
  readonly reject: () => Promise<void>;
}

function ignoreProgress(_progress: TesotaShellProgress): void {}

const changeVerbs: Readonly<Record<WorkspaceChange["status"], string>> = { added: "add", modified: "edit", deleted: "delete" };

function describeChanges(changes: readonly WorkspaceChange[]): string {
  return changes.map((change) => `  ${changeVerbs[change.status]} ${change.path}`).join("\n");
}

function describeChecks(checks: readonly CheckResult[]): string {
  if (checks.length === 0) return "No checks ran.";
  return checks.map((check) => `  ${check.outcome.replace("_", " ")}: ${check.command}`).join("\n");
}

async function chooseChecks(dependencies: TesotaShellDependencies): Promise<readonly string[]> {
  const existing = dependencies.checks();
  if (existing !== null) return existing;
  const suggested = dependencies.suggestChecks();
  dependencies.write(suggested.length === 0
    ? "No checks were found for this repository.\n"
    : `Suggested checks:\n${suggested.map((command) => `  ${command}`).join("\n")}\n`);
  const answer = (await dependencies.ask(suggested.length === 0
    ? "Commands to run after each change (separate with ;), or Enter for none: "
    : "Enter to use these, type other commands (separate with ;), or 'none': ")).trim();
  const chosen = answer.length === 0 ? suggested : answer.toLowerCase() === "none" ? [] :
    answer.split(";").map((command) => command.trim()).filter((command) => command.length > 0);
  dependencies.setChecks(chosen);
  return chosen;
}

type Decision = "apply" | "reject" | "keep";

async function askDecision(dependencies: TesotaShellDependencies): Promise<Decision> {
  for (;;) {
    const answer = (await dependencies.ask("[a]pply, [r]eject, or [k]eep working: ")).trim().toLowerCase();
    if (answer === "a" || answer === "apply") return "apply";
    if (answer === "r" || answer === "reject") return "reject";
    if (answer === "k" || answer === "keep" || answer === "") return "keep";
  }
}

async function reviewChanges(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<boolean> {
  const checks = await chooseChecks(dependencies);
  report({ phase: "checking" });
  const review = await dependencies.review(checks);
  if (review.status === "cancelled") {
    dependencies.write("Checks cancelled. The changes stay in the workspace.\n");
    return true;
  }
  dependencies.write(`\nChanges:\n${describeChanges(review.changes)}\nChecks:\n${describeChecks(review.checks)}\n` +
    "The full diff and check output are in the result panel.\n");
  report({ phase: "awaiting_decision" });
  const decision = await askDecision(dependencies);
  if (decision === "keep") {
    dependencies.write("The changes stay in the workspace. Continue with another request.\n");
    return true;
  }
  if (decision === "reject") {
    await dependencies.reject();
    dependencies.write("Changes discarded. Your repository was not touched.\n");
    return true;
  }
  report({ phase: "applying" });
  const applied = await dependencies.apply();
  if (applied.status === "applied") {
    dependencies.write(`Applied to your repository:\n${describeChanges(applied.changes)}\n`);
    return true;
  }
  if (applied.status === "conflict") {
    dependencies.write(`Not applied: ${applied.reason}.\n` +
      (applied.paths.length > 0 ? `${applied.paths.map((path) => `  ${path}`).join("\n")}\n` : "") +
      "Nothing was written. The changes stay in the workspace.\n");
    return true;
  }
  dependencies.write("Application stopped partway. These files may have changed:\n" +
    `${applied.applied.map((path) => `  ${path}`).join("\n") || "  (unknown)"}\n` +
    "Check your repository before continuing. This session is closed.\n");
  return false;
}

/** Surface-independent conversation loop: work, review, then apply or reject. */
export async function runTesotaShell(dependencies: TesotaShellDependencies): Promise<number> {
  const report = dependencies.report ?? ignoreProgress;
  for (;;) {
    const request = (await dependencies.ask("> ")).trim();
    if (request.length === 0) {
      dependencies.write("Session ended.\n");
      return 0;
    }
    dependencies.write("\n");
    report({ phase: "working" });
    const result = await dependencies.work(request);
    if (result.status === "unsettled") {
      dependencies.write("The agent did not stop cleanly. This session is closed; check the workspace before continuing.\n");
      return 1;
    }
    if (result.status === "cancelled") {
      dependencies.write("Stopped. Any changes so far stay in the workspace.\n");
      continue;
    }
    if (result.status === "failed") {
      dependencies.write(`The request failed: ${result.reason}\n`);
      continue;
    }
    if (result.reply.length > 0) dependencies.write(`${result.reply}\n`);
    if (result.changes.length === 0) continue;
    if (!(await reviewChanges(dependencies, report))) return 1;
  }
}
