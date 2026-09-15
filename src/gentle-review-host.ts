import * as z from "zod";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { inspectCandidateCheckout } from "./candidate-checkout.js";
import { assertGentleCapabilities, digestGentleExecutable, GENTLE_REVIEW_CONTRACT } from "./integrations/gentle-capabilities.js";
import { runGentleProcess, type GentleProcessRequest } from "./integrations/gentle-process.js";
import { runOpaquePiReviewer } from "./integrations/pi-opaque-reviewer.js";

const contract = GENTLE_REVIEW_CONTRACT;
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

export type GentleEscalationCause =
  | "unknown_causality"
  | "insufficient_evidence"
  | "missing_refuter_outcome"
  | "targeted_validator_rejected"
  | "correction_budget_exceeded"
  | "unresolved_severe_findings";

export interface GentleEscalationEvidence {
  readonly cause: GentleEscalationCause;
  readonly finding_ids: readonly string[];
  readonly refuter_outcomes?: readonly {
    readonly finding_id: string;
    readonly outcome: "corroborated" | "refuted" | "inconclusive";
    readonly proof: string;
  }[] | undefined;
}

const escalationSchema: z.ZodType<GentleEscalationEvidence> = z.object({
  cause: z.enum([
    "unknown_causality", "insufficient_evidence", "missing_refuter_outcome",
    "targeted_validator_rejected", "correction_budget_exceeded", "unresolved_severe_findings",
  ]),
  finding_ids: z.array(z.string().min(1)),
  refuter_outcomes: z.array(z.object({
    finding_id: z.string().min(1),
    outcome: z.enum(["corroborated", "refuted", "inconclusive"]),
    proof: z.string().min(1),
  })).optional(),
});

export interface GentleReviewerFinding {
  readonly id: string;
  readonly lens: string;
  readonly location: string;
  readonly severity: "BLOCKER" | "CRITICAL" | "WARNING" | "SUGGESTION";
  readonly claim: string;
  readonly proof_refs: readonly string[];
  readonly evidence_class?: "deterministic" | "inferential" | "insufficient" | undefined;
  readonly causal_disposition?: "introduced" | "behavior-activated" | "worsened" | "pre-existing" | "base-only" | "unknown" | undefined;
}

export interface GentleReviewerEvidence {
  readonly lens: string;
  readonly findings: readonly GentleReviewerFinding[];
  readonly evidence: readonly string[];
  readonly result_hash: string;
}

export interface GentleReviewClosureEvidence {
  readonly lineage_id: string;
  readonly state: "approved" | "correction_required" | "escalated";
  readonly store_revision: string;
  readonly reviewer_results?: readonly GentleReviewerEvidence[] | undefined;
  readonly escalation?: GentleEscalationEvidence | undefined;
}

const findingSchema: z.ZodType<GentleReviewerFinding> = z.object({
  id: z.string().min(1), lens: z.string().min(1), location: z.string().min(1),
  severity: z.enum(["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"]), claim: z.string().min(1),
  proof_refs: z.array(z.string().min(1)).min(1),
  evidence_class: z.enum(["deterministic", "inferential", "insufficient"]).optional(),
  causal_disposition: z.enum(["introduced", "behavior-activated", "worsened", "pre-existing", "base-only", "unknown"]).optional(),
});
const reviewerEvidenceSchema: z.ZodType<GentleReviewerEvidence> = z.object({
  lens: z.string().min(1), findings: z.array(findingSchema), evidence: z.array(z.string().min(1)), result_hash: hash,
});
const closureSchema = z.object({
  schema: z.literal("gentle-ai.review-last-event-closure/v1"),
  operation: z.enum(["review/capture-result", "review.capture-correction-plan", "review.capture-refuter", "review/capture-validation"]),
  lineage_id: z.string().min(1),
  state: z.enum(["approved", "correction_required", "escalated"]),
  store_revision: hash,
  acknowledgement: z.record(z.string(), z.unknown()).optional(),
  reviewer_results: z.array(reviewerEvidenceSchema).optional(),
  escalation: escalationSchema.optional(),
}).superRefine((closure, context) => {
  const approved = closure.state === "approved";
  if (approved !== (closure.reviewer_results !== undefined) || approved !== (closure.acknowledgement !== undefined)) {
    context.addIssue({ code: "custom", path: ["reviewer_results"], message: "Gentle approved closure requires reviewer evidence and acknowledgement" });
  }
  if ((closure.state === "escalated") !== (closure.escalation !== undefined)) {
    context.addIssue({ code: "custom", path: ["escalation"], message: "Gentle closure escalation must match escalated state" });
  }
});

function projectClosureEvidence(response: unknown): GentleReviewClosureEvidence | undefined {
  if (typeof response !== "object" || response === null || !("schema" in response) ||
      response.schema !== "gentle-ai.review-last-event-closure/v1") return undefined;
  const closure = closureSchema.parse(response);
  return {
    lineage_id: closure.lineage_id, state: closure.state, store_revision: closure.store_revision,
    ...(closure.reviewer_results === undefined ? {} : { reviewer_results: closure.reviewer_results }),
    ...(closure.escalation === undefined ? {} : { escalation: closure.escalation }),
  };
}
// This adapter consumes transport fields; Gentle owns the complete review
// schema, findings, authority validation and admission decision.
const statusSchema = z.object({
  schema: z.literal("gentle-ai.review-integration.status/v7"),
  contract: z.literal(contract),
  operation: z.literal("review.status"),
  action: z.enum(["start", "validate", "recover", "maintainer_action", "select_lineage", "repair_authority", "stop", "collect", "execute"]),
  authority: z.object({
    version: z.literal("compact-v2"), lineage_id: z.string().min(1), revision: hash, state: z.string().min(1),
  }).optional(),
  target_identity: hash,
  next_transition: z.object({ kind: z.string(), collect: z.object({ inputs: z.array(z.unknown()).min(1).max(4) }).optional() }).optional(),
  escalation: escalationSchema.optional(),
}).superRefine((status, context) => {
  const escalated = status.authority?.state === "escalated";
  if (escalated !== (status.escalation !== undefined)) {
    context.addIssue({ code: "custom", path: ["escalation"], message: "Gentle escalation must match escalated authority" });
  }
});

export interface GentleReviewRelayResult {
  readonly status: "submitted" | "provider_transition_required";
  readonly provider: unknown;
  readonly escalation?: GentleEscalationEvidence;
  readonly closure?: GentleReviewClosureEvidence;
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
  readonly digestExecutable: (executable: string) => Promise<string>;
}

type GentleStatus = z.infer<typeof statusSchema>;
type ReviewerSlot = z.infer<typeof slot>;

function offeredReviewerSlot(status: GentleStatus): ReviewerSlot | null {
  if (status.action === "stop" || status.next_transition?.kind !== "collect") return null;
  const offered = status.next_transition.collect?.inputs[0];
  if (typeof offered !== "object" || offered === null || !("name" in offered) || offered.name !== "reviewer_result") return null;
  return slot.parse(offered);
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
  dependencies: GentleReviewRelayDependencies = {
    inspect: inspectCandidateCheckout, process: runGentleProcess, reviewer: runOpaquePiReviewer,
    digestExecutable: digestGentleExecutable,
  },
): Promise<GentleReviewRelayResult> {
  if (!isAbsolute(options.executable)) throw new Error("Gentle requires an absolute executable path");
  const candidate = await dependencies.inspect(options.candidate);
  let admittedExecutableDigest: string | undefined;
  const invoke = async (arguments_: readonly string[], effect: "read" | "write"): Promise<Buffer> => {
    options.signal?.throwIfAborted();
    if (admittedExecutableDigest !== undefined &&
        await dependencies.digestExecutable(options.executable) !== admittedExecutableDigest) {
      throw new Error("Gentle executable identity changed after capability negotiation");
    }
    const output = await dependencies.process({ executable: options.executable, cwd: candidate.checkout, arguments: arguments_, effect,
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
    if (admittedExecutableDigest !== undefined &&
        await dependencies.digestExecutable(options.executable) !== admittedExecutableDigest) {
      throw new Error("Gentle executable identity changed during invocation");
    }
    return output;
  };
  if (!/^review-[A-Za-z0-9._-]+$/.test(options.lineage)) throw new Error("Gentle lineage is invalid");
  const executableDigest = await dependencies.digestExecutable(options.executable);
  const capabilitiesObserved: unknown = JSON.parse((await invoke([
    "review", "capabilities", "--contract", contract,
  ], "read")).toString("utf8"));
  const currentExecutableDigest = await dependencies.digestExecutable(options.executable);
  if (executableDigest !== currentExecutableDigest) throw new Error("Gentle executable identity changed during capability negotiation");
  assertGentleCapabilities(capabilitiesObserved, currentExecutableDigest);
  admittedExecutableDigest = currentExecutableDigest;
  const statusArguments = ["review", "status", "--contract", contract, "--cwd", candidate.checkout,
    "--agent", "pi", "--lineage", options.lineage, "--next-transition"];
  const observed: unknown = JSON.parse((await invoke(statusArguments, "read")).toString("utf8"));
  const status = statusSchema.parse(observed);
  const selected = offeredReviewerSlot(status);
  if (selected === null) return {
    status: "provider_transition_required", provider: observed,
    ...(status.escalation === undefined ? {} : { escalation: status.escalation }),
  };
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
  const closure = projectClosureEvidence(response);
  return { status: "submitted", provider: response, ...(closure === undefined ? {} : { closure }) };
}
