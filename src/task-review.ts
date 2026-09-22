import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import * as z from "zod";
import { candidateDiff, inspectCandidateCheckout } from "./candidate-checkout.js";
import { checkCandidateTask, inspectCandidateTask, type CandidateTaskCheck } from "./candidate-task.js";
import { LIVE_CODEX_MODEL_ID } from "./integrations/pi-live.js";
import { PI_TASK_LIMITS, piSemanticRevisionPasses, piTaskPasses, type PiTaskResult } from "./integrations/pi-task.js";
import { readSemanticRevision, semanticRevisionSha256, type SemanticRevision } from "./semantic-revision.js";
import { TASK_LIMITS } from "./task-contract.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const decisionSchema: z.ZodObject<{
  format: z.ZodLiteral<"tesota-task-decision">; version: z.ZodLiteral<1>;
  decision: z.ZodEnum<{ accept: "accept"; reject: "reject" }>; reviewSha256: z.ZodString;
  recordedAt: z.ZodISODateTime; authority: z.ZodLiteral<"local_operator_assertion">;
}> = z.strictObject({
  format: z.literal("tesota-task-decision"), version: z.literal(1),
  decision: z.enum(["accept", "reject"]), reviewSha256: digestSchema,
  recordedAt: z.iso.datetime(), authority: z.literal("local_operator_assertion"),
});
type TaskDecision = z.infer<typeof decisionSchema>;
const requestSchema = z.strictObject({ decision: decisionSchema.shape.decision, reviewSha256: digestSchema });

const limitsSchema = z.strictObject({
  modelInvocations: z.literal(PI_TASK_LIMITS.modelInvocations),
  toolCalls: z.literal(PI_TASK_LIMITS.toolCalls),
  sessionMs: z.literal(PI_TASK_LIMITS.sessionMs),
  settlementMs: z.literal(PI_TASK_LIMITS.settlementMs),
  outputTokens: z.literal(PI_TASK_LIMITS.outputTokens),
});
const typecheckSchema = z.strictObject({
  profile: z.literal("typescript-no-emit/v1"),
  status: z.enum(["passed", "check_failed", "unavailable", "execution_failed", "timed_out", "cancelled"]),
  reason: z.string().nullable(), diagnostics: z.array(z.string()),
  process: z.enum(["not_started", "exited", "unconfirmed"]), container: z.enum(["absent", "unconfirmed"]),
  binding: z.unknown(), authority: z.literal("none"), provenance: z.literal("issued"),
});
const checkShape = {
  status: z.enum(["passed", "check_failed"]), diagnostics: z.array(z.string()),
  outcome: z.enum(["passed", "check_failed", "operational_failed"]),
  settlement: z.enum(["observed", "unconfirmed"]), task: z.literal("typescript-change"),
  typecheck: typecheckSchema.nullable(), baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  writeSetSha256: digestSchema, sourceInputsSha256: digestSchema, taskAcceptance: z.literal("not_evaluated"),
};
const issuedCheckSchema = z.strictObject({ ...checkShape, provenance: z.literal("issued") });
const recordedCheckSchema = z.strictObject({ ...checkShape, provenance: z.literal("recorded_untrusted") });
const editCauseSchema = z.discriminatedUnion("cause", [
  z.strictObject({ cause: z.enum(["initial_implementation", "semantic_revision"]) }),
  z.strictObject({ cause: z.literal("diagnostic_repair"), failedCheckSha256: digestSchema }),
]);
const sessionSchema = z.strictObject({
  status: z.enum(["completed", "failed", "aborted", "unsettled"]),
  modelInvocations: z.number().int().nonnegative().max(PI_TASK_LIMITS.modelInvocations),
  toolCalls: z.number().int().nonnegative().max(PI_TASK_LIMITS.toolCalls),
  edits: z.number().int().nonnegative(), checks: z.array(issuedCheckSchema).max(3),
  checksSuppliedToModel: z.number().int().nonnegative(), finalCheckSuppliedToModel: z.boolean(),
  deadlineExpired: z.boolean(), settlement: z.enum(["observed", "unconfirmed"]), denied: z.boolean(),
  terminalStopReason: z.string().min(1).nullable(), taskAcceptance: z.literal("not_evaluated"),
  executionCause: z.enum(["initial_implementation", "semantic_revision"]),
  activeMs: z.number().int().nonnegative().max(PI_TASK_LIMITS.sessionMs), editCauses: z.array(editCauseSchema),
  denialStage: z.enum(["tool_request", "tool_operation", "tool_result", "model_admission"]).optional(),
  deniedTool: z.enum(["tesota_read", "tesota_replace", "tesota_check", "unknown"]).optional(),
});
const executorSchema = z.strictObject({ ...Object.fromEntries([
  "task-run.js", "candidate-checkout.js", "candidate-task.js", "task-contract.js", "task-source.js",
  "semantic-revision.js", "repository-check-input.js", "proposal-admission.js", "repository-typecheck.js",
  "repository-typecheck-process.js", "command-isolation.js", "verification/invocation-admission.js",
  "integrations/pi-task.js", "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock",
].map((path) => [path, digestSchema])),
  "integrations/pi-discovery-session.js": digestSchema.optional(),
});
const attemptBaseStartedShape = {
  format: z.literal("tesota-task-attempt"), state: z.literal("started"), timestamp: z.iso.datetime(),
  baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), sourceDirty: z.boolean(),
  executor: executorSchema, model: z.literal(LIVE_CODEX_MODEL_ID), limits: limitsSchema,
  taskAcceptance: z.literal("not_evaluated"),
};
const initialAttemptStartedSchema = z.strictObject({ ...attemptBaseStartedShape, version: z.literal(1),
  executionCause: z.literal("initial_implementation") });
const revisionAttemptStartedSchema = z.strictObject({ ...attemptBaseStartedShape, version: z.literal(2),
  executionCause: z.literal("semantic_revision"), revisionSha256: digestSchema,
  parentReviewSha256: digestSchema, parentAttemptSha256: digestSchema });
const attemptFinishedSchema = z.strictObject({
  state: z.literal("finished"), timestamp: z.iso.datetime(), outcome: z.enum(["passed", "failed", "unsettled"]),
  session: sessionSchema.nullable(), current: recordedCheckSchema.nullable(), reviewSaved: z.boolean(),
  taskAcceptance: z.literal("not_evaluated"),
});

interface InspectedAttempt {
  readonly sha256: string;
  readonly started: z.infer<typeof initialAttemptStartedSchema> | z.infer<typeof revisionAttemptStartedSchema>;
  readonly finished: z.infer<typeof attemptFinishedSchema>;
  readonly rawCurrent: unknown;
}

function sessionChecksMatchCurrent(session: z.infer<typeof sessionSchema>, current: z.infer<typeof recordedCheckSchema>): boolean {
  const last = session.checks.at(-1);
  return last !== undefined && session.checksSuppliedToModel === session.checks.length &&
    session.checks.every((check) => check.task === current.task && check.baseline === current.baseline &&
      check.sourceInputsSha256 === current.sourceInputsSha256) &&
    JSON.stringify({ ...last, provenance: "recorded_untrusted" }) === JSON.stringify(current);
}

export interface TaskReview {
  readonly directory: string;
  readonly reviewSha256: string;
  readonly changedFiles: readonly string[];
  readonly check: CandidateTaskCheck;
  readonly diff: string;
  readonly historicalAttempt: "not_evaluated" | "semantic_revision_passed";
  readonly operatorDecision: {
    readonly record: TaskDecision;
    readonly provenance: "recorded_untrusted";
    readonly applicability: "current" | "stale";
  } | null;
}

/** A review check may still own an unresolved external process or container. */
export class TaskReviewUnsettledError extends Error {
  readonly check: CandidateTaskCheck;
  constructor(check: CandidateTaskCheck) {
    super("Task review settlement is unconfirmed");
    this.name = "TaskReviewUnsettledError";
    this.check = check;
  }
}

function requireSettledCheck(check: CandidateTaskCheck): CandidateTaskCheck {
  if (check.settlement === "unconfirmed") throw new TaskReviewUnsettledError(check);
  return check;
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function ignoreCheck(): void {}

async function readBoundedText(path: string, maximum: number): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum ||
      relative(path, await realpath(path)) !== "") throw new Error("Review evidence unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximum) throw new Error("Review evidence unavailable");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

async function inspectAttempt(directory: string, name: "attempt.jsonl" | "attempt-r1.jsonl",
  startedSchema: typeof initialAttemptStartedSchema | typeof revisionAttemptStartedSchema): Promise<InspectedAttempt> {
  const text = await readBoundedText(join(directory, name), 1024 * 1024);
  if (!text.endsWith("\n") || text.includes("\r")) throw new Error("Task attempt evidence unavailable");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 2 || lines.some((line) => line.length === 0)) throw new Error("Task attempt evidence unavailable");
  const started = startedSchema.parse(JSON.parse(lines[0] ?? "null"));
  const rawFinished = z.record(z.string(), z.unknown()).parse(JSON.parse(lines[1] ?? "null"));
  const finished = attemptFinishedSchema.parse(rawFinished);
  if (Date.parse(finished.timestamp) < Date.parse(started.timestamp)) throw new Error("Task attempt evidence unavailable");
  return { sha256: digest(text), started, finished, rawCurrent: rawFinished["current"] };
}

async function inspectInitialAttempt(directory: string): Promise<InspectedAttempt> {
  const attempt = await inspectAttempt(directory, "attempt.jsonl", initialAttemptStartedSchema);
  const session = attempt.finished.session;
  const current = attempt.finished.current;
  if (attempt.finished.outcome !== "passed" || !attempt.finished.reviewSaved || session === null || current === null ||
      session.executionCause !== "initial_implementation" || session.checks.some((check) =>
        check.baseline !== attempt.started.baseline) || current.baseline !== attempt.started.baseline ||
      !sessionChecksMatchCurrent(session, current) ||
      !piTaskPasses(session as PiTaskResult, current as CandidateTaskCheck)) {
    throw new Error("R0 attempt evidence unavailable");
  }
  return attempt;
}

export async function inspectSemanticRevisionAttempt(directory: string, revision: SemanticRevision): Promise<{
  readonly session: PiTaskResult; readonly current: unknown;
}> {
  const parent = await validateRevisionParent(directory, revision);
  const attempt = await inspectAttempt(directory, "attempt-r1.jsonl", revisionAttemptStartedSchema);
  const started = revisionAttemptStartedSchema.parse(attempt.started);
  const session = attempt.finished.session;
  const current = attempt.finished.current;
  if (attempt.finished.outcome !== "passed" || !attempt.finished.reviewSaved || session === null || current === null ||
      started.revisionSha256 !== semanticRevisionSha256(revision) ||
      started.parentReviewSha256 !== revision.parentReviewSha256 ||
      started.parentAttemptSha256 !== revision.parentAttemptSha256 ||
      session.executionCause !== "semantic_revision" || session.checks.some((check) =>
        check.baseline !== started.baseline) || current.baseline !== started.baseline ||
      !sessionChecksMatchCurrent(session, current) ||
      !piSemanticRevisionPasses(session as PiTaskResult, current as CandidateTaskCheck)) {
    throw new Error("Semantic revision attempt invalid");
  }
  requireRevisionResources(parent, session);
  return { session: session as PiTaskResult, current: attempt.rawCurrent };
}

function requireRevisionResources(parent: z.infer<typeof sessionSchema>, session: z.infer<typeof sessionSchema>): void {
  // runPiTask charges the requesting invocation and a later invocation that receives
  // the check result. Sequential tool dispatch permits multiple tools per response.
  const minimumModelDelta = 2;
  // Each completed replacement/check has a charged tool_execution_start. Reads
  // are not retained here and replacement does not enforce a preceding read.
  const minimumToolDelta = session.edits + session.checks.length;
  if (session.modelInvocations - parent.modelInvocations < minimumModelDelta ||
      session.toolCalls - parent.toolCalls < minimumToolDelta || session.activeMs < parent.activeMs ||
      parent.edits + session.edits > TASK_LIMITS.edits ||
      parent.checks.length + session.checks.length > TASK_LIMITS.checks) {
    throw new Error("Semantic revision resource evidence invalid");
  }
}

function parentReviewSha256(directory: string, current: CandidateTaskCheck, rawCheck: unknown, diff: string): string {
  return digest(JSON.stringify({
    format: "tesota-task-review", version: 1, directory,
    task: current.task, baseline: current.baseline, writeSetSha256: current.writeSetSha256,
    checkSha256: digest(JSON.stringify(rawCheck)), diffSha256: digest(diff),
  }));
}

async function validateRevisionParent(directory: string, revision: SemanticRevision): Promise<z.infer<typeof sessionSchema>> {
  const attempt = await inspectInitialAttempt(directory);
  const current = attempt.finished.current;
  const session = attempt.finished.session;
  if (current === null || session === null) throw new Error("R0 attempt evidence unavailable");
  const diff = await readBoundedText(join(directory, "candidate.diff"), 256 * 1024);
  if (revision.parentAttemptSha256 !== attempt.sha256 ||
      revision.parentReviewSha256 !== parentReviewSha256(directory, current as CandidateTaskCheck, attempt.rawCurrent, diff) ||
      revision.parentWriteSetSha256 !== current.writeSetSha256 ||
      revision.parentCheckSha256 !== digest(JSON.stringify(attempt.rawCurrent))) {
    throw new Error("Semantic revision parent identity invalid");
  }
  return session;
}

export interface CorrectionParentIdentity {
  readonly parentReviewSha256: string;
  readonly parentWriteSetSha256: string;
  readonly parentCheckSha256: string;
  readonly parentAttemptSha256: string;
  readonly taskDefinitionSha256: string;
  readonly revisionSha256?: string;
}

export async function validateCorrectionParent(directory: string, expected: CorrectionParentIdentity,
  observeCheck: () => void = ignoreCheck): Promise<{ readonly check: CandidateTaskCheck;
    readonly attemptSha256: string }> {
  const candidate = await inspectCandidateCheckout(directory);
  const attempt = await inspectInitialAttempt(candidate.directory);
  const retained = await readBoundedText(join(candidate.directory, "candidate.diff"), 256 * 1024);
  observeCheck();
  const first = requireSettledCheck(await checkCandidateTask(candidate.directory));
  const task = await inspectCandidateTask(candidate.directory);
  const currentDiff = await candidateDiff(candidate.directory);
  observeCheck();
  const second = requireSettledCheck(await checkCandidateTask(candidate.directory));
  const recorded = attempt.finished.current;
  const revision = await readSemanticRevision(candidate.directory);
  const decision = await readDecision(candidate.directory);
  if (recorded === null || JSON.stringify(first) !== JSON.stringify(second) ||
      JSON.stringify(attempt.rawCurrent) !== JSON.stringify(second) || retained !== currentDiff || decision !== null ||
      task.definitionSha256 !== expected.taskDefinitionSha256 || candidate.baseline !== attempt.started.baseline ||
      expected.parentReviewSha256 !== parentReviewSha256(candidate.directory, second, second, retained) ||
      expected.parentWriteSetSha256 !== second.writeSetSha256 ||
      expected.parentCheckSha256 !== digest(JSON.stringify(second)) ||
      expected.parentAttemptSha256 !== attempt.sha256 || (expected.revisionSha256 === undefined ? revision !== null :
        revision === null || semanticRevisionSha256(revision) !== expected.revisionSha256)) {
    throw new Error("Semantic correction parent evidence invalid");
  }
  return { check: second, attemptSha256: attempt.sha256 };
}

async function readDecision(directory: string): Promise<TaskDecision | null> {
  const path = join(directory, "decision.json");
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw new Error("Decision unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096 ||
      relative(path, await realpath(path)) !== "") throw new Error("Decision unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > 4096) throw new Error("Decision exceeds bound");
    return decisionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
  } finally { await file.close(); }
}

/** Fresh checks and a freshly generated diff; saved success claims are never acceptance inputs. */
export async function reviewTask(directory: string, observeCheck: () => void = ignoreCheck): Promise<TaskReview> {
  const candidate = await inspectCandidateCheckout(directory);
  const revision = await readSemanticRevision(candidate.directory);
  let revisionAttempt: Awaited<ReturnType<typeof inspectSemanticRevisionAttempt>> | null = null;
  if (revision !== null) {
    revisionAttempt = await inspectSemanticRevisionAttempt(candidate.directory, revision);
  }
  observeCheck();
  const check = requireSettledCheck(await checkCandidateTask(candidate.directory));
  if (revisionAttempt !== null && JSON.stringify(revisionAttempt.current) !== JSON.stringify(check)) {
    throw new Error("Semantic revision check identity invalid");
  }
  const diff = await candidateDiff(candidate.directory);
  if (revision !== null && await readBoundedText(join(candidate.directory, "candidate-r1.diff"), 256 * 1024) !== diff) {
    throw new Error("Semantic revision diff identity invalid");
  }
  observeCheck();
  const current = requireSettledCheck(await checkCandidateTask(candidate.directory));
  if (JSON.stringify(check) !== JSON.stringify(current)) throw new Error("Candidate changed during review");
  const task = await inspectCandidateTask(candidate.directory);
  if (revision !== null && revision.taskDefinitionSha256 !== task.definitionSha256) {
    throw new Error("Semantic revision task identity invalid");
  }
  const ordinaryIdentity = {
    format: "tesota-task-review", version: 1, directory: candidate.directory,
    task: check.task, baseline: check.baseline, writeSetSha256: check.writeSetSha256,
    checkSha256: digest(JSON.stringify(check)), diffSha256: digest(diff),
  } as const;
  const reviewSha256 = digest(JSON.stringify(revision === null ? ordinaryIdentity : {
    ...ordinaryIdentity, version: 2, revision: "R1", effectiveCriteriaSha256: revision.effectiveCriteriaSha256,
    parentReviewSha256: revision.parentReviewSha256, parentWriteSetSha256: revision.parentWriteSetSha256,
    parentCheckSha256: revision.parentCheckSha256, taskDefinitionSha256: revision.taskDefinitionSha256,
  }));
  const record = await readDecision(candidate.directory);
  const currentCandidate = await inspectCandidateCheckout(candidate.directory);
  return { directory: candidate.directory, reviewSha256,
    changedFiles: currentCandidate.changes.map((change) => change.path).sort(), check, diff,
    historicalAttempt: revision === null ? "not_evaluated" : "semantic_revision_passed",
    operatorDecision: record === null ? null : { record, provenance: "recorded_untrusted",
      applicability: record.reviewSha256 === reviewSha256 ? "current" : "stale" } };
}

/** Explicit local CLI assertion only. This API is never exposed as a model tool. */
export async function decideTask(directory: string, request: unknown,
  observeCheck: () => void = ignoreCheck): Promise<TaskReview> {
  const args = requestSchema.parse(request);
  const review = await reviewTask(directory, observeCheck);
  if (review.operatorDecision !== null) throw new Error("A decision already exists");
  if (args.reviewSha256 !== review.reviewSha256) throw new Error("Review is stale");
  if (args.decision === "accept" && (review.check.status !== "passed" || review.check.sourceInputsSha256 === null)) {
    throw new Error("Acceptance requires a passing current check and an admitted source binding");
  }
  const record: TaskDecision = { format: "tesota-task-decision", version: 1, decision: args.decision,
    reviewSha256: review.reviewSha256, recordedAt: new Date().toISOString(), authority: "local_operator_assertion" };
  const file = await open(join(review.directory, "decision.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  // A late edit cannot be reported as a currently applicable decision.
  return reviewTask(review.directory, observeCheck);
}
