import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateDiff, createCandidateCheckout, type CandidateCheckout } from "./candidate-checkout.js";
import { CandidateTask, checkCandidateTask, type CandidateTaskCheck } from "./candidate-task.js";
import { TASK_LIMITS } from "./task-contract.js";
import { validateProposalRunGrant, type ProposalRunGrant } from "./proposal-admission.js";
import type { TaskExecutionAccounting } from "./task-outcome.js";
import { validateCorrectionParent, type CorrectionParentIdentity } from "./task-review.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { createPiTaskBudget, PI_TASK_LIMITS, piSemanticRevisionPasses, piTaskPasses, runPiTask,
  type PiTaskBudget, type PiTaskResult } from "./integrations/pi-task.js";
import { effectiveCriteriaSha256, parseSemanticRefinement, recordSemanticRevision, semanticRevisionSha256,
  type SemanticRevision } from "./semantic-revision.js";

export interface TaskRunResult {
  readonly candidate: CandidateCheckout;
  readonly status: "passed" | "failed" | "cancelled" | "unsettled";
  readonly accounting: TaskExecutionAccounting;
  readonly correction?: TaskCorrectionAuthority | null;
}

export interface TaskCorrectionRequest {
  readonly refinement: string;
  readonly parentReviewSha256: string;
  readonly parentWriteSetSha256: string;
  readonly parentCheckSha256: string;
}

export interface TaskCorrectionAuthority {
  available(): boolean;
  criteria(refinement: string): Readonly<{ refinementSha256: string; effectiveCriteriaSha256: string }>;
  run(request: TaskCorrectionRequest): Promise<TaskRunResult>;
  close(): void;
}

export interface TaskRunHost {
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

function stdout(text: string): void { process.stdout.write(text); }
function stderr(text: string): void { process.stderr.write(text); }
function ignore(): void {}

interface TaskCauseAccounting {
  initialImplementation: boolean;
  diagnosticRepairs: number;
  semanticRevision: boolean;
}

function recordExecutionCauses(accounting: TaskCauseAccounting, session: PiTaskResult | null): void {
  if (session === null) return;
  if (session.executionCause === "initial_implementation") accounting.initialImplementation = true;
  if (session.executionCause === "semantic_revision") accounting.semanticRevision = true;
  accounting.diagnosticRepairs += session.editCauses.filter((cause) => cause.cause === "diagnostic_repair").length;
}

function observedUsage(usage: ReturnType<CandidateTask["usage"]> | undefined): ReturnType<CandidateTask["usage"]> {
  return usage ?? { reads: 0, edits: 0, checks: 0 };
}

function sessionAccounting(session: PiTaskResult | null): Readonly<{
  firstCheck: TaskExecutionAccounting["firstCheck"]; modelInvocations: number; toolCalls: number;
  edits: number; activeMs: number;
}> {
  if (session === null) return { firstCheck: "not_observed", modelInvocations: 0, toolCalls: 0, edits: 0, activeMs: 0 };
  return { firstCheck: session.checks[0]?.status ?? "not_observed", modelInvocations: session.modelInvocations,
    toolCalls: session.toolCalls, edits: session.edits, activeMs: session.activeMs };
}

function taskExecutionAccounting(session: PiTaskResult | null, startedAt: number,
  causes: TaskCauseAccounting, hostChecks: number,
  usage?: ReturnType<CandidateTask["usage"]>): TaskExecutionAccounting {
  const current = observedUsage(usage);
  const observed = sessionAccounting(session);
  const edits = usage === undefined ? observed.edits : current.edits;
  return { elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), firstCheck: observed.firstCheck,
    correctionAttempts: edits, modelInvocations: observed.modelInvocations,
    toolCalls: observed.toolCalls, edits,
    causes: { ...causes },
    resources: { reads: current.reads, checks: current.checks, hostChecks, activeMs: observed.activeMs },
    consumption: { status: "partial", tokenUsage: "unavailable", cost: "unavailable" } };
}

function resolvedHost(host: TaskRunHost): Required<Omit<TaskRunHost, "signal">> {
  return { write: host.write ?? stdout, writeError: host.writeError ?? stderr };
}

function relayCancellation(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return ignore;
  const abort = (): void => { target.abort(); };
  if (source.aborted) abort();
  source.addEventListener("abort", abort, { once: true });
  return () => { source.removeEventListener("abort", abort); };
}

interface RecordedTaskAttempt {
  readonly session: PiTaskResult | null;
  readonly current: CandidateTaskCheck | null;
  readonly reviewSaved: boolean;
  readonly passed: boolean;
  readonly settlement: "observed" | "unconfirmed";
  readonly evidencePersisted: boolean;
  readonly hostChecks: number;
  readonly attemptSha256: string | null;
}

async function executorSha256(): Promise<Record<string, string>> {
  const executor: Record<string, string> = {};
  for (const path of ["task-run.js", "candidate-checkout.js", "candidate-task.js", "task-contract.js", "task-source.js",
    "semantic-revision.js",
    "repository-check-input.js",
    "proposal-admission.js", "repository-typecheck.js", "repository-typecheck-process.js", "command-isolation.js",
    "verification/invocation-admission.js", "integrations/pi-task.js",
    "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock"]) {
    executor[path] = createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
  }
  return executor;
}

async function executeTaskSession(task: CandidateTask, context: SemanticRevision | null,
  parentEvidence: CandidateTaskCheck | null, budget: PiTaskBudget, signal: AbortSignal,
  admitRevision?: () => Promise<CandidateTaskCheck>): Promise<PiTaskResult> {
  const usage = task.usage();
  const remainingBudget = {
    reads: Math.max(0, TASK_LIMITS.reads - usage.reads), edits: Math.max(0, TASK_LIMITS.edits - usage.edits),
    checks: Math.max(0, TASK_LIMITS.checks - usage.checks),
    modelInvocations: Math.max(0, PI_TASK_LIMITS.modelInvocations - budget.modelInvocations),
    toolCalls: Math.max(0, PI_TASK_LIMITS.toolCalls - budget.toolCalls),
    activeMs: Math.max(0, PI_TASK_LIMITS.sessionMs - budget.activeMs),
  };
  const models = await storedCodexModels(new CodexCredentials(), signal);
  const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
  if (model?.api !== "openai-codex-responses") throw new Error("Task model unavailable");
  let capability;
  if (context === null) capability = task.beginExecution();
  else {
    if (parentEvidence === null || admitRevision === undefined) {
      throw new Error("Semantic revision parent evidence unavailable");
    }
    const admittedParent = await admitRevision();
    capability = task.beginExecution({
      cause: "semantic_revision", refinement: context.refinement,
      parentReviewSha256: context.parentReviewSha256,
      parentWriteSetSha256: context.parentWriteSetSha256,
      parentCheckSha256: context.parentCheckSha256,
      effectiveCriteriaSha256: context.effectiveCriteriaSha256,
      parentEvidence: admittedParent, remainingBudget,
    });
  }
  try {
    return await runPiTask(capability, model, (requested, modelContext, options) =>
      models.streamSimple(requested, modelContext, options), signal, budget);
  } finally { capability.close(); }
}

function finalCheckPermitted(session: PiTaskResult | null, signal: AbortSignal): boolean {
  return session?.status === "completed" && session.settlement === "observed" && !signal.aborted;
}

function combinedSettlement(session: PiTaskResult | null,
  current: CandidateTaskCheck | null): RecordedTaskAttempt["settlement"] {
  return session?.settlement === "unconfirmed" || current?.settlement === "unconfirmed" ? "unconfirmed" : "observed";
}

function taskRunStatus(attempt: RecordedTaskAttempt, signal: AbortSignal): TaskRunResult["status"] {
  if (attempt.settlement === "unconfirmed") return "unsettled";
  if (signal.aborted) return "cancelled";
  return attempt.evidencePersisted && attempt.passed && attempt.reviewSaved ? "passed" : "failed";
}

function attemptRecordOutcome(settlement: RecordedTaskAttempt["settlement"], passed: boolean,
  reviewSaved: boolean): "passed" | "failed" | "unsettled" {
  return settlement === "unconfirmed" ? "unsettled" : passed && reviewSaved ? "passed" : "failed";
}

function taskRunMessage(status: TaskRunResult["status"]): string {
  if (status === "passed") return "Task checks passed; diff retained for human review.\n";
  if (status === "unsettled") return "Task settlement unconfirmed; inspect the retained attempt.\n";
  if (status === "cancelled") return "Task cancelled; retained state is available for inspection.\n";
  return "Task unaccepted; inspect the retained checks and diff.\n";
}

function attemptPasses(revision: SemanticRevision | null, session: PiTaskResult | null,
  current: CandidateTaskCheck | null, signal: AbortSignal): boolean {
  if (session === null || current === null || signal.aborted) return false;
  return revision === null ? piTaskPasses(session, current) : piSemanticRevisionPasses(session, current);
}

async function recordTaskAttempt(candidate: CandidateCheckout, task: CandidateTask, budget: PiTaskBudget,
  revision: SemanticRevision | null, parentEvidence: CandidateTaskCheck | null, signal: AbortSignal,
  writeError: (text: string) => void,
  admitRevision?: () => Promise<CandidateTaskCheck>): Promise<RecordedTaskAttempt> {
  const suffix = revision === null ? "" : "-r1";
  const finalRecordPath = join(candidate.directory, `attempt${suffix}.jsonl`);
  const recordPath = revision === null ? finalRecordPath : join(candidate.directory, "attempt-r1.partial");
  const record = await open(recordPath, "wx", 0o600);
  let session: PiTaskResult | null = null;
  let current: CandidateTaskCheck | null = null;
  let reviewSaved = false;
  let passed = false;
  let evidencePersisted = true;
  let settlement: RecordedTaskAttempt["settlement"] = "observed";
  let hostChecks = 0;
  let retainedBytes = "";
  try {
    const startedRecord = JSON.stringify({ format: "tesota-task-attempt", version: revision === null ? 1 : 2, state: "started",
      timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: candidate.sourceDirty,
      executor: await executorSha256(), model: LIVE_CODEX_MODEL_ID, limits: PI_TASK_LIMITS,
      taskAcceptance: "not_evaluated", executionCause: revision === null ? "initial_implementation" : "semantic_revision",
      ...(revision === null ? {} : { revisionSha256: semanticRevisionSha256(revision),
        parentReviewSha256: revision.parentReviewSha256,
        parentAttemptSha256: revision.parentAttemptSha256 }) }) + "\n";
    retainedBytes += startedRecord;
    await record.writeFile(startedRecord);
    await record.sync();
    if (signal.aborted) throw new Error("Task interrupted");
    session = await executeTaskSession(task, revision, parentEvidence, budget, signal, admitRevision);
  } catch {
    writeError("Task attempt did not complete successfully; retained state is available for inspection.\n");
  } finally {
    try {
      await writeFile(join(candidate.directory, revision === null ? "candidate.diff" : "candidate-r1.diff"),
        await candidateDiff(candidate.directory),
        { flag: "wx", mode: 0o600 });
      reviewSaved = true;
      if (finalCheckPermitted(session, signal)) {
        hostChecks += 1;
        current = await checkCandidateTask(candidate.directory, signal);
      }
      passed = attemptPasses(revision, session, current, signal);
    } catch { passed = false; }
    settlement = combinedSettlement(session, current);
    try {
      const finishedRecord = JSON.stringify({ state: "finished", timestamp: new Date().toISOString(),
        outcome: attemptRecordOutcome(settlement, passed, reviewSaved), session, current, reviewSaved,
        taskAcceptance: "not_evaluated" }) + "\n";
      retainedBytes += finishedRecord;
      await record.writeFile(finishedRecord);
      await record.sync();
    } catch { evidencePersisted = false; }
    try { await record.close(); } catch { evidencePersisted = false; }
    if (revision !== null && evidencePersisted) {
      try { await rename(recordPath, finalRecordPath); } catch { evidencePersisted = false; }
    }
    if (!evidencePersisted) writeError("Task attempt evidence persistence is incomplete; inspect the retained candidate.\n");
  }
  return { session, current, reviewSaved, passed, settlement, evidencePersisted, hostChecks,
    attemptSha256: evidencePersisted ? createHash("sha256").update(retainedBytes).digest("hex") : null };
}

function correctionBudgetAvailable(task: CandidateTask, budget: PiTaskBudget): boolean {
  const usage = task.usage();
  return usage.reads < TASK_LIMITS.reads && usage.edits < TASK_LIMITS.edits && usage.checks < TASK_LIMITS.checks &&
    budget.modelInvocations + 4 <= PI_TASK_LIMITS.modelInvocations &&
    budget.toolCalls + 3 <= PI_TASK_LIMITS.toolCalls && budget.activeMs < PI_TASK_LIMITS.sessionMs;
}

async function runPhase(candidate: CandidateCheckout, task: CandidateTask, budget: PiTaskBudget,
  revision: SemanticRevision | null, parentEvidence: CandidateTaskCheck | null,
  host: TaskRunHost, writeError: (text: string) => void,
  admitRevision?: () => Promise<CandidateTaskCheck>): Promise<RecordedTaskAttempt> {
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort();
  const stopRelayingCancellation = relayCancellation(host.signal, cancellation);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await recordTaskAttempt(candidate, task, budget, revision, parentEvidence, cancellation.signal, writeError,
      admitRevision);
  } finally {
    cancellation.abort();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    stopRelayingCancellation();
  }
}

/** Execute only an in-memory grant already issued by proposal admission. */
async function runPreparedTask(candidate: CandidateCheckout, grant: ProposalRunGrant,
  host: TaskRunHost): Promise<TaskRunResult> {
  const startedAt = performance.now();
  const { write, writeError } = resolvedHost(host);
  let task: CandidateTask | undefined;
  const causes: TaskCauseAccounting = { initialImplementation: false, diagnosticRepairs: 0, semanticRevision: false };
  let hostChecks = 0;
  try {
    write(`Task candidate: ${candidate.directory}\n`);
    task = await CandidateTask.prepare(candidate.directory, grant);
    const budget = createPiTaskBudget();
    const attempt = await runPhase(candidate, task, budget, null, null, host, writeError);
    hostChecks += attempt.hostChecks;
    recordExecutionCauses(causes, attempt.session);
    const status = taskRunStatus(attempt, host.signal ?? new AbortController().signal);
    write(taskRunMessage(status));
    if (status !== "passed") {
      task.close();
      return { candidate, status, accounting: taskExecutionAccounting(attempt.session, startedAt, causes,
        hostChecks, task.usage()),
        correction: null };
    }
    let consumed = false;
    const authority: TaskCorrectionAuthority = {
      available: () => !consumed && task !== undefined && correctionBudgetAvailable(task, budget),
      criteria: (refinement) => {
        if (consumed || task === undefined) throw new Error("Semantic correction unavailable");
        const parsed = parseSemanticRefinement(refinement);
        return { refinementSha256: createHash("sha256").update(parsed).digest("hex"),
          effectiveCriteriaSha256: effectiveCriteriaSha256(task.describe().definitionSha256, parsed) };
      },
      close: (): void => { consumed = true; task?.close(); },
      run: async (request): Promise<TaskRunResult> => {
        if (consumed || task === undefined || !correctionBudgetAvailable(task, budget)) {
          task?.close();
          throw new Error("Semantic correction unavailable within remaining task budget");
        }
        consumed = true;
        const description = task.describe();
        let revision: SemanticRevision;
        try {
          if (attempt.current === null || attempt.attemptSha256 === null ||
              request.parentWriteSetSha256 !== attempt.current.writeSetSha256 ||
              request.parentCheckSha256 !== createHash("sha256").update(JSON.stringify(attempt.current)).digest("hex")) {
            throw new Error("Semantic correction parent evidence invalid");
          }
          const parentIdentity: CorrectionParentIdentity = {
            parentReviewSha256: request.parentReviewSha256,
            parentWriteSetSha256: request.parentWriteSetSha256,
            parentCheckSha256: request.parentCheckSha256,
            parentAttemptSha256: attempt.attemptSha256,
            taskDefinitionSha256: description.definitionSha256,
          };
          const admitted = await validateCorrectionParent(candidate.directory, parentIdentity,
            () => { hostChecks += 1; });
          revision = await recordSemanticRevision(candidate.directory, {
            taskDefinitionSha256: description.definitionSha256,
            parentReviewSha256: request.parentReviewSha256,
            parentWriteSetSha256: request.parentWriteSetSha256,
            parentCheckSha256: request.parentCheckSha256,
            parentAttemptSha256: admitted.attemptSha256,
            refinement: request.refinement,
          });
          const finalIdentity: CorrectionParentIdentity = {
            ...parentIdentity, revisionSha256: semanticRevisionSha256(revision),
          };
          const revised = await runPhase(candidate, task, budget, revision, admitted.check, host, writeError,
            async () => (await validateCorrectionParent(candidate.directory, finalIdentity,
              () => { hostChecks += 1; })).check);
          hostChecks += revised.hostChecks;
          recordExecutionCauses(causes, revised.session);
          const revisedStatus = taskRunStatus(revised, host.signal ?? new AbortController().signal);
          write(taskRunMessage(revisedStatus));
          task.close();
          return { candidate, status: revisedStatus,
            accounting: taskExecutionAccounting(revised.session, startedAt, causes, hostChecks, task.usage()),
            correction: null };
        } catch (error) {
          task.close();
          throw error;
        }
      },
    };
    return { candidate, status, accounting: taskExecutionAccounting(attempt.session, startedAt, causes,
      hostChecks, task.usage()),
      correction: authority };
  } catch {
    task?.close();
    writeError("Task preparation or evidence persistence failed. No promotion occurred.\n");
    return { candidate, status: "failed", accounting: taskExecutionAccounting(null, startedAt, causes,
      hostChecks, task?.usage()),
      correction: null };
  }
}

export async function runProposalTask(grantValue: ProposalRunGrant, host: TaskRunHost = {}): Promise<TaskRunResult> {
  const grant = validateProposalRunGrant(grantValue);
  if (process.platform !== "win32") throw new Error("Proposal execution unavailable");
  if (host.signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
  return runPreparedTask(await createCandidateCheckout(grant.source), grant, host);
}
