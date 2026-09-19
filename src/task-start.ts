import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { admitTaskProposal, type ProposalRunGrant } from "./proposal-admission.js";
import { decideTask, reviewTask, type TaskReview } from "./task-review.js";
import { promoteTask, PromotionNotAppliedError } from "./task-promotion.js";
import { runProposalTask, type TaskRunResult } from "./task-run.js";
import { createTaskOutcome, formatTaskOutcome, type TaskOutcomeJournal } from "./task-outcome.js";
import { askTerminalQuestion, type PromptTerminal } from "./terminal-question.js";

export type TaskStartProgress =
  | Readonly<{ phase: "awaiting_approval"; operation: "proposal_scope" }>
  | Readonly<{ phase: "executing"; operation: "candidate_task" }>
  | Readonly<{ phase: "ready_for_review"; operation: "candidate_review" }>
  | Readonly<{ phase: "promoting"; operation: "accepted_candidate" }>;

export type TaskStartResult =
  | Readonly<{ status: "settled"; exitCode: 0 | 1 | 130;
    outcome: "scope_declined" | "execution_failed" | "cancelled" | "rejected" | "promotion_not_applied" | "promoted" }>
  | Readonly<{ status: "unsettled"; exitCode: 1; outcome: "execution_unconfirmed" | "promotion_unconfirmed" }>;

interface StartTaskDependencies {
  readonly proposalsRoot: string;
  readonly sourceDirectory: string;
  readonly reference: string;
  readonly ask: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
  readonly execute?: (grant: ProposalRunGrant) => Promise<TaskRunResult>;
  readonly review?: (directory: string) => Promise<TaskReview>;
  readonly decide?: typeof decideTask;
  readonly promote?: typeof promoteTask;
  readonly createOutcome?: typeof createTaskOutcome;
  readonly report?: (progress: TaskStartProgress) => void;
}

function approved(answer: string): boolean { return /^(?:y|yes)$/iu.test(answer.trim()); }
function ignoreProgress(_progress: TaskStartProgress): void {}
function aborted(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }

function proposalCard(grant: ProposalRunGrant): string {
  return `Proposed task\nObjective: ${grant.objective}\nWrite: ${grant.writeFiles.join(", ")}\n` +
    `Read: ${grant.readFiles.join(", ")}\nBaseline: ${grant.baseline}\n` +
    "Automatic evidence: scope integrity and contained TypeScript no-emit. Outcome correctness requires human review.\n";
}

function formatTaskReview(review: TaskReview): string {
  const typecheck = review.check.typecheck;
  if (review.changedFiles.length === 0 || review.check.status !== "passed" || typecheck?.status !== "passed") {
    throw new Error("Candidate review evidence unavailable");
  }
  return "\nCandidate review\n\n" +
    `Changed:\n${review.changedFiles.map((path) => `- ${path}`).join("\n")}\n\n` +
    "Checked:\n" +
    "PASS Scope integrity: only admitted files changed\n" +
    `PASS TypeScript no-emit: this exact result passed ${typecheck.profile}\n\n` +
    "Not established:\n" +
    "- requested behavior and completion conditions\n" +
    "- full integration suite\n\n" +
    "Changed since checking: No\n" +
    "Application: Not applied; awaiting your decision\n\n" +
    `Diff (escaped JSON):\n${JSON.stringify(review.diff)}\n`;
}

async function finishOutcome(journal: TaskOutcomeJournal,
  event: Parameters<TaskOutcomeJournal["append"]>[0], write: (text: string) => void): Promise<void> {
  await journal.append(event);
  write(formatTaskOutcome(journal.current()));
}

async function completedExecution(execution: TaskRunResult, journal: TaskOutcomeJournal,
  write: (text: string) => void): Promise<TaskStartResult | null> {
  if (execution.status === "unsettled") {
    write("Execution settlement is unconfirmed. Inspect retained evidence before retrying.\n");
    write(formatTaskOutcome(journal.current()));
    return { status: "unsettled", exitCode: 1, outcome: "execution_unconfirmed" };
  }
  await journal.append({ state: "execution_finished", candidate: execution.candidate.directory,
    result: { status: execution.status, accounting: execution.accounting } });
  if (execution.status === "passed") return null;
  write(`Execution did not pass. Candidate retained: ${execution.candidate.directory}\n`);
  const outcome = execution.status === "cancelled" ? "cancelled" : "execution_failed";
  await finishOutcome(journal, { state: "finished", outcome }, write);
  return outcome === "cancelled" ? { status: "settled", exitCode: 130, outcome } :
    { status: "settled", exitCode: 1, outcome };
}

async function promoteAcceptedTask(review: TaskReview, decided: TaskReview, source: string, journal: TaskOutcomeJournal,
  report: (progress: TaskStartProgress) => void, promote: typeof promoteTask, write: (text: string) => void): Promise<TaskStartResult> {
  if (decided.operatorDecision?.applicability !== "current") throw new Error("Decision became stale");
  report({ phase: "promoting", operation: "accepted_candidate" });
  await journal.append({ state: "promotion_started", reviewSha256: review.reviewSha256 });
  try {
    const promotion = await promote(review.directory, source, review.reviewSha256);
    try {
      await finishOutcome(journal, { state: "finished", outcome: "promoted", files: promotion.files }, write);
    } catch {
      write("Promotion applied, but proposal start evidence is incomplete. Inspect the candidate promotion journal.\n");
      return { status: "unsettled", exitCode: 1, outcome: "promotion_unconfirmed" };
    }
    write(`Promoted: ${promotion.files.map((file) => file.path).join(", ")}\n`);
    return { status: "settled", exitCode: 0, outcome: "promoted" };
  } catch (error) {
    if (error instanceof PromotionNotAppliedError) {
      try {
        await finishOutcome(journal, { state: "finished", outcome: "promotion_not_applied" }, write);
      } catch {
        write("Promotion was not applied, but proposal start evidence is incomplete. Inspect the candidate promotion journal.\n");
        return { status: "unsettled", exitCode: 1, outcome: "promotion_unconfirmed" };
      }
      write("Promotion was not applied. Source was not changed.\n");
      return { status: "settled", exitCode: 1, outcome: "promotion_not_applied" };
    }
    write("Promotion settlement is unconfirmed. Inspect retained evidence before retrying.\n");
    return { status: "unsettled", exitCode: 1, outcome: "promotion_unconfirmed" };
  }
}

/** One-shot proposal lifecycle. A started proposal cannot be replayed or resumed. */
export async function startTask(dependencies: StartTaskDependencies): Promise<TaskStartResult> {
  const report = dependencies.report ?? ignoreProgress;
  const grant = await admitTaskProposal(dependencies);
  const createOutcome = dependencies.createOutcome ?? createTaskOutcome;
  const journal = await createOutcome(resolve(dependencies.proposalsRoot, grant.proposalId), {
    proposalId: grant.proposalId, proposalSha256: grant.proposalSha256, baseline: grant.baseline,
  });
  try {
    dependencies.write(proposalCard(grant));
    report({ phase: "awaiting_approval", operation: "proposal_scope" });
    if (!approved(await dependencies.ask("Approve this scope and start isolated execution? [y/N] "))) {
      dependencies.write("Proposal not started. Nothing changed.\n");
      await finishOutcome(journal, { state: "scope_declined" }, dependencies.write);
      return { status: "settled", exitCode: 0, outcome: "scope_declined" };
    }
    await journal.append({ state: "execution_started" });
    report({ phase: "executing", operation: "candidate_task" });
    const execution = await (dependencies.execute ?? runProposalTask)(grant);
    const executionResult = await completedExecution(execution, journal, dependencies.write);
    if (executionResult !== null) return executionResult;

    const review = await (dependencies.review ?? reviewTask)(execution.candidate.directory);
    await journal.append({ state: "review_ready", reviewSha256: review.reviewSha256, checkStatus: review.check.status });
    dependencies.write(formatTaskReview(review));
    report({ phase: "ready_for_review", operation: "candidate_review" });
    const decision = approved(await dependencies.ask("Accept and promote these exact candidate bytes? [y/N] ")) ? "accept" : "reject";
    const decided = await (dependencies.decide ?? decideTask)(review.directory,
      { decision, reviewSha256: review.reviewSha256 });
    await journal.append({ state: "decision_recorded", decision, reviewSha256: review.reviewSha256 });
    if (decision === "reject") {
      dependencies.write("Candidate rejected. Source was not changed.\n");
      await finishOutcome(journal, { state: "finished", outcome: "rejected" }, dependencies.write);
      return { status: "settled", exitCode: 1, outcome: "rejected" };
    }
    return await promoteAcceptedTask(review, decided, grant.source, journal, report, dependencies.promote ?? promoteTask, dependencies.write);
  } catch (error) {
    if (aborted(error)) {
      await finishOutcome(journal, { state: "finished", outcome: "cancelled" }, dependencies.write);
      return { status: "settled", exitCode: 130, outcome: "cancelled" };
    }
    await journal.append({ state: "finished", outcome: "failed" }).catch(() => {});
    throw error;
  } finally { await journal.close(); }
}

export async function askTaskStartQuestion(prompt: string,
  createTerminal: () => PromptTerminal = () => createInterface({ input: process.stdin, output: process.stdout, terminal: true })):
Promise<string> {
  return askTerminalQuestion(createTerminal(), prompt);
}

export async function runTaskStartCommand(reference: string,
  report?: (progress: TaskStartProgress) => void): Promise<number> {
  if (process.platform !== "win32" || process.stdin.isTTY !== true || process.stdout.isTTY !== true ||
      process.stderr.isTTY !== true) {
    process.stderr.write("Task start requires an interactive Windows terminal. Nothing changed.\n");
    return 2;
  }
  try {
    const result = await startTask({ proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
      sourceDirectory: process.cwd(), reference, ask: askTaskStartQuestion,
      write: (text) => { process.stdout.write(text); }, ...(report === undefined ? {} : { report }) });
    return result.exitCode;
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    process.stderr.write(cancelled ? "Task start cancelled. No promotion occurred.\n" :
      "Task start unavailable or failed. Inspect retained evidence before retrying.\n");
    return cancelled ? 130 : 2;
  }
}
