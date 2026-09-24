import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { admitTaskProposal, validateProposalRunGrant, type ProposalRunGrant } from "./proposal-admission.js";
import { decideTask, reviewTask, TaskReviewUnsettledError, type TaskReview } from "./task-review.js";
import { promoteTask, PromotionNotAppliedError } from "./task-promotion.js";
import { runProposalTask, type TaskRunResult } from "./task-run.js";
import { parseSemanticRefinement } from "./semantic-revision.js";
import { createTaskOutcome, formatTaskOutcome, type TaskOutcomeJournal } from "./task-outcome.js";
import { SOURCE_TEST_TASK_KIND } from "./task-contract.js";
import { inspectRepositoryTypecheckEligibility, type RepositoryCheckEligibility } from "./repository-typecheck.js";
import { inspectRepositoryNodeTestEligibility } from "./repository-node-test.js";
import { askTerminalQuestion, type PromptTerminal } from "./terminal-question.js";

export type TaskStartProgress =
  | Readonly<{ phase: "awaiting_approval"; operation: "proposal_scope" }>
  | Readonly<{ phase: "awaiting_approval"; operation: "semantic_correction" }>
  | Readonly<{ phase: "executing"; operation: "candidate_task" }>
  | Readonly<{ phase: "executing"; operation: "semantic_revision" }>
  | Readonly<{ phase: "ready_for_review"; operation: "candidate_review" }>
  | Readonly<{ phase: "promoting"; operation: "accepted_candidate" }>;

export type TaskStartResult =
  | Readonly<{ status: "settled"; exitCode: 0 | 1 | 130;
    outcome: "scope_declined" | "execution_failed" | "cancelled" | "rejected" | "promotion_not_applied" | "promoted" |
      "failed" }>
  | Readonly<{ status: "unsettled"; exitCode: 1; outcome: "execution_unconfirmed" | "promotion_unconfirmed" }>;

interface StartTaskDependencies {
  readonly proposalsRoot: string;
  readonly sourceDirectory: string;
  readonly reference: string;
  readonly executionEnvironment?: "docker-contained" | "host-local";
  readonly ask: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
  readonly execute?: (grant: ProposalRunGrant) => Promise<TaskRunResult>;
  readonly review?: typeof reviewTask;
  readonly decide?: typeof decideTask;
  readonly promote?: typeof promoteTask;
  readonly createOutcome?: typeof createTaskOutcome;
  readonly report?: (progress: TaskStartProgress) => void;
  readonly inspectEligibility?: (grant: ProposalRunGrant,
    profile?: "node-test-targeted/v1" | "typescript-no-emit/v1") => Promise<RepositoryCheckEligibility>;
  readonly onReview?: (review: TaskReview) => void;
}

interface HostWorkMeter {
  checks: number;
}

function createHostWorkMeter(): HostWorkMeter {
  return { checks: 0 };
}

function executionHostChecks(execution: TaskRunResult): number {
  return execution.accounting.resources?.hostChecks ?? 0;
}

function approved(answer: string): boolean { return /^(?:y|yes)$/iu.test(answer.trim()); }
function correctionRequested(answer: string): boolean { return /^(?:c|correct|correction)$/iu.test(answer.trim()); }
function acceptanceRequested(answer: string): boolean { return /^(?:a|accept|y|yes)$/iu.test(answer.trim()); }
function ignoreProgress(_progress: TaskStartProgress): void {}
function aborted(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }

function proposalCard(grant: ProposalRunGrant, eligibility: RepositoryCheckEligibility): string {
  const local = grant.executionEnvironment === "host-local";
  const evidence = grant.kind === SOURCE_TEST_TASK_KIND ?
    `scope integrity and ${local ? "host-local" : "contained"} Node test ${grant.selectedTest}` +
      (grant.verification.typecheck === null ? "; TypeScript check choice follows" :
        `; ${local ? "host-local" : "contained"} TypeScript no-emit`) :
    `scope integrity and ${local ? "host-local" : "contained"} TypeScript no-emit`;
  return `Proposed task\nObjective: ${grant.objective}\nWrite: ${grant.writeFiles.join(", ")}\n` +
    `Read: ${grant.readFiles.join(", ")}\nBaseline: ${grant.baseline}\n` +
    (local ? "Environment: trusted local process. Checks can access host files, network and credentials; no sandbox is enforced. Child processes are not tracked after the main process exits.\n" :
      "Environment: protected Docker container.\n") +
    `Automatic evidence: ${evidence}. Outcome correctness requires human review.\n` +
    `Check eligibility (${grant.kind === SOURCE_TEST_TASK_KIND ? grant.verification.nodeTest : grant.verification.typecheck}): ` +
    `${eligibility.status} — ${eligibility.reason}. Preview only; execution rechecks current inputs.\n`;
}

function inspectSelectedCheck(grant: ProposalRunGrant,
  profile?: "node-test-targeted/v1" | "typescript-no-emit/v1"): Promise<RepositoryCheckEligibility> {
  return grant.kind === SOURCE_TEST_TASK_KIND && profile !== "typescript-no-emit/v1"
    ? inspectRepositoryNodeTestEligibility(grant.source, grant.selectedTest, grant.executionEnvironment) :
    inspectRepositoryTypecheckEligibility(grant.source, grant.executionEnvironment);
}

type SelectedChecks = Readonly<{ grant: ProposalRunGrant; fingerprints: Readonly<Record<string, string>> }>;

async function selectEligibleChecks(dependencies: StartTaskDependencies,
  initial: ProposalRunGrant): Promise<SelectedChecks | null> {
  const inspect = dependencies.inspectEligibility ?? inspectSelectedCheck;
  const primary = await inspect(initial, initial.kind === SOURCE_TEST_TASK_KIND ?
    "node-test-targeted/v1" : "typescript-no-emit/v1");
  dependencies.write(proposalCard(initial, primary));
  if (primary.status === "ineligible") {
    dependencies.write("This check cannot run with the inspected inputs. No approval was requested.\n");
    throw new Error("Selected repository check is ineligible");
  }
  if (primary.fingerprint === undefined) throw new Error("Check identity unavailable before approval");
  if (initial.kind !== SOURCE_TEST_TASK_KIND) return { grant: initial,
    fingerprints: { "typescript-no-emit/v1": primary.fingerprint } };
  const typecheck = await inspect(initial, "typescript-no-emit/v1");
  dependencies.write(`Additional check (typescript-no-emit/v1): ${typecheck.status} — ${typecheck.reason}.\n`);
  const choice = (await dependencies.ask(typecheck.status === "eligible"
    ? "Select required checks: [1] Node regression test, [2] Node test + TypeScript typecheck, [c] cancel: "
    : "Select required checks: [1] Node regression test, [c] cancel: ")).trim().toLowerCase();
  if (choice === "c" || choice === "") return null;
  if (choice !== "1" && !(choice === "2" && typecheck.status === "eligible")) {
    throw new Error("Check selection cancelled or unavailable");
  }
  const selected = choice === "2" ? await admitTaskProposal({ ...dependencies,
    executionEnvironment: initial.executionEnvironment, includeTypecheck: true }) : initial;
  if (selected.proposalSha256 !== initial.proposalSha256 || selected.proposalId !== initial.proposalId) {
    throw new Error("Proposal changed before check selection completed");
  }
  dependencies.write(`Selected required checks: ${selected.declaredChecks.join(", ")}.\n`);
  if (choice === "2" && typecheck.fingerprint === undefined) throw new Error("Check identity unavailable before approval");
  return { grant: selected, fingerprints: {
    "node-test-targeted/v1": primary.fingerprint,
    ...(choice === "2" ? { "typescript-no-emit/v1": typecheck.fingerprint } : {}),
  } };
}

async function revalidateSelectedChecks(dependencies: StartTaskDependencies,
  selected: SelectedChecks): Promise<ProposalRunGrant> {
  const { grant } = selected;
  const recheck = dependencies.inspectEligibility ?? inspectSelectedCheck;
  const required = grant.kind === SOURCE_TEST_TASK_KIND ?
    (grant.verification.typecheck === null ? ["node-test-targeted/v1"] as const :
      ["node-test-targeted/v1", "typescript-no-emit/v1"] as const) : ["typescript-no-emit/v1"] as const;
  for (const profile of required) {
    const current = await recheck(grant, profile);
    if (current.status !== "eligible" || current.fingerprint !== selected.fingerprints[profile]) {
      throw new Error("Selected check inputs changed before execution");
    }
  }
  const current = await admitTaskProposal({ ...dependencies,
    executionEnvironment: grant.executionEnvironment,
    includeTypecheck: grant.kind === SOURCE_TEST_TASK_KIND && grant.verification.typecheck !== null });
  if (JSON.stringify(current) !== JSON.stringify(grant)) throw new Error("Approved proposal changed before execution");
  return validateProposalRunGrant({ ...grant, approvedChecks: selected.fingerprints });
}

async function requestApprovedScope(dependencies: StartTaskDependencies,
  grant: ProposalRunGrant, report: (progress: TaskStartProgress) => void): Promise<SelectedChecks | null> {
  const selected = await selectEligibleChecks(dependencies, grant);
  if (selected === null) return null;
  report({ phase: "awaiting_approval", operation: "proposal_scope" });
  const prompt = grant.executionEnvironment === "host-local" ?
    "Approve this scope and trusted local checks with host access and untracked child processes? [y/N] " :
    "Approve this scope and start isolated execution? [y/N] ";
  return approved(await dependencies.ask(prompt)) ? selected : null;
}

function formatTaskReview(review: TaskReview): string {
  const typecheck = review.check.typecheck;
  const nodeTest = review.check.nodeTest;
  if (review.changedFiles.length === 0 || review.check.status !== "passed" ||
      (review.check.task === SOURCE_TEST_TASK_KIND ? nodeTest?.status !== "passed" ||
        typecheck !== null && typecheck.status !== "passed" : typecheck?.status !== "passed")) {
    throw new Error("Candidate review evidence unavailable");
  }
  const checkSummary = review.check.task === SOURCE_TEST_TASK_KIND ?
    `PASS Selected Node test: this exact result passed ${nodeTest?.profile}\n` +
      (typecheck === null ? "" : `PASS TypeScript no-emit: this exact result passed ${typecheck.profile}\n`) :
    `PASS TypeScript no-emit: this exact result passed ${typecheck?.profile}\n`;
  const local = [nodeTest, typecheck].some((check) => check?.binding.isolation?.kind === "host-local");
  const environmentSummary = local ?
    "Execution: trusted local process; host files, network and credentials were accessible. No sandbox was enforced; child processes after main-process exit were not tracked.\n" : "";
  const unchecked = review.check.task === SOURCE_TEST_TASK_KIND && typecheck === null ?
    "- repository typechecking\n" : "- full integration suite\n";
  return "\nCandidate review\n\n" +
    `Changed:\n${review.changedFiles.map((path) => `- ${path}`).join("\n")}\n\n` +
    "Checked:\n" +
    "PASS Candidate scope: only admitted candidate files changed\n" +
    checkSummary + environmentSummary + "\n" +
    "Not established:\n" +
    "- requested behavior and completion conditions\n" +
    unchecked + "\n" +
    "Changed since checking: No\n" +
    "Application: Not applied; awaiting your decision\n\n" +
    `Diff (escaped JSON):\n${JSON.stringify(review.diff)}\n`;
}

function showTaskReview(dependencies: StartTaskDependencies, review: TaskReview): void {
  if (dependencies.onReview === undefined) dependencies.write(formatTaskReview(review));
  else dependencies.onReview(review);
}

async function finishOutcome(journal: TaskOutcomeJournal,
  event: Parameters<TaskOutcomeJournal["append"]>[0], write: (text: string) => void,
  meter?: HostWorkMeter): Promise<void> {
  await journal.append(event.state === "finished" && meter !== undefined
    ? { ...event, hostChecks: meter.checks } : event);
  write(formatTaskOutcome(journal.current()));
}

async function completedExecution(execution: TaskRunResult, journal: TaskOutcomeJournal,
  write: (text: string) => void, meter: HostWorkMeter): Promise<TaskStartResult | null> {
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
  await finishOutcome(journal, { state: "finished", outcome }, write, meter);
  return outcome === "cancelled" ? { status: "settled", exitCode: 130, outcome } :
    { status: "settled", exitCode: 1, outcome };
}

async function completedRevision(execution: TaskRunResult, parentReviewSha256: string,
  journal: TaskOutcomeJournal, write: (text: string) => void, meter: HostWorkMeter): Promise<TaskStartResult | null> {
  if (execution.status === "unsettled") {
    write("Semantic revision settlement is unconfirmed. The R0 result cannot be used as fallback.\n");
    write(formatTaskOutcome(journal.current()));
    return { status: "unsettled", exitCode: 1, outcome: "execution_unconfirmed" };
  }
  await journal.append({ state: "revision_finished", candidate: execution.candidate.directory, parentReviewSha256,
    result: { status: execution.status, accounting: execution.accounting }, hostChecks: meter.checks });
  if (execution.status === "passed") return null;
  write("Semantic revision did not pass. The R0 result cannot be accepted or promoted as fallback.\n");
  const outcome = execution.status === "cancelled" ? "cancelled" : "execution_failed";
  await finishOutcome(journal, { state: "finished", outcome }, write, meter);
  return outcome === "cancelled" ? { status: "settled", exitCode: 130, outcome } :
    { status: "settled", exitCode: 1, outcome };
}

async function promoteAcceptedTask(review: TaskReview, decided: TaskReview, source: string, journal: TaskOutcomeJournal,
  report: (progress: TaskStartProgress) => void, promote: typeof promoteTask, write: (text: string) => void,
  meter: HostWorkMeter): Promise<TaskStartResult> {
  if (decided.operatorDecision?.applicability !== "current") throw new Error("Decision became stale");
  report({ phase: "promoting", operation: "accepted_candidate" });
  await journal.append({ state: "promotion_started", reviewSha256: review.reviewSha256, hostChecks: meter.checks });
  try {
    const promotion = await promote(review.directory, source, review.reviewSha256);
    try {
      await finishOutcome(journal, { state: "finished", outcome: "promoted", files: promotion.files }, write, meter);
    } catch {
      write("Promotion applied, but proposal start evidence is incomplete. Inspect the candidate promotion journal.\n");
      return { status: "unsettled", exitCode: 1, outcome: "promotion_unconfirmed" };
    }
    write(`Promoted: ${promotion.files.map((file) => file.path).join(", ")}\n`);
    return { status: "settled", exitCode: 0, outcome: "promoted" };
  } catch (error) {
    if (error instanceof PromotionNotAppliedError) {
      try {
        await finishOutcome(journal, { state: "finished", outcome: "promotion_not_applied" }, write, meter);
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

async function runSemanticCorrection(dependencies: StartTaskDependencies, execution: TaskRunResult, review: TaskReview,
  grant: ProposalRunGrant, journal: TaskOutcomeJournal,
  report: (progress: TaskStartProgress) => void, meter: HostWorkMeter): Promise<TaskStartResult> {
  if (execution.correction?.available() !== true) throw new Error("Semantic correction unavailable");
  const refinement = parseSemanticRefinement(await dependencies.ask("Describe the one bounded semantic correction: "));
  report({ phase: "awaiting_approval", operation: "semantic_correction" });
  if (!approved(await dependencies.ask("Approve this correction within the existing scope and remaining budget? [y/N] "))) {
    dependencies.write("Semantic correction not approved. No final decision or promotion occurred.\n");
    await finishOutcome(journal, { state: "finished", outcome: "cancelled" }, dependencies.write, meter);
    return { status: "settled", exitCode: 130, outcome: "cancelled" };
  }
  const currentParent = await (dependencies.review ?? reviewTask)(review.directory);
  if (currentParent.reviewSha256 !== review.reviewSha256 || currentParent.operatorDecision !== null) {
    throw new Error("Parent review changed before semantic correction");
  }
  const { refinementSha256, effectiveCriteriaSha256 } = execution.correction.criteria(refinement);
  await journal.append({ state: "correction_approved", parentReviewSha256: review.reviewSha256,
    refinementSha256, effectiveCriteriaSha256, hostChecks: meter.checks });
  await journal.append({ state: "revision_started", parentReviewSha256: review.reviewSha256,
    hostChecks: meter.checks });
  report({ phase: "executing", operation: "semantic_revision" });
  const revisedExecution = await execution.correction.run({ refinement,
    parentReviewSha256: review.reviewSha256, parentWriteSetSha256: review.check.writeSetSha256,
    parentCheckSha256: createHash("sha256").update(JSON.stringify(review.check)).digest("hex") });
  meter.checks += Math.max(0, executionHostChecks(revisedExecution) - executionHostChecks(execution));
  const revisionResult = await completedRevision(revisedExecution, review.reviewSha256, journal, dependencies.write, meter);
  if (revisionResult !== null) return revisionResult;
  const revisedReview = await (dependencies.review ?? reviewTask)(review.directory);
  if (revisedReview.historicalAttempt !== "semantic_revision_passed") {
    throw new Error("Fresh semantic revision review unavailable");
  }
  await journal.append({ state: "review_ready", reviewSha256: revisedReview.reviewSha256,
    checkStatus: revisedReview.check.status, revision: "R1", parentReviewSha256: review.reviewSha256,
    hostChecks: meter.checks });
  showTaskReview(dependencies, revisedReview);
  report({ phase: "ready_for_review", operation: "candidate_review" });
  const finalDecision = approved(await dependencies.ask("Accept and promote these exact revised bytes? [y/N] "))
    ? "accept" : "reject";
  const final = await (dependencies.decide ?? decideTask)(revisedReview.directory,
    { decision: finalDecision, reviewSha256: revisedReview.reviewSha256 });
  await journal.append({ state: "decision_recorded", decision: finalDecision,
    reviewSha256: revisedReview.reviewSha256, hostChecks: meter.checks });
  if (finalDecision === "reject") {
    dependencies.write("Revised candidate rejected. Source was not changed.\n");
    await finishOutcome(journal, { state: "finished", outcome: "rejected" }, dependencies.write, meter);
    return { status: "settled", exitCode: 1, outcome: "rejected" };
  }
  return promoteAcceptedTask(revisedReview, final, grant.source, journal, report,
    dependencies.promote ?? promoteTask, dependencies.write, meter);
}

async function closeTaskResources(execution: TaskRunResult | undefined, journal: TaskOutcomeJournal,
  write: (text: string) => void): Promise<void> {
  try { await execution?.correction?.close(); }
  catch {
    try { write("Task input cleanup is incomplete; inspect the retained candidate.\n"); }
    catch { /* Cleanup reporting cannot change a completed task outcome. */ }
  } finally { await journal.close(); }
}

/** One-shot proposal lifecycle. A started proposal cannot be replayed or resumed. */
export async function startTask(dependencies: StartTaskDependencies): Promise<TaskStartResult> {
  const report = dependencies.report ?? ignoreProgress;
  let grant = await admitTaskProposal({ ...dependencies,
    executionEnvironment: dependencies.executionEnvironment ?? "docker-contained" });
  const createOutcome = dependencies.createOutcome ?? createTaskOutcome;
  const journal = await createOutcome(resolve(dependencies.proposalsRoot, grant.proposalId), {
    proposalId: grant.proposalId, proposalSha256: grant.proposalSha256, baseline: grant.baseline,
  });
  let execution: TaskRunResult | undefined;
  const meter = createHostWorkMeter();
  try {
    const approvedGrant = await requestApprovedScope(dependencies, grant, report);
    if (approvedGrant === null) {
      dependencies.write("Proposal not started. Nothing changed.\n");
      await finishOutcome(journal, { state: "scope_declined" }, dependencies.write, meter);
      return { status: "settled", exitCode: 0, outcome: "scope_declined" };
    }
    grant = await revalidateSelectedChecks(dependencies, approvedGrant);
    await journal.append({ state: "execution_started" });
    report({ phase: "executing", operation: "candidate_task" });
    execution = await (dependencies.execute ?? runProposalTask)(grant);
    meter.checks = executionHostChecks(execution);
    const executionResult = await completedExecution(execution, journal, dependencies.write, meter);
    if (executionResult !== null) return executionResult;

    const review = await (dependencies.review ?? reviewTask)(execution.candidate.directory);
    await journal.append({ state: "review_ready", reviewSha256: review.reviewSha256,
      checkStatus: review.check.status, hostChecks: meter.checks });
    showTaskReview(dependencies, review);
    report({ phase: "ready_for_review", operation: "candidate_review" });
    const answer = await dependencies.ask(execution.correction?.available() === true
      ? "Choose for these exact candidate bytes: accept, reject, or request correction [a/r/c] "
      : "Accept and promote these exact candidate bytes? [y/N] ");
    if (correctionRequested(answer)) {
      return await runSemanticCorrection(dependencies, execution, review, grant, journal, report, meter);
    }
    const decision = acceptanceRequested(answer) ? "accept" : "reject";
    const decided = await (dependencies.decide ?? decideTask)(review.directory,
      { decision, reviewSha256: review.reviewSha256 });
    await journal.append({ state: "decision_recorded", decision, reviewSha256: review.reviewSha256,
      hostChecks: meter.checks });
    if (decision === "reject") {
      dependencies.write("Candidate rejected. Source was not changed.\n");
      await finishOutcome(journal, { state: "finished", outcome: "rejected" }, dependencies.write, meter);
      return { status: "settled", exitCode: 1, outcome: "rejected" };
    }
    return await promoteAcceptedTask(review, decided, grant.source, journal, report,
      dependencies.promote ?? promoteTask, dependencies.write, meter);
  } catch (error) {
    if (error instanceof TaskReviewUnsettledError) {
      dependencies.write("Review settlement is unconfirmed. Inspect retained evidence before retrying.\n");
      dependencies.write(formatTaskOutcome(journal.current()));
      return { status: "unsettled", exitCode: 1, outcome: "execution_unconfirmed" };
    }
    if (aborted(error)) {
      await finishOutcome(journal, { state: "finished", outcome: "cancelled" }, dependencies.write, meter);
      return { status: "settled", exitCode: 130, outcome: "cancelled" };
    }
    try {
      await finishOutcome(journal, { state: "finished", outcome: "failed" }, dependencies.write, meter);
      return { status: "settled", exitCode: 1, outcome: "failed" };
    } catch { throw error; }
  } finally { await closeTaskResources(execution, journal, dependencies.write); }
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
