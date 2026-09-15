import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { admitTaskProposal, type ProposalRunGrant } from "./proposal-admission.js";
import { decideTask, reviewTask, type TaskReview } from "./task-review.js";
import { promoteTask } from "./task-promotion.js";
import { runProposalTask, type TaskRunResult } from "./task-run.js";
import { askTerminalQuestion, type PromptTerminal } from "./terminal-question.js";

export type TaskStartProgress =
  | Readonly<{ phase: "awaiting_approval"; operation: "proposal_scope" }>
  | Readonly<{ phase: "executing"; operation: "candidate_task" }>
  | Readonly<{ phase: "ready_for_review"; operation: "candidate_review" }>
  | Readonly<{ phase: "promoting"; operation: "accepted_candidate" }>;

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
  readonly record?: (file: Awaited<ReturnType<typeof open>>, value: object) => Promise<void>;
  readonly report?: (progress: TaskStartProgress) => void;
}

function approved(answer: string): boolean { return /^(?:y|yes)$/iu.test(answer.trim()); }
function ignoreProgress(_progress: TaskStartProgress): void {}

function proposalCard(grant: ProposalRunGrant): string {
  return `Proposed task\nObjective: ${grant.objective}\nWrite: ${grant.writeFiles.join(", ")}\n` +
    `Read: ${grant.readFiles.join(", ")}\nBaseline: ${grant.baseline}\n` +
    "Automatic evidence: scope integrity. Outcome correctness requires human review.\n";
}

async function append(file: Awaited<ReturnType<typeof open>>, value: object): Promise<void> {
  await file.writeFile(JSON.stringify({ ...value, timestamp: new Date().toISOString() }) + "\n");
  await file.sync();
}

/** One-shot proposal lifecycle. A started proposal cannot be replayed or resumed. */
export async function startTask(dependencies: StartTaskDependencies): Promise<number> {
  const report = dependencies.report ?? ignoreProgress;
  const grant = await admitTaskProposal(dependencies);
  dependencies.write(proposalCard(grant));
  report({ phase: "awaiting_approval", operation: "proposal_scope" });
  if (!approved(await dependencies.ask("Approve this scope and start isolated execution? [y/N] "))) {
    dependencies.write("Proposal not started. Nothing changed.\n");
    return 0;
  }

  const journal = await open(join(resolve(dependencies.proposalsRoot, grant.proposalId), "start.jsonl"), "wx", 0o600);
  const record = dependencies.record ?? append;
  let promotionApplied = false;
  try {
    await record(journal, { format: "tesota-proposal-start", version: 1, state: "started",
      proposalId: grant.proposalId, proposalSha256: grant.proposalSha256, baseline: grant.baseline,
      authority: "local_operator_approval" });
    report({ phase: "executing", operation: "candidate_task" });
    const execution = await (dependencies.execute ?? runProposalTask)(grant);
    await record(journal, { state: "execution_finished", candidate: execution.candidate.directory,
      outcome: execution.status });
    if (execution.status !== "passed") {
      dependencies.write(`Execution did not pass. Candidate retained: ${execution.candidate.directory}\n`);
      await record(journal, { state: "finished", outcome: execution.status === "cancelled" ? "cancelled" : "execution_failed" });
      return execution.status === "cancelled" ? 130 : 1;
    }

    const review = await (dependencies.review ?? reviewTask)(execution.candidate.directory);
    dependencies.write(`\nCandidate review\nCheck: ${review.check.status}\nDiff (escaped JSON):\n${JSON.stringify(review.diff)}\n`);
    report({ phase: "ready_for_review", operation: "candidate_review" });
    const decision = approved(await dependencies.ask("Accept and promote these exact candidate bytes? [y/N] ")) ? "accept" : "reject";
    const decided = await (dependencies.decide ?? decideTask)(review.directory,
      { decision, reviewSha256: review.reviewSha256 });
    if (decision === "reject") {
      dependencies.write("Candidate rejected. Source was not changed.\n");
      await record(journal, { state: "finished", outcome: "rejected", reviewSha256: review.reviewSha256 });
      return 1;
    }
    if (decided.operatorDecision?.applicability !== "current") throw new Error("Decision became stale");
    report({ phase: "promoting", operation: "accepted_candidate" });
    const promotion = await (dependencies.promote ?? promoteTask)(review.directory, grant.source, review.reviewSha256);
    promotionApplied = true;
    try {
      await record(journal, { state: "finished", outcome: "promoted", reviewSha256: review.reviewSha256,
        files: promotion.files });
    } catch {
      dependencies.write("Promotion applied, but proposal start evidence is incomplete. Inspect the candidate promotion journal.\n");
      return 1;
    }
    dependencies.write(`Promoted: ${promotion.files.map((file) => file.path).join(", ")}\n`);
    return 0;
  } catch (error) {
    if (!promotionApplied) await record(journal, { state: "finished", outcome: "failed" }).catch(() => {});
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
    return await startTask({ proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
      sourceDirectory: process.cwd(), reference, ask: askTaskStartQuestion,
      write: (text) => { process.stdout.write(text); }, ...(report === undefined ? {} : { report }) });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    process.stderr.write(cancelled ? "Task start cancelled. No promotion occurred.\n" :
      "Task start unavailable or failed. Inspect retained evidence before retrying.\n");
    return cancelled ? 130 : 2;
  }
}
