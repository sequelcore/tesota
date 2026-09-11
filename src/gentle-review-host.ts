import * as z from "zod";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCandidateCheckout } from "./candidate-checkout.js";
import { runGentleProcess, type GentleProcessRequest } from "./integrations/gentle-process.js";
import { runOpaquePiReviewer } from "./integrations/pi-opaque-reviewer.js";

const contract = "gentle-ai.review-integration/v2";
const reviewerSchema = "https://gentle-ai.dev/schema/review/reviewer/v1";
const token = z.string().min(1).max(16_384).refine((value) => !value.includes("\0"));
const tokens = z.array(token).min(1).max(64);
const argument = z.object({ token });
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const tree = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const subject = z.object({
  schema: z.literal("gentle-ai.review-artifact-subject/v2"),
  subject_hash: hash,
  lineage_id: z.string().min(1),
  authority_revision: hash,
  target_identity: hash,
  base_tree: tree,
  candidate_tree: tree,
  changed_path_manifest_sha256: hash,
  lens: z.enum(["review-risk", "review-resilience", "review-readability", "review-reliability"]),
  selected_order: z.number().int().min(0).max(3),
});
const submission = z.object({
  operation_token: z.literal("capture-result"),
  argument_tokens: tokens,
  value: z.object({
    slot: z.literal("reviewer_result"),
    domain: z.literal("artifact_path_or_stdin"),
    schema: z.literal(reviewerSchema),
    substitution_location: z.number().int().nonnegative(),
  }),
});
const slot = z.object({
  name: z.literal("reviewer_result"),
  schema: z.literal(reviewerSchema),
  capture_operation: z.literal("review.capture-result"),
  arguments: z.array(argument).min(1).max(64),
  submission,
  artifact_subject: subject,
});
// This adapter consumes transport fields; Gentle owns the complete review
// schema, findings, authority validation and admission decision.
const statusSchema = z.object({
  schema: z.enum(["gentle-ai.review-integration.status/v5", "gentle-ai.review-integration.status/v6", "gentle-ai.review-integration.status/v7"]),
  contract: z.literal(contract),
  operation: z.literal("review.status"),
  action: z.string(),
  authority: z.object({ lineage_id: z.string().min(1), revision: hash }).optional(),
  target_identity: hash,
  next_transition: z.object({ kind: z.string(), collect: z.object({ inputs: z.array(z.unknown()).min(1).max(4) }).optional() }).optional(),
});

export interface GentleReviewRelayResult {
  readonly status: "submitted" | "provider_transition_required";
  readonly provider: unknown;
}

export interface GentleReviewRelayOptions {
  readonly candidate: string;
  readonly executable: string;
  readonly lineage: string;
  readonly signal?: AbortSignal;
}

export interface GentleReviewRelayDependencies {
  readonly inspect: (candidate: string) => Promise<{ readonly checkout: string }>;
  readonly process: (request: GentleProcessRequest) => Promise<Buffer>;
  readonly reviewer: typeof runOpaquePiReviewer;
}

type GentleStatus = z.infer<typeof statusSchema>;
type ReviewerSlot = z.infer<typeof slot>;

function offeredReviewerSlot(status: GentleStatus): ReviewerSlot | null {
  if (status.action === "stop" || status.next_transition?.kind !== "collect") return null;
  return slot.parse(status.next_transition.collect?.inputs[0]);
}

function assertCurrentSubject(status: GentleStatus, selected: ReviewerSlot, lineage: string): void {
  if (status.authority?.lineage_id !== lineage ||
      status.authority.lineage_id !== selected.artifact_subject.lineage_id ||
      status.target_identity !== selected.artifact_subject.target_identity) {
    throw new Error("Gentle reviewer subject does not match current authority");
  }
}

function materializationArguments(selected: ReviewerSlot): readonly string[] {
  const arguments_ = selected.arguments.map((value) => value.token);
  if (!arguments_.includes("--agent=pi") || !arguments_.includes("--materialize=true")) {
    throw new Error("Gentle did not offer the Pi immutable materialization contract");
  }
  return arguments_;
}

function assertSubmissionSlot(selected: ReviewerSlot): void {
  const completion = selected.submission;
  const location = completion.value.substitution_location;
  if (completion.argument_tokens[location] !== "--input={{value}}" ||
      completion.argument_tokens.filter((value) => value.includes("{{value}}")).length !== 1) {
    throw new Error("Gentle submission must offer exactly one reviewer stdin slot");
  }
}

function reviewerBindingUnchanged(
  current: GentleStatus, observed: GentleStatus, selected: ReviewerSlot,
): boolean {
  const currentSlot = offeredReviewerSlot(current);
  return currentSlot !== null && current.target_identity === observed.target_identity &&
    JSON.stringify(current.authority) === JSON.stringify(observed.authority) &&
    JSON.stringify(currentSlot) === JSON.stringify(selected);
}

/** Collect one currently offered immutable reviewer slot. Never invent or retry authority. */
export async function runGentleReviewHost(
  options: GentleReviewRelayOptions,
  dependencies: GentleReviewRelayDependencies = { inspect: inspectCandidateCheckout, process: runGentleProcess, reviewer: runOpaquePiReviewer },
): Promise<GentleReviewRelayResult> {
  const candidate = await dependencies.inspect(options.candidate);
  const invoke = async (arguments_: readonly string[], effect: "read" | "write"): Promise<Buffer> => {
    options.signal?.throwIfAborted();
    return await dependencies.process({ executable: options.executable, cwd: candidate.checkout, arguments: arguments_, effect,
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
  };
  if (!/^review-[A-Za-z0-9._-]+$/.test(options.lineage)) throw new Error("Gentle lineage is invalid");
  const statusArguments = ["review", "status", "--contract", contract, "--cwd", candidate.checkout,
    "--agent", "pi", "--lineage", options.lineage, "--next-transition"];
  const observed: unknown = JSON.parse((await invoke(statusArguments, "read")).toString("utf8"));
  const status = statusSchema.parse(observed);
  const selected = offeredReviewerSlot(status);
  if (selected === null) return { status: "provider_transition_required", provider: observed };
  assertCurrentSubject(status, selected, options.lineage);
  const materializeArguments = materializationArguments(selected);
  const completion = selected.submission;
  const location = completion.value.substitution_location;
  assertSubmissionSlot(selected);
  const prompt = await invoke(["review", "capture-result", ...materializeArguments], "read");
  const result = await dependencies.reviewer(prompt, options.signal === undefined ? {} : { signal: options.signal });

  // A completed response cannot authorize submission to a changed slot.
  const current = statusSchema.parse(JSON.parse((await invoke(statusArguments, "read")).toString("utf8")));
  if (!reviewerBindingUnchanged(current, status, selected)) {
    throw new Error("Gentle reviewer binding changed; result was not submitted");
  }
  const stagingDirectory = await mkdtemp(join(tmpdir(), "tesota-gentle-review-"));
  let primaryFailure: unknown;
  let response: unknown;
  try {
    await chmod(stagingDirectory, 0o700);
    const resultFile = join(stagingDirectory, "result.raw");
    await writeFile(resultFile, result.stdout, { mode: 0o600 });
    await chmod(resultFile, 0o600);
    const submissionArguments = completion.argument_tokens.map((value, index) =>
      index === location ? value.replace("{{value}}", resultFile) : value);
    response = JSON.parse((await invoke(["review", completion.operation_token, ...submissionArguments], "write")).toString("utf8"));
  } catch (error) {
    primaryFailure = error;
  }
  try { await rm(stagingDirectory, { recursive: true, force: true }); }
  catch (error) { if (primaryFailure === undefined) throw new Error("Gentle reviewer result cleanup failed", { cause: error }); }
  if (primaryFailure !== undefined) throw primaryFailure;
  return { status: "submitted", provider: response };
}
