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
  readonly status: "passed" | "failed" | "cancelled";
  readonly accounting: TaskExecutionAccounting;
}

export interface TaskRunHost {
  readonly signal?: AbortSignal;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  readonly exitUnsettled?: (code: number) => never;
}

function stdout(text: string): void { process.stdout.write(text); }
function stderr(text: string): void { process.stderr.write(text); }
function exitProcess(code: number): never { process.exit(code); }
function ignore(): void {}

function taskExecutionAccounting(session: PiTaskResult | null, startedAt: number): TaskExecutionAccounting {
  return { elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), firstCheck: session?.checks[0]?.status ?? "not_observed",
    correctionAttempts: session?.edits ?? 0, modelInvocations: session?.modelInvocations ?? 0,
    toolCalls: session?.toolCalls ?? 0, edits: session?.edits ?? 0,
    consumption: { status: "partial", tokenUsage: "unavailable", cost: "unavailable" } };
}

function resolvedHost(host: TaskRunHost): Required<Omit<TaskRunHost, "signal">> {
  return { write: host.write ?? stdout, writeError: host.writeError ?? stderr,
    exitUnsettled: host.exitUnsettled ?? exitProcess };
}

function relayCancellation(source: AbortSignal | undefined, target: AbortController): () => void {
  if (source === undefined) return ignore;
  const abort = (): void => { target.abort(); };
  if (source.aborted) abort();
  source.addEventListener("abort", abort, { once: true });
  return () => { source.removeEventListener("abort", abort); };
}

/** Execute only an in-memory grant already issued by proposal admission. */
async function runPreparedTask(candidate: CandidateCheckout, grant: ProposalRunGrant,
  host: TaskRunHost): Promise<TaskRunResult> {
  const startedAt = performance.now();
  const cancellation = new AbortController();
  const { write, writeError, exitUnsettled } = resolvedHost(host);
  const interrupt = (): void => cancellation.abort();
  const stopRelayingCancellation = relayCancellation(host.signal, cancellation);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const watchdog = setTimeout(() => {
    cancellation.abort();
    writeError("Task settlement unconfirmed; inspect the retained attempt.\n");
    exitUnsettled(1);
  }, 360_000);
  try {
    write(`Task candidate: ${candidate.directory}\n`);
    const record = await open(join(candidate.directory, "attempt.jsonl"), "wx", 0o600);
    let task: CandidateTask | undefined;
    let session: PiTaskResult | null = null;
    let current: CandidateTaskCheck | null = null;
    let reviewSaved = false;
    let passed = false;
    try {
      const executor: Record<string, string> = {};
      for (const path of ["task-run.js", "candidate-checkout.js", "candidate-task.js", "task-contract.js",
        "proposal-admission.js", "verification/invocation-admission.js", "integrations/pi-task.js",
        "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock"]) {
        executor[path] = createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
      }
      await record.writeFile(JSON.stringify({ format: "tesota-task-attempt", version: 1, state: "started",
        timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: candidate.sourceDirty,
        executor, model: LIVE_CODEX_MODEL_ID, limits: PI_TASK_LIMITS, taskAcceptance: "not_evaluated" }) + "\n");
      await record.sync();
      if (cancellation.signal.aborted) throw new Error("Task interrupted");
      task = await CandidateTask.prepare(candidate.directory, grant);
      const models = await storedCodexModels(new CodexCredentials(), cancellation.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("Task model unavailable");
      session = await runPiTask(task, model, (requested, context, options) =>
        models.streamSimple(requested, context, options), cancellation.signal);
    } catch {
      writeError("Task attempt did not complete successfully; retained state is available for inspection.\n");
    } finally {
      task?.close();
      try {
        await writeFile(join(candidate.directory, "candidate.diff"), await candidateDiff(candidate.directory),
          { flag: "wx", mode: 0o600 });
        reviewSaved = true;
        current = await checkCandidateTask(candidate.directory);
        passed = session !== null && !cancellation.signal.aborted && piTaskPasses(session, current);
      } catch { passed = false; }
      try {
        await record.writeFile(JSON.stringify({ state: "finished", timestamp: new Date().toISOString(),
          outcome: passed && reviewSaved ? "passed" : "failed", session, current, reviewSaved,
          taskAcceptance: "not_evaluated" }) + "\n");
        await record.sync();
      } finally { await record.close(); }
    }
    const status: TaskRunResult["status"] = cancellation.signal.aborted ? "cancelled" :
      passed && reviewSaved ? "passed" : "failed";
    write(status === "passed" ? "Task checks passed; diff retained for human review.\n" :
      status === "cancelled" ? "Task cancelled; retained state is available for inspection.\n" :
        "Task unaccepted; inspect the retained checks and diff.\n");
    return { candidate, status, accounting: taskExecutionAccounting(session, startedAt) };
  } catch {
    writeError("Task preparation or evidence persistence failed. No promotion occurred.\n");
    return { candidate, status: "failed", accounting: taskExecutionAccounting(null, startedAt) };
  } finally {
    cancellation.abort();
    clearTimeout(watchdog);
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
