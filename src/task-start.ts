import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { admitTaskProposal, type ProposalRunGrant } from "./proposal-admission.js";
import { decideTask, reviewTask, type TaskReview } from "./task-review.js";
import { promoteTask } from "./task-promotion.js";
import { runProposalTask, type TaskRunResult } from "./task-run.js";
import { createTaskOutcome, formatTaskOutcome, type TaskOutcomeJournal } from "./task-outcome.js";
import { askTerminalQuestion, type PromptTerminal } from "./terminal-question.js";

export type TaskStartProgress =
  | Readonly<{ phase: "awaiting_approval"; operation: "proposal_scope" }>
  | Readonly<{ phase: "executing"; operation: "candidate_task" }>
  | Readonly<{ phase: "ready_for_review"; operation: "candidate_review" }>
  | Readonly<{ phase: "promoting"; operation: "accepted_candidate" }>;

export type TaskStartResult =
  | Readonly<{ status: "settled"; exitCode: 0 | 1;
    outcome: "scope_declined" | "execution_failed" | "rejected" | "promoted" }>
  | Readonly<{ status: "cancelled"; exitCode: 130 }>
  | Readonly<{ status: "unsettled"; exitCode: 1; outcome: "promotion_unconfirmed" }>;

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

function proposalCard(grant: ProposalRunGrant): string {
  return `Proposed task\nObjective: ${grant.objective}\nWrite: ${grant.writeFiles.join(", ")}\n` +
    `Read: ${grant.readFiles.join(", ")}\nBaseline: ${grant.baseline}\n` +
    "Automatic evidence: scope integrity and contained TypeScript no-emit. Outcome correctness requires human review.\n";
}

async function finishOutcome(journal: TaskOutcomeJournal,
  event: Parameters<TaskOutcomeJournal["append"]>[0], write: (text: string) => void): Promise<void> {
  await journal.append(event);
  write(formatTaskOutcome(journal.current()));
}

/** One-shot proposal lifecycle. A started proposal cannot be replayed or resumed. */
export async function startTask(dependencies: StartTaskDependencies): Promise<TaskStartResult> {
  const report = dependencies.report ?? ignoreProgress;
  const grant = await admitTaskProposal(dependencies);
  const createOutcome = dependencies.createOutcome ?? createTaskOutcome;
  const journal = await createOutcome(resolve(dependencies.proposalsRoot, grant.proposalId), {
    proposalId: grant.proposalId, proposalSha256: grant.proposalSha256, baseline: grant.baseline,
  });
  let promotionApplied = false;
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
    await journal.append({ state: "execution_finished", candidate: execution.candidate.directory,
      result: { status: execution.status, accounting: execution.accounting } });
    if (execution.status !== "passed") {
      dependencies.write(`Execution did not pass. Candidate retained: ${execution.candidate.directory}\n`);
      await finishOutcome(journal, { state: "finished",
        outcome: execution.status === "cancelled" ? "cancelled" : "execution_failed" }, dependencies.write);
      return execution.status === "cancelled" ? { status: "cancelled", exitCode: 130 } :
        { status: "settled", exitCode: 1, outcome: "execution_failed" };
    }

    const review = await (dependencies.review ?? reviewTask)(execution.candidate.directory);
    await journal.append({ state: "review_ready", reviewSha256: review.reviewSha256, checkStatus: review.check.status });
    dependencies.write(`\nCandidate review\nCheck: ${review.check.status}\nDiff (escaped JSON):\n${JSON.stringify(review.diff)}\n`);
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
    if (decided.operatorDecision?.applicability !== "current") throw new Error("Decision became stale");
    report({ phase: "promoting", operation: "accepted_candidate" });
    await journal.append({ state: "promotion_started", reviewSha256: review.reviewSha256 });
    const promotion = await (dependencies.promote ?? promoteTask)(review.directory, grant.source, review.reviewSha256);
    promotionApplied = true;
    try {
      await finishOutcome(journal, { state: "finished", outcome: "promoted", files: promotion.files }, dependencies.write);
    } catch {
      dependencies.write("Promotion applied, but proposal start evidence is incomplete. Inspect the candidate promotion journal.\n");
      return { status: "unsettled", exitCode: 1, outcome: "promotion_unconfirmed" };
    }
    dependencies.write(`Promoted: ${promotion.files.map((file) => file.path).join(", ")}\n`);
    return { status: "settled", exitCode: 0, outcome: "promoted" };
  } catch (error) {
    if (!promotionApplied) await journal.append({ state: "finished",
      outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed" }).catch(() => {});
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
