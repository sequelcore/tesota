import { correctionFor, correctionPrompt, MAX_CORRECTION_ROUNDS, problemCount } from "./correction.js";
import type { Finding, ReviewReport } from "./review.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import type { NoticeTone } from "./tesota-shell-transcript.js";
import type { WorkspaceChange } from "./workspace.js";
import type { ApplicationPathState } from "./workspace-apply.js";
import type { SessionDecisions } from "./session-decisions.js";
import type { ApprovedCheck, CheckResult } from "./workspace-checks.js";

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

/** How bringing the repository's newer changes into the workspace ended. */
export type RefreshResult = "updated" | "current" | "conflict" | "failed";

export type ApplyResult =
  /** `alsoChanged` names source files outside the result that changed while it was applied. */
  | Readonly<{ status: "applied"; changes: readonly WorkspaceChange[]; alsoChanged?: readonly string[] }>
  /**
   * Nothing was written, or everything written was undone (`rolledBack`); `sourceChanged` when only the repository's
   * newer changes stood in the way (decision 042's refresh), which bringing them in and checking again can settle.
   */
  | Readonly<{ status: "conflict"; reason: string; paths: readonly string[]; rolledBack?: boolean; sourceChanged?: true }>
  /** A partial effect remains (decision 042); `tesota recover` undoes or finishes application `id`. */
  | Readonly<{ status: "recovery_required"; id: string; paths: readonly ApplicationPathState[] }>;

/** Where a session works: in the operator's own files, or in an isolated workspace it applies from. */
export type WorkPlace = "source" | "workspace";

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
  /** Every point where the session waits for someone, answered at the prompt or by a stated policy. */
  readonly decisions: SessionDecisions;
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
  /** Files hidden from the agent and its checks, relative with forward slashes; none when absent. */
  readonly hiddenFiles?: () => Promise<readonly string[]>;
  /** Let the repository's checks read these hidden files, which they need. */
  readonly allowForChecks?: (paths: readonly string[]) => void;
  /**
   * Snapshot the pending changes, run the approved checks on them and present
   * the review, once. After a correction round, `correction` names the result
   * sent back and what was sent, so only the correction is reviewed and the
   * sent-back findings are validated (decision 016).
   */
  readonly review: (checks: readonly ApprovedCheck[], correction?: CorrectionContext) => Promise<ReviewResult>;
  readonly apply: () => Promise<ApplyResult>;
  /**
   * Bring the repository's newer changes into the workspace, without an agent turn, so the result can be checked
   * again; the agent hears of them with its next request. Absent where nothing can be brought in.
   */
  readonly refresh?: () => Promise<RefreshResult>;
  readonly reject: () => Promise<void>;
  /** Where the session works; an isolated workspace when absent. Known once its first request starts. */
  readonly place?: () => WorkPlace;
}

function ignoreProgress(_progress: TesotaShellProgress): void {}

const changeVerbs: Readonly<Record<WorkspaceChange["status"], string>> = { added: "add", modified: "edit", deleted: "delete" };

function describeChanges(changes: readonly WorkspaceChange[]): string {
  return changes.map((change) => `  ${changeVerbs[change.status]} ${change.path}`).join("\n");
}

async function chooseChecks(dependencies: TesotaShellDependencies): Promise<readonly ApprovedCheck[]> {
  const existing = dependencies.checks();
  if (existing !== null) return existing;
  const chosen = await dependencies.decisions.checks(dependencies.suggestChecks());
  dependencies.setChecks(chosen);
  if (chosen.length > 0) await allowHiddenForChecks(dependencies);
  return chosen;
}

/**
 * Hidden files stay hidden from checks too, unless the operator lets the
 * repository's checks read the ones they need, asked once with the checks.
 */
async function allowHiddenForChecks(dependencies: TesotaShellDependencies): Promise<void> {
  const hidden = await dependencies.hiddenFiles?.() ?? [];
  if (hidden.length === 0 || dependencies.allowForChecks === undefined) return;
  const allowed = await dependencies.decisions.checkSecrets(hidden);
  if (allowed.length > 0) dependencies.allowForChecks(allowed);
}

type Assessment = "ready" | "stopped" | "unsettled";

/**
 * A request the operator already typed goes before a correction round: nine
 * in ten visible resolutions of coding agents' mistakes are the developer's
 * own correction (Tang et al., 2026), so the queued message may be the fix.
 * True when one waits, after saying where the unsent items stay.
 */
function queuedFirst(dependencies: TesotaShellDependencies, count: number): boolean {
  if (!dependencies.decisions.queued()) return false;
  dependencies.write(`Your next message goes first. ${count === 1 ? "The item for the agent to fix was not sent; it stays"
    : `The ${count} items for the agent to fix were not sent; they stay`} in the review.\n`, "warning");
  return true;
}

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
      dependencies.write(`Checks cancelled. The changes stay ${placeOf(dependencies)}.\n`);
      return "stopped";
    }
    const correction = correctionFor(review.checks, review.reviews);
    if (correction === undefined || round >= MAX_CORRECTION_ROUNDS) return "ready";
    if (queuedFirst(dependencies, problemCount(correction))) return "ready";
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
        `The changes stay ${placeOf(dependencies)}; continue with another request.\n`, "warning");
      return "stopped";
    }
  }
}

/** Where the session's changes are, as the operator reads it. */
function placeOf(dependencies: TesotaShellDependencies): string {
  return dependencies.place?.() === "source" ? "in your files" : "in the workspace";
}

async function reviewChanges(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<boolean> {
  for (;;) {
    const outcome = await reviewAndDecide(dependencies, report);
    if (outcome !== "refreshed") return outcome;
  }
}

/**
 * Bring the repository's newer changes in and check again, when the operator chooses to, after an application refused
 * only because the repository changed since the check (decision 042's refresh); true when the result is checked again.
 */
async function refreshAndRecheck(dependencies: TesotaShellDependencies, paths: readonly string[],
  report: (progress: TesotaShellProgress) => void): Promise<boolean> {
  if (dependencies.refresh === undefined || !await dependencies.decisions.refresh(paths)) return false;
  report({ phase: "preparing", activity: "Bringing in your repository's changes" });
  const refreshed = await dependencies.refresh();
  if (refreshed === "updated" || refreshed === "current") return true;
  dependencies.write(refreshed === "conflict"
    ? "Your newer changes touch files this result also changes, so they were not brought in. The changes stay in the " +
      "workspace; reject them, or continue with a request.\n"
    : "Your newer changes could not be brought in. The changes stay in the workspace; continue with a request.\n", "warning");
  return false;
}

async function reviewAndDecide(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<boolean | "refreshed"> {
  const assessment = await assess(dependencies, report);
  if (assessment === "unsettled") {
    dependencies.write(`The agent did not stop cleanly. This session is closed; check ${dependencies.place?.() === "source"
      ? "your files" : "the workspace"} before continuing.\n`, "warning");
    return false;
  }
  if (assessment === "stopped") return true;
  // In the source the turn is already in the operator's files; it stays undecided until they keep or revert it,
  // with a command at any time, as Claude Code's /rewind and OpenCode's /undo work, never a prompt that holds the session.
  if (dependencies.place?.() === "source") {
    dependencies.write("This turn stays in your files, undecided: /keep keeps it, /revert undoes it, and a new request " +
      "continues on top of it.\n");
    return true;
  }
  // A message typed while the work ran continues it, as "keep working" does.
  const queued = dependencies.decisions.queued();
  if (!queued) report({ phase: "awaiting_decision" });
  const decision = queued ? "keep" : await dependencies.decisions.result();
  if (decision === "keep") {
    dependencies.write("The changes stay in the workspace. Continue with another request.\n");
    return true;
  }
  if (decision === "reject") {
    await dependencies.reject();
    dependencies.write("Changes discarded. Your repository was not touched.\n");
    return true;
  }
  return applyResult(dependencies, report);
}

/** Apply a reviewed result and say what happened; "refreshed" when the repository's newer changes were brought in to check again. */
async function applyResult(dependencies: TesotaShellDependencies,
  report: (progress: TesotaShellProgress) => void): Promise<boolean | "refreshed"> {
  report({ phase: "applying" });
  const applied = await dependencies.apply();
  if (applied.status === "applied") {
    dependencies.write(`Applied to your repository:\n${describeChanges(applied.changes)}\n`, "success");
    const others = applied.alsoChanged ?? [];
    if (others.length > 0) {
      dependencies.write("These files in your repository also changed while it was applied; the next request " +
        `brings them in:\n${others.map((path) => `  ${path}`).join("\n")}\n`, "warning");
    }
    return true;
  }
  if (applied.status === "conflict" && applied.sourceChanged === true) {
    dependencies.write(`Not applied: ${applied.reason}.\n` +
      (applied.paths.length > 0 ? `${applied.paths.map((path) => `  ${path}`).join("\n")}\n` : "") + "Nothing was written.\n",
    "warning");
    if (await refreshAndRecheck(dependencies, applied.paths, report)) return "refreshed";
    dependencies.write("The changes stay in the workspace.\n");
    return true;
  }
  if (applied.status === "conflict") {
    dependencies.write(`Not applied: ${applied.reason}.\n` +
      (applied.paths.length > 0 ? `${applied.paths.map((path) => `  ${path}`).join("\n")}\n` : "") +
      `${applied.rolledBack === true ? "Your repository holds its original files again." : "Nothing was written."} ` +
      "The changes stay in the workspace.\n", "warning");
    return true;
  }
  const states = { original: "original", applied: "applied", changed: "changed by someone else, not touched",
    unknown: "not known" } as const;
  dependencies.write("Recovery required: application stopped partway and could not be undone.\n" +
    `${applied.paths.map((path) => `  ${path.path}: ${states[path.state]}`).join("\n")}\n` +
    "Tesota kept a copy of every original. Run tesota recover in this repository to undo or finish it. " +
    "This session is closed.\n", "warning");
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
    if (queuedFirst(dependencies, problemCount(correction))) return "done";
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
    const request = (await dependencies.decisions.nextRequest()).trim();
    if (request.length === 0) {
      dependencies.write("Session ended.\n");
      return 0;
    }
    report({ phase: "working" });
    const result = await dependencies.work(request);
    if (result.status === "unsettled") {
      dependencies.write(`The agent did not stop cleanly. This session is closed; check the changes ${placeOf(dependencies)} ` +
        "before continuing.\n", "warning");
      return 1;
    }
    if (result.status === "cancelled") {
      dependencies.write(`Stopped. Any changes so far stay ${placeOf(dependencies)}.\n`);
      continue;
    }
    if (result.status === "failed") {
      dependencies.write(`The request failed: ${result.reason}\n`, "warning");
      continue;
    }
    if (result.changes.length === 0) {
      const answer = await checkAnswer(dependencies, report);
      if (answer === "unsettled") {
        dependencies.write(`The agent did not stop cleanly. This session is closed; check the changes ${placeOf(dependencies)} ` +
          "before continuing.\n", "warning");
        return 1;
      }
      if (answer === "done") continue;
    }
    if (!(await reviewChanges(dependencies, report))) return 1;
  }
}
