import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as z from "zod";

export const GENTLE_AI_VERSION = "2.8.0";
export const GENTLE_REVIEW_CONTRACT = "gentle-ai.review-integration/v2";

const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const featureSchema = z.object({
  name: z.string().min(1),
  supported: z.boolean(),
  requires: z.array(z.string().min(1)),
});
const capabilitiesSchema = z.object({
  schema: z.literal("gentle-ai.review-integration.capabilities/v2.5"),
  contract: z.literal(GENTLE_REVIEW_CONTRACT),
  protocol: z.object({ major: z.literal(2), minor: z.literal(5) }),
  package: z.object({
    name: z.literal("gentle-ai"),
    version: z.string().min(1),
    release_channel: z.literal("stable"),
  }),
  executable: z.object({
    sha256: hashSchema,
    evidence: z.literal("self-reported"),
    verification: z.literal("compare-with-published-manifest"),
  }),
  operations: z.array(z.string().min(1)),
  schemas: z.array(z.string().min(1)),
  features: z.object({ mandatory: z.array(featureSchema), optional: z.array(featureSchema) }),
});

const requiredOperations = [
  "review.capabilities", "review.repair", "review.start", "review.status", "review.validate",
] as const;

// This is the complete non-legacy v2.8 surface that supports Tesota's qualified
// immutable review, correction, validation, and scope-change recovery paths.
const requiredFeatures = [
  "compact_v2_authority", "immutable_snapshot", "repository_independent_capabilities",
  "restart_safe_projection", "target_scoped_status", "uniform_failure_envelope",
  "base_ref_workspace_overlay", "bounded_process_waits", "classified_authority_repair",
  "native_frozen_candidate_context", "native_low_risk_verification", "native_next_transition",
  "opaque_repository_context", "provider_artifact_admission", "provider_targeted_validation_request",
  "recovered_correction_evidence", "risk_reasons", "scope_change_diagnostics",
  "validating_result_reopen", "provider_bound_native_git_context", "provider_submission_descriptors",
] as const;

export async function digestGentleExecutable(executable: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(executable)) digest.update(chunk);
  return `sha256:${digest.digest("hex")}`;
}

/** Negotiate only the current stable provider and bind its self-report to the invoked file. */
export function assertGentleCapabilities(observed: unknown, executableDigest: string): void {
  const capabilities = capabilitiesSchema.parse(observed);
  if (capabilities.package.version !== GENTLE_AI_VERSION) {
    throw new Error(`Tesota requires Gentle AI ${GENTLE_AI_VERSION}`);
  }
  if (capabilities.executable.sha256 !== executableDigest) {
    throw new Error("Gentle executable identity changed");
  }
  const operations = new Set(capabilities.operations);
  for (const operation of requiredOperations) {
    if (!operations.has(operation)) throw new Error(`Gentle required operation is unavailable: ${operation}`);
  }
  if (!capabilities.schemas.includes("gentle-ai.review-integration.status/v7")) {
    throw new Error("Gentle status v7 schema is unavailable");
  }
  const entries = [...capabilities.features.mandatory, ...capabilities.features.optional];
  const features = new Map(entries.map((feature) => [feature.name, feature]));
  if (features.size !== entries.length) throw new Error("Gentle capability names are not unique");
  for (const feature of requiredFeatures) {
    if (features.get(feature)?.supported !== true) throw new Error(`Gentle required feature is unavailable: ${feature}`);
  }
}
