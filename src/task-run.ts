import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateDiff, createCandidateCheckout, type CandidateCheckout } from "./candidate-checkout.js";
import { CandidateTask, checkCandidateTask, type CandidateTaskCheck } from "./candidate-task.js";
import { validateProposalRunGrant, type ProposalRunGrant } from "./proposal-admission.js";
import type { TaskExecutionAccounting } from "./task-outcome.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { PI_TASK_LIMITS, piTaskPasses, runPiTask, type PiTaskResult } from "./integrations/pi-task.js";

export interface TaskRunResult {
  readonly candidate: CandidateCheckout;
  readonly status: "passed" | "failed" | "cancelled" | "unsettled";
  readonly accounting: TaskExecutionAccounting;
}

export interface TaskRunHost {
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
}

function stdout(text: string): void { process.stdout.write(text); }
function stderr(text: string): void { process.stderr.write(text); }
function ignore(): void {}

function taskExecutionAccounting(session: PiTaskResult | null, startedAt: number): TaskExecutionAccounting {
  return { elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), firstCheck: session?.checks[0]?.status ?? "not_observed",
    correctionAttempts: session?.edits ?? 0, modelInvocations: session?.modelInvocations ?? 0,
    toolCalls: session?.toolCalls ?? 0, edits: session?.edits ?? 0,
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
}

async function executorSha256(): Promise<Record<string, string>> {
  const executor: Record<string, string> = {};
  for (const path of ["task-run.js", "candidate-checkout.js", "candidate-task.js", "task-contract.js", "task-source.js",
    "repository-check-input.js",
    "proposal-admission.js", "repository-typecheck.js", "repository-typecheck-process.js", "command-isolation.js",
    "verification/invocation-admission.js", "integrations/pi-task.js",
    "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock"]) {
    executor[path] = createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
  }
  return executor;
}

async function executeTaskSession(candidate: CandidateCheckout, grant: ProposalRunGrant,
  signal: AbortSignal): Promise<PiTaskResult> {
  let task: CandidateTask | undefined;
  try {
    task = await CandidateTask.prepare(candidate.directory, grant);
    const models = await storedCodexModels(new CodexCredentials(), signal);
    const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
    if (model?.api !== "openai-codex-responses") throw new Error("Task model unavailable");
    return await runPiTask(task, model, (requested, context, options) =>
      models.streamSimple(requested, context, options), signal);
  } finally { task?.close(); }
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

async function recordTaskAttempt(candidate: CandidateCheckout, grant: ProposalRunGrant,
  signal: AbortSignal, writeError: (text: string) => void): Promise<RecordedTaskAttempt> {
  const record = await open(join(candidate.directory, "attempt.jsonl"), "wx", 0o600);
  let session: PiTaskResult | null = null;
  let current: CandidateTaskCheck | null = null;
  let reviewSaved = false;
  let passed = false;
  let evidencePersisted = true;
  let settlement: RecordedTaskAttempt["settlement"] = "observed";
  try {
    await record.writeFile(JSON.stringify({ format: "tesota-task-attempt", version: 1, state: "started",
      timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: candidate.sourceDirty,
      executor: await executorSha256(), model: LIVE_CODEX_MODEL_ID, limits: PI_TASK_LIMITS,
      taskAcceptance: "not_evaluated" }) + "\n");
    await record.sync();
    if (signal.aborted) throw new Error("Task interrupted");
    session = await executeTaskSession(candidate, grant, signal);
  } catch {
    writeError("Task attempt did not complete successfully; retained state is available for inspection.\n");
  } finally {
    try {
      await writeFile(join(candidate.directory, "candidate.diff"), await candidateDiff(candidate.directory),
        { flag: "wx", mode: 0o600 });
      reviewSaved = true;
      if (finalCheckPermitted(session, signal)) current = await checkCandidateTask(candidate.directory, signal);
      passed = session !== null && current !== null && !signal.aborted && piTaskPasses(session, current);
    } catch { passed = false; }
    settlement = combinedSettlement(session, current);
    try {
      await record.writeFile(JSON.stringify({ state: "finished", timestamp: new Date().toISOString(),
        outcome: attemptRecordOutcome(settlement, passed, reviewSaved), session, current, reviewSaved,
        taskAcceptance: "not_evaluated" }) + "\n");
      await record.sync();
    } catch { evidencePersisted = false; }
    try { await record.close(); } catch { evidencePersisted = false; }
    if (!evidencePersisted) writeError("Task attempt evidence persistence is incomplete; inspect the retained candidate.\n");
  }
  return { session, current, reviewSaved, passed, settlement, evidencePersisted };
}

/** Execute only an in-memory grant already issued by proposal admission. */
async function runPreparedTask(candidate: CandidateCheckout, grant: ProposalRunGrant,
  host: TaskRunHost): Promise<TaskRunResult> {
  const startedAt = performance.now();
  const cancellation = new AbortController();
  const { write, writeError } = resolvedHost(host);
  const interrupt = (): void => cancellation.abort();
  const stopRelayingCancellation = relayCancellation(host.signal, cancellation);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    write(`Task candidate: ${candidate.directory}\n`);
    const attempt = await recordTaskAttempt(candidate, grant, cancellation.signal, writeError);
    const status = taskRunStatus(attempt, cancellation.signal);
    write(taskRunMessage(status));
    return { candidate, status, accounting: taskExecutionAccounting(attempt.session, startedAt) };
  } catch {
    writeError("Task preparation or evidence persistence failed. No promotion occurred.\n");
    return { candidate, status: "failed", accounting: taskExecutionAccounting(null, startedAt) };
  } finally {
    cancellation.abort();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    stopRelayingCancellation();
  }
}

export async function runProposalTask(grantValue: ProposalRunGrant, host: TaskRunHost = {}): Promise<TaskRunResult> {
  const grant = validateProposalRunGrant(grantValue);
  if (process.platform !== "win32") throw new Error("Proposal execution unavailable");
  if (host.signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
  return runPreparedTask(await createCandidateCheckout(grant.source), grant, host);
}
