import { correctionFor, correctionPrompt, MAX_CORRECTION_ROUNDS, problemCount } from "./correction.js";
import type { Finding, ReviewReport } from "./review.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import type { NoticeTone } from "./tesota-shell-transcript.js";
import type { WorkspaceChange } from "./workspace.js";
import { type ApprovedCheck, type CheckResult, parseApprovedCheck } from "./workspace-checks.js";

export type WorkResult =
  | Readonly<{ status: "completed"; changes: readonly WorkspaceChange[] }>
  | Readonly<{ status: "failed"; reason: string }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "unsettled" }>;

export type ReviewResult =
  | Readonly<{ status: "ready"; tree: string; changes: readonly WorkspaceChange[]; checks: readonly CheckResult[];
      reviews: readonly ReviewReport[]; requests: readonly string[] }>
  | Readonly<{ status: "cancelled" }>;

/** The check of a turn that changed no files (decision 034): the main review of its requests, or a stop. */
export type AnswerResult =
  | Readonly<{ status: "assessed"; reviews: readonly ReviewReport[]; requests: readonly string[] }>
  | Readonly<{ status: "cancelled" }>;

export type ApplyResult =
  | Readonly<{ status: "applied"; changes: readonly WorkspaceChange[] }>
  | Readonly<{ status: "conflict"; reason: string; paths: readonly string[] }>
  | Readonly<{ status: "uncertain"; applied: readonly string[] }>;

/** The result a correction round started from, and the findings it sent back. */
export interface CorrectionContext {
  readonly previousTree: string;
  readonly sentBack: readonly Finding[];
}

/** Who wrote a message to the working agent: the operator, or Tesota in a correction round. */
export type RequestOrigin = "operator" | "tesota";

export interface TesotaShellDependencies {
  /**
   * Start preparing the session's environment in the background, as cloud
   * agents do when a task opens, so it is usually ready by the first request.
   */
  readonly prepare?: () => void;
  /** Add a Tesota notice; the agent's own replies reach the surface as they stream. */
  readonly write: (text: string, tone?: NoticeTone) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly report?: (progress: TesotaShellProgress) => void;
  /**
   * Run one request in the workspace, showing the agent's work as it happens,
   * and report the pending changes. Only the operator's own requests join the
   * request record; Tesota's correction messages do not.
   */
  readonly work: (request: string, origin?: RequestOrigin) => Promise<WorkResult>;
  /**
   * Check a turn that changed no files against its requests and the agent's
   * reply, and present it (decision 034); absent where nothing checks answers.
   */
  readonly assessAnswer?: () => Promise<AnswerResult>;
  /** Checks the operator approved earlier, or null when none were chosen yet. */
  readonly checks: () => readonly ApprovedCheck[] | null;
  readonly suggestChecks: () => readonly string[];
  readonly setChecks: (checks: readonly ApprovedCheck[]) => void;
  /**
   * Snapshot the pending changes, run the approved checks on them and present
   * the review, once. After a correction round, `correction` names the result
   * sent back and what was sent, so only the correction is reviewed and the
   * sent-back findings are validated (decision 016).
   */
  readonly review: (checks: readonly ApprovedCheck[], correction?: CorrectionContext) => Promise<ReviewResult>;
  readonly apply: () => Promise<ApplyResult>;
  readonly reject: () => Promise<void>;
}

function ignoreProgress(_progress: TesotaShellProgress): void {}

const changeVerbs: Readonly<Record<WorkspaceChange["status"], string>> = { added: "add", modified: "edit", deleted: "delete" };

function describeChanges(changes: readonly WorkspaceChange[]): string {
  return changes.map((change) => `  ${changeVerbs[change.status]} ${change.path}`).join("\n");
}

/** The checks an answer names, or the reason one of them cannot be used. */
function parseChecks(answer: string): readonly ApprovedCheck[] | string {
  const checks: ApprovedCheck[] = [];
  for (const text of answer.split(";").filter((part) => part.trim().length > 0)) {
    const check = parseApprovedCheck(text);
    if (typeof check === "string") return check;
    checks.push(check);
  }
  return checks;
}

async function chooseChecks(dependencies: TesotaShellDependencies): Promise<readonly ApprovedCheck[]> {
  const existing = dependencies.checks();
  if (existing !== null) return existing;
  const suggested = dependencies.suggestChecks();
  dependencies.write(suggested.length === 0
    ? "No checks were found for this repository.\n"
    : `Suggested checks:\n${suggested.map((command) => `  ${command}`).join("\n")}\n`);
  dependencies.write("To compare failures test by test with the repository as it was, follow a command with " +
    "=> and the JUnit XML reports it writes, in paths Git ignores: bun run test => reports/unit.xml, reports/e2e.xml\n");
  for (;;) {
    const answer = (await dependencies.ask(suggested.length === 0
      ? "Commands to run after each change (separate with ;), or Enter for none: "
      : "Enter to use these, type other commands (separate with ;), or 'none': ")).trim();
    const chosen = answer.length === 0 ? suggested.map((command) => ({ command, reports: [] }))
      : answer.toLowerCase() === "none" ? [] : parseChecks(answer);
    if (typeof chosen === "string") { dependencies.write(`${chosen}\n`, "warning"); continue; }
    dependencies.setChecks(chosen);
    return chosen;
  }
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

type Assessment = "ready" | "stopped" | "unsettled";

/**
 * Check and review the candidate; send failed checks and fixable findings back
 * to the agent for at most MAX_CORRECTION_ROUNDS rounds, stopping early when a
 * round changes nothing (decision 015).
 */
async function assess(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<Assessment> {
  const checks = await chooseChecks(dependencies);
  let previousTree: string | undefined;
  let context: CorrectionContext | undefined;
  for (let round = 0; ; round++) {
    report({ phase: "checking" });
    const review = context === undefined ? await dependencies.review(checks) : await dependencies.review(checks, context);
    if (review.status === "cancelled") {
      dependencies.write("Checks cancelled. The changes stay in the workspace.\n");
      return "stopped";
    }
    const correction = correctionFor(review.checks, review.reviews);
    if (correction === undefined || round >= MAX_CORRECTION_ROUNDS) return "ready";
    if (review.tree === previousTree) {
      dependencies.write("The agent's correction changed nothing; the remaining problems are yours to judge.\n", "warning");
      return "ready";
    }
    previousTree = review.tree;
    context = { previousTree: review.tree, sentBack: correction.findings };
    const count = problemCount(correction);
    dependencies.write(`Sending ${count} ${count === 1 ? "item" : "items"} back to the agent to fix ` +
      `(attempt ${round + 1} of ${MAX_CORRECTION_ROUNDS}).\n`);
    report({ phase: "working" });
    const result = await dependencies.work(correctionPrompt(review.requests, correction), "tesota");
    if (result.status === "unsettled") return "unsettled";
    if (result.status !== "completed") {
      dependencies.write(`The agent's fix ${result.status === "cancelled" ? "was stopped" : `failed: ${result.reason}`}. ` +
        "The changes stay in the workspace; continue with another request.\n", "warning");
      return "stopped";
    }
  }
}

async function reviewChanges(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<boolean> {
  const assessment = await assess(dependencies, report);
  if (assessment === "unsettled") {
    dependencies.write("The agent did not stop cleanly. This session is closed; check the workspace before continuing.\n", "warning");
    return false;
  }
  if (assessment === "stopped") return true;
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
    dependencies.write(`Applied to your repository:\n${describeChanges(applied.changes)}\n`, "success");
    return true;
  }
  if (applied.status === "conflict") {
    dependencies.write(`Not applied: ${applied.reason}.\n` +
      (applied.paths.length > 0 ? `${applied.paths.map((path) => `  ${path}`).join("\n")}\n` : "") +
      "Nothing was written. The changes stay in the workspace.\n", "warning");
    return true;
  }
  dependencies.write("Application stopped partway. These files may have changed:\n" +
    `${applied.applied.map((path) => `  ${path}`).join("\n") || "  (unknown)"}\n` +
    "Check your repository before continuing. This session is closed.\n", "warning");
  return false;
}

/**
 * After a turn that changed no files, check its requests against the
 * repository and the agent's reply (decision 034). Confirmed gaps go back to
 * the agent for at most MAX_CORRECTION_ROUNDS rounds; a correction that writes
 * files leaves them for the normal review. Nothing is ever applied from here.
 */
async function checkAnswer(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<"done" | "changed" | "unsettled"> {
  if (dependencies.assessAnswer === undefined) return "done";
  for (let round = 0; ; round++) {
    report({ phase: "reviewing" });
    const assessment = await dependencies.assessAnswer();
    if (assessment.status === "cancelled") return "done";
    const correction = correctionFor([], assessment.reviews);
    if (correction === undefined || round >= MAX_CORRECTION_ROUNDS) return "done";
    const count = problemCount(correction);
    dependencies.write(`Sending ${count} ${count === 1 ? "item" : "items"} back to the agent to fix ` +
      `(attempt ${round + 1} of ${MAX_CORRECTION_ROUNDS}).\n`);
    report({ phase: "working" });
    const result = await dependencies.work(correctionPrompt(assessment.requests, correction), "tesota");
    if (result.status === "unsettled") return "unsettled";
    if (result.status !== "completed") {
      dependencies.write(`The agent's fix ${result.status === "cancelled" ? "was stopped" : `failed: ${result.reason}`}. ` +
        "Continue with another request.\n", "warning");
      return "done";
    }
    if (result.changes.length > 0) return "changed";
  }
}

/** Surface-independent conversation loop: work, review, then apply or reject. */
export async function runTesotaShell(dependencies: TesotaShellDependencies): Promise<number> {
  const report = dependencies.report ?? ignoreProgress;
  dependencies.prepare?.();
  for (;;) {
    const request = (await dependencies.ask("> ")).trim();
    if (request.length === 0) {
      dependencies.write("Session ended.\n");
      return 0;
    }
    report({ phase: "working" });
    const result = await dependencies.work(request);
    if (result.status === "unsettled") {
      dependencies.write("The agent did not stop cleanly. This session is closed; check the workspace before continuing.\n", "warning");
      return 1;
    }
    if (result.status === "cancelled") {
      dependencies.write("Stopped. Any changes so far stay in the workspace.\n");
      continue;
    }
    if (result.status === "failed") {
      dependencies.write(`The request failed: ${result.reason}\n`, "warning");
      continue;
    }
    if (result.changes.length === 0) {
      const answer = await checkAnswer(dependencies, report);
      if (answer === "unsettled") {
        dependencies.write("The agent did not stop cleanly. This session is closed; check the workspace before continuing.\n", "warning");
        return 1;
      }
      if (answer === "done") continue;
    }
    if (!(await reviewChanges(dependencies, report))) return 1;
  }
}
