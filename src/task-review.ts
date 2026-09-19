import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import * as z from "zod";
import { candidateDiff, inspectCandidateCheckout } from "./candidate-checkout.js";
import { checkCandidateTask, type CandidateTaskCheck } from "./candidate-task.js";

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

export interface TaskReview {
  readonly directory: string;
  readonly reviewSha256: string;
  readonly changedFiles: readonly string[];
  readonly check: CandidateTaskCheck;
  readonly diff: string;
  readonly historicalAttempt: "not_evaluated";
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
export async function reviewTask(directory: string): Promise<TaskReview> {
  const candidate = await inspectCandidateCheckout(directory);
  const check = requireSettledCheck(await checkCandidateTask(candidate.directory));
  const diff = await candidateDiff(candidate.directory);
  const current = requireSettledCheck(await checkCandidateTask(candidate.directory));
  if (JSON.stringify(check) !== JSON.stringify(current)) throw new Error("Candidate changed during review");
  const reviewSha256 = digest(JSON.stringify({
    format: "tesota-task-review", version: 1, directory: candidate.directory,
    task: check.task, baseline: check.baseline, writeSetSha256: check.writeSetSha256,
    checkSha256: digest(JSON.stringify(check)), diffSha256: digest(diff),
  }));
  const record = await readDecision(candidate.directory);
  const currentCandidate = await inspectCandidateCheckout(candidate.directory);
  return { directory: candidate.directory, reviewSha256,
    changedFiles: currentCandidate.changes.map((change) => change.path).sort(), check, diff, historicalAttempt: "not_evaluated",
    operatorDecision: record === null ? null : { record, provenance: "recorded_untrusted",
      applicability: record.reviewSha256 === reviewSha256 ? "current" : "stale" } };
}

/** Explicit local CLI assertion only. This API is never exposed as a model tool. */
export async function decideTask(directory: string, request: unknown): Promise<TaskReview> {
  const args = requestSchema.parse(request);
  const review = await reviewTask(directory);
  if (review.operatorDecision !== null) throw new Error("A decision already exists");
  if (args.reviewSha256 !== review.reviewSha256) throw new Error("Review is stale");
  if (args.decision === "accept" && review.check.status !== "passed") throw new Error("Acceptance requires a passing current check");
  const record: TaskDecision = { format: "tesota-task-decision", version: 1, decision: args.decision,
    reviewSha256: review.reviewSha256, recordedAt: new Date().toISOString(), authority: "local_operator_assertion" };
  const file = await open(join(review.directory, "decision.json"), "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  // A late edit cannot be reported as a currently applicable decision.
  return reviewTask(review.directory);
}
