import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { admitTaskProposal, type ProposalRunGrant } from "./proposal-admission.js";
import { decideTask, reviewTask, type TaskReview } from "./task-review.js";
import { promoteTask } from "./task-promotion.js";
import { runProposalTask, type TaskRunResult } from "./task-run.js";

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
}

function approved(answer: string): boolean { return /^(?:y|yes)$/iu.test(answer.trim()); }

function proposalCard(grant: ProposalRunGrant): string {
  return `Proposed task\nObjective: ${grant.objective}\nWrite: ${grant.writeFiles.join(", ")}\n` +
    `Read: ${grant.readFiles.join(", ")}\nBaseline: ${grant.baseline}\n` +
    "Automatic evidence: scope integrity only. The repository check will not run in this first slice.\n";
}

async function append(file: Awaited<ReturnType<typeof open>>, value: object): Promise<void> {
  await file.writeFile(JSON.stringify({ ...value, timestamp: new Date().toISOString() }) + "\n");
  await file.sync();
}

/** One-shot proposal lifecycle. A started proposal cannot be replayed or resumed. */
export async function startTask(dependencies: StartTaskDependencies): Promise<number> {
  const grant = await admitTaskProposal(dependencies);
  dependencies.write(proposalCard(grant));
  if (!approved(await dependencies.ask("Approve this scope and start isolated execution? [y/N] "))) {
    dependencies.write("Proposal not started. Nothing changed.\n");
    return 0;
  }

  const journal = await open(join(resolve(dependencies.proposalsRoot, grant.proposalId), "start.jsonl"), "wx", 0o600);
  try {
    await append(journal, { format: "tesota-proposal-start", version: 1, state: "started",
      proposalId: grant.proposalId, proposalSha256: grant.proposalSha256, baseline: grant.baseline,
      authority: "local_operator_approval" });
    const execution = await (dependencies.execute ?? runProposalTask)(grant);
    await append(journal, { state: "execution_finished", candidate: execution.candidate.directory,
      outcome: execution.status });
    if (execution.status !== "passed") {
      dependencies.write(`Execution did not pass. Candidate retained: ${execution.candidate.directory}\n`);
      await append(journal, { state: "finished", outcome: "execution_failed" });
      return 1;
    }

    const review = await (dependencies.review ?? reviewTask)(execution.candidate.directory);
    dependencies.write(`\nCandidate review\nCheck: ${review.check.status}\nDiff (escaped JSON):\n${JSON.stringify(review.diff)}\n`);
    const decision = approved(await dependencies.ask("Accept and promote these exact candidate bytes? [y/N] ")) ? "accept" : "reject";
    const decided = await (dependencies.decide ?? decideTask)(review.directory,
      { decision, reviewSha256: review.reviewSha256 });
    if (decision === "reject") {
      dependencies.write("Candidate rejected. Source was not changed.\n");
      await append(journal, { state: "finished", outcome: "rejected", reviewSha256: review.reviewSha256 });
      return 1;
    }
    if (decided.operatorDecision?.applicability !== "current") throw new Error("Decision became stale");
    const promotion = await (dependencies.promote ?? promoteTask)(review.directory, grant.source, review.reviewSha256);
    dependencies.write(`Promoted: ${promotion.files.map((file) => file.path).join(", ")}\n`);
    await append(journal, { state: "finished", outcome: "promoted", reviewSha256: review.reviewSha256,
      files: promotion.files });
    return 0;
  } catch (error) {
    await append(journal, { state: "finished", outcome: "failed" }).catch(() => {});
    throw error;
  } finally { await journal.close(); }
}

export async function runTaskStartCommand(reference: string): Promise<number> {
  if (process.platform !== "win32" || process.stdin.isTTY !== true || process.stdout.isTTY !== true ||
      process.stderr.isTTY !== true) {
    process.stderr.write("Task start requires an interactive Windows terminal. Nothing changed.\n");
    return 2;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await startTask({ proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
      sourceDirectory: process.cwd(), reference, ask: (prompt) => terminal.question(prompt),
      write: (text) => { process.stdout.write(text); } });
  } catch {
    process.stderr.write("Task start unavailable or failed. No unconfirmed promotion was reported.\n");
    return 2;
  } finally { terminal.close(); }
}
