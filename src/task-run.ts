import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import * as z from "zod";
import { candidateDiff, createCandidateCheckout, createCandidateSuccessor, inspectCandidateCheckout,
  listCandidateCheckouts, type CandidateCheckout } from "./candidate-checkout.js";
import { CandidateTask, checkCandidateTask, inspectCandidateTask, type CandidateTaskCheck } from "./candidate-task.js";
import { DEFAULT_CANDIDATE_TASK_ID, parseCandidateTaskId, type CandidateTaskId } from "./candidate-task-definition.js";
import { PROPOSAL_TASK_KIND, type ProposalRunGrant } from "./proposal-admission.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { PI_TASK_LIMITS, piTaskPasses, runPiTask, type PiTaskResult } from "./integrations/pi-task.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const baselineSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const limitsSchema = z.strictObject({
  modelInvocations: z.number().int().positive(),
  toolCalls: z.number().int().positive(),
  sessionMs: z.number().int().positive(),
  settlementMs: z.number().int().positive(),
  outputTokens: z.number().int().positive(),
});
const recoverySchema = z.strictObject({
  predecessorId: z.uuid(), predecessorBaseline: baselineSchema,
  priorOutcome: z.enum(["failed", "incomplete"]), authority: z.literal("local_operator_request"),
});
const attemptStartedSchema = z.strictObject({
  format: z.literal("tesota-task-attempt"), version: z.literal(1), state: z.literal("started"),
  timestamp: z.iso.datetime(), baseline: baselineSchema, sourceDirty: z.boolean(),
  executor: z.record(z.string(), hashSchema), model: z.string().min(1), limits: limitsSchema,
  taskAcceptance: z.literal("not_evaluated"), recovery: recoverySchema.optional(),
});
const attemptFinishedSchema = z.strictObject({
  state: z.literal("finished"), timestamp: z.iso.datetime(), outcome: z.enum(["passed", "failed"]),
  session: z.unknown(), current: z.unknown(), reviewSaved: z.boolean(), taskAcceptance: z.literal("not_evaluated"),
});
type Recovery = z.infer<typeof recoverySchema>;

async function recoverableOutcome(directory: string, baseline: string): Promise<"failed" | "incomplete"> {
  const path = join(directory, "attempt.jsonl");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 1024 * 1024 ||
      relative(path, await realpath(path)) !== "") throw new Error("Task attempt unavailable");
  const file = await open(path, "r");
  let text: string;
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > 1024 * 1024) throw new Error("Task attempt unavailable");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
  const lines = text.split("\n");
  const terminalComplete = lines.at(-1) === "";
  if (terminalComplete) lines.pop();
  else if (lines.length === 2) lines.pop();
  else throw new Error("Task attempt invalid");
  if (lines.length < 1 || lines.length > 2) throw new Error("Task attempt invalid");
  const started = attemptStartedSchema.parse(JSON.parse(lines[0] ?? ""));
  if (started.baseline !== baseline) throw new Error("Task attempt baseline changed");
  if (lines.length === 1 || !terminalComplete) return "incomplete";
  const finished = attemptFinishedSchema.parse(JSON.parse(lines[1] ?? ""));
  if (finished.outcome !== "failed") throw new Error("Successful task attempts cannot be recovered");
  return "failed";
}

export interface PreparedTaskRecovery {
  readonly predecessor: string;
  readonly taskId: CandidateTaskId;
  readonly priorOutcome: "failed" | "incomplete";
  readonly candidate: CandidateCheckout;
}

/** Explicit recovery starts from the same baseline in a fresh candidate and inherits no task authority or worktree bytes. */
export async function prepareTaskRecovery(reference: string): Promise<PreparedTaskRecovery> {
  const predecessor = await inspectCandidateCheckout(reference);
  const summary = (await listCandidateCheckouts(dirname(predecessor.directory)))
    .find((candidate) => candidate.directory === predecessor.directory);
  if (summary?.status !== "awaiting-review") throw new Error("Task recovery requires an undecided candidate");
  const priorOutcome = await recoverableOutcome(predecessor.directory, predecessor.baseline);
  const current = await inspectCandidateTask(predecessor.directory);
  const taskId = parseCandidateTaskId(current.task);
  if (taskId === null) throw new Error("Proposal tasks cannot be resumed");
  const candidate = await createCandidateSuccessor(predecessor.directory);
  return { predecessor: predecessor.directory, taskId, priorOutcome, candidate };
}

export interface TaskRunResult {
  readonly candidate: CandidateCheckout;
  readonly status: "passed" | "failed";
}

async function runPreparedTask(candidate: CandidateCheckout, grantOrTaskId: CandidateTaskId | ProposalRunGrant,
  recovery?: Recovery): Promise<TaskRunResult> {
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const watchdog = setTimeout(() => {
    cancellation.abort();
    process.stderr.write("Task settlement unconfirmed; inspect the retained attempt.\n");
    process.exit(1);
  }, 360_000);
  try {
    process.stdout.write("Task candidate: " + candidate.directory + "\n");
    const record = await open(join(candidate.directory, "attempt.jsonl"), "wx", 0o600);
    let task: CandidateTask | undefined;
    let session: PiTaskResult | null = null;
    let current: CandidateTaskCheck | null = null;
    let reviewSaved = false;
    let passed = false;
    try {
      const executor: Record<string, string> = {};
      for (const path of ["task-run.js", "candidate-checkout.js", "candidate-task.js", "candidate-task-definition.js",
        "code-task-check.js", "formal-task-check.js", "candidate-source-task-check.js", "multi-file-task-check.js",
        "verification/invocation-admission.js",
        "integrations/pi-task.js", "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock"]) {
        executor[path] = createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
      }
      await record.writeFile(JSON.stringify({ format: "tesota-task-attempt", version: 1, state: "started",
        timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: candidate.sourceDirty,
        executor, model: LIVE_CODEX_MODEL_ID, limits: PI_TASK_LIMITS, taskAcceptance: "not_evaluated",
        ...(recovery === undefined ? {} : { recovery }) }) + "\n");
      await record.sync();
      if (cancellation.signal.aborted) throw new Error("Task interrupted");
      task = typeof grantOrTaskId === "string" ? await CandidateTask.prepare(candidate.directory, grantOrTaskId) :
        await CandidateTask.prepareProposal(candidate.directory, grantOrTaskId);
      const models = await storedCodexModels(new CodexCredentials(), cancellation.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("Task model unavailable");
      session = await runPiTask(task, model, (requested, context, options) =>
        models.streamSimple(requested, context, options), cancellation.signal);
    } catch {
      process.stderr.write("Task attempt did not complete successfully; retained state is available for inspection.\n");
    } finally {
      task?.close();
      try {
        await writeFile(join(candidate.directory, "candidate.diff"), await candidateDiff(candidate.directory), { flag: "wx", mode: 0o600 });
        reviewSaved = true;
        current = await checkCandidateTask(candidate.directory);
        passed = session !== null && !cancellation.signal.aborted && piTaskPasses(session, current);
      } catch {
        passed = false;
      }
      try {
        await record.writeFile(JSON.stringify({ state: "finished", timestamp: new Date().toISOString(),
          outcome: passed && reviewSaved ? "passed" : "failed", session, current, reviewSaved,
          taskAcceptance: "not_evaluated" }) + "\n");
        await record.sync();
      } finally { await record.close(); }
    }
    process.stdout.write(passed && reviewSaved ? "Task checks passed; diff retained for human review.\n" : "Task unaccepted; inspect the retained checks and diff.\n");
    return { candidate, status: passed && reviewSaved ? "passed" : "failed" };
  } catch {
    process.stderr.write("Task preparation or evidence persistence failed. No promotion occurred.\n");
    return { candidate, status: "failed" };
  } finally {
    cancellation.abort();
    clearTimeout(watchdog);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

/** A normal invocation creates its own candidate and authority. */
export async function runTaskCommand(requestedTaskId: string = DEFAULT_CANDIDATE_TASK_ID): Promise<number> {
  const taskId = parseCandidateTaskId(requestedTaskId);
  if (taskId === null) {
    process.stderr.write("Unknown task id.\n");
    return 2;
  }
  if (process.platform !== "win32") {
    process.stderr.write("Live repository tasks are currently supported on Windows.\n");
    return 2;
  }
  try { return (await runPreparedTask(await createCandidateCheckout(process.cwd()), taskId)).status === "passed" ? 0 : 1; }
  catch {
    process.stderr.write("Task preparation or evidence persistence failed. No promotion occurred.\n");
    return 1;
  }
}

/** Recovery is an explicit fresh attempt; it never resumes the predecessor's model session. */
export async function recoverTaskCommand(reference: string): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("Live repository tasks are currently supported on Windows.\n");
    return 2;
  }
  try {
    const prepared = await prepareTaskRecovery(reference);
    const predecessorId = prepared.predecessor.split(/[\\/]/).at(-1);
    if (predecessorId === undefined) throw new Error("Task predecessor unavailable");
    const recovery = recoverySchema.parse({
      predecessorId,
      predecessorBaseline: prepared.candidate.baseline,
      priorOutcome: prepared.priorOutcome,
      authority: "local_operator_request",
    });
    return (await runPreparedTask(prepared.candidate, prepared.taskId, recovery)).status === "passed" ? 0 : 1;
  } catch {
    process.stderr.write("Task recovery unavailable. No predecessor state was changed.\n");
    return 2;
  }
}

/** Execute only an in-memory proposal grant already issued by the admission owner. */
export async function runProposalTask(grant: ProposalRunGrant): Promise<TaskRunResult> {
  if (grant.kind !== PROPOSAL_TASK_KIND || process.platform !== "win32") throw new Error("Proposal execution unavailable");
  return runPreparedTask(await createCandidateCheckout(grant.source), grant);
}
