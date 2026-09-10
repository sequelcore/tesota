import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIssuedOxlintResult } from "../verification/oxlint.js";
import { PI_VERIFICATION_LIMITS, type PiSessionResult } from "./pi.js";
import { LIVE_CODEX_MODEL_ID } from "./pi-live.js";
import { candidateSatisfiesTask, CANDIDATE_LIMITS, type VerificationCandidate } from "../verification/candidate.js";
import { PI_CANDIDATE_LIMITS } from "./pi.js";
import type { Applicability } from "../verification/oxlint.js";

export const VERIFICATION_FIXTURE = "experiments/codex/fixtures/verification.ts";
export const VERIFICATION_FIXTURE_SOURCE = "debugger;\n";

export function verificationProbePasses(result: PiSessionResult): boolean {
  return result.status === "completed" && result.terminalStopReason === "stop" &&
    !result.abortRequested && !result.budgetExceeded && !result.deadlineExpired &&
    result.modelInvocationCount === 2 && result.verificationInvocationCount === 1 && result.toolExecutionStartCount === 1 &&
    result.resultSuppliedToContinuation && result.response.trim() === "TESOTA_VERIFICATION_OK" &&
    !result.events.some((event) => event.type === "verification_denied") &&
    result.issuedEvidence?.status === "check_failed" && isIssuedOxlintResult(result.issuedEvidence) &&
    result.issuedEvidence.binding.source.file === resolve(VERIFICATION_FIXTURE) &&
    result.issuedEvidence.binding.source.sha256 === createHash("sha256").update(VERIFICATION_FIXTURE_SOURCE).digest("hex");
}

const identities = new WeakSet<object>();

/** Capture the executable path's fixed files before authentication or inference. */
export function verificationSourceIdentity(mode: "verification" | "candidate" = "verification"): Readonly<Record<string, string>> {
  const modules = ["live-verification", "integrations/pi", "integrations/pi-live", "integrations/pi-verification-evidence",
    "integrations/codex-credentials", "verification/oxlint", "verification/oxlint-input", "verification/oxlint-result", "verification/evidence", "verification/candidate"];
  if (mode === "candidate") modules.push("live-candidate");
  const files = [...modules.flatMap((module) => [`src/${module}.ts`, `dist/${module}.js`]),
    "package.json", "bun.lock", "tsconfig.json", "tsconfig.build.json", VERIFICATION_FIXTURE];
  const identity = Object.freeze(Object.fromEntries(files.map((file) =>
    [file, createHash("sha256").update(readFileSync(new URL(`../../${file}`, import.meta.url))).digest("hex")])));
  identities.add(identity);
  return identity;
}

export interface CandidateAssessment {
  readonly prior: Applicability;
  readonly current: Applicability;
}

export function candidateProbePasses(result: PiSessionResult, candidate: VerificationCandidate, assessment: CandidateAssessment): boolean {
  const [before, after] = candidate.checks;
  return result.status === "completed" && result.terminalStopReason === "stop" &&
    !result.abortRequested && !result.budgetExceeded && !result.deadlineExpired &&
    result.modelInvocationCount === 4 && result.verificationInvocationCount === 2 &&
    result.toolExecutionStartCount === 3 && result.verificationResultsSupplied === 2 &&
    result.response.trim() === "TESOTA_CANDIDATE_OK" &&
    !result.events.some((event) => event.type === "verification_denied" || event.type === "candidate_edit_denied") &&
    candidate.edits === 1 && candidateSatisfiesTask(candidate.source) &&
    before?.status === "check_failed" && after?.status === "passed" &&
    isIssuedOxlintResult(before) && isIssuedOxlintResult(after) &&
    assessment.prior.status === "stale" && assessment.current.status === "applicable" &&
    assessment.prior.provenance === "issued" && assessment.current.provenance === "issued";
}

export function serializeCandidateProbe(result: PiSessionResult | null, candidate: VerificationCandidate,
  assessment: CandidateAssessment | null, identity: Readonly<Record<string, string>>, timestamp: string, evidenceSaved: boolean): string {
  if (!identities.has(identity)) throw new Error("Unrecognized candidate probe identity");
  return JSON.stringify({ format: "tesota-candidate-probe", version: 3, timestamp, implementation: identity,
    provider: "openai-codex", api: "openai-codex-responses", model: LIVE_CODEX_MODEL_ID, authenticationMethod: "stored",
    limits: { ...PI_CANDIDATE_LIMITS, ...CANDIDATE_LIMITS },
    status: result?.status ?? "failed", modelInvocationCount: result?.modelInvocationCount ?? 0,
    verificationInvocationCount: result?.verificationInvocationCount ?? 0, edits: candidate.edits,
    toolExecutionStartCount: result?.toolExecutionStartCount ?? 0, abortRequested: result?.abortRequested ?? false,
    verificationResultsSupplied: result?.verificationResultsSupplied ?? 0,
    responseMatchesExpectedToken: result?.response.trim() === "TESOTA_CANDIDATE_OK",
    candidateSatisfiesTask: candidateSatisfiesTask(candidate.source),
    terminalStopReason: result?.terminalStopReason ?? null, deadlineExpired: result?.deadlineExpired ?? false,
    budgetExceeded: result?.budgetExceeded ?? false, taskAcceptance: "not_evaluated",
    checks: candidate.checks.map((check) => ({ status: check.status, process: check.process,
      sourceSha256: check.binding?.source.sha256 ?? null })),
    applicability: assessment === null ? null : { prior: assessment.prior.status, current: assessment.current.status },
    evidenceSaved, events: result?.events.map((event) => event.type) ?? [],
    deniedInputs: result?.events.filter((event) => event.type === "verification_denied")
      .map((event) => ({ matchesCandidateName: event.input === "candidate.ts" })) ?? [],
    disposition: result !== null && assessment !== null && evidenceSaved && candidateProbePasses(result, candidate, assessment) ? "passed" : "failed",
  }, null, 2) + "\n";
}

/** No model text, requested paths, raw errors or provider objects enter this record. */
export function serializeVerificationProbe(result: PiSessionResult | null, identity: Readonly<Record<string, string>>,
  timestamp: string, evidenceSaved: boolean): string {
  if (!identities.has(identity)) throw new Error("Unrecognized verification probe identity");
  return JSON.stringify({ format: "tesota-verification-probe", version: 2, timestamp,
    implementation: identity, provider: "openai-codex", api: "openai-codex-responses", model: LIVE_CODEX_MODEL_ID,
    authenticationMethod: "stored", limits: PI_VERIFICATION_LIMITS,
    status: result?.status ?? "failed", modelInvocationCount: result?.modelInvocationCount ?? 0,
    verificationInvocationCount: result?.verificationInvocationCount ?? 0,
    toolExecutionStartCount: result?.toolExecutionStartCount ?? 0,
    resultSuppliedToContinuation: result?.resultSuppliedToContinuation ?? false,
    terminalStopReason: result?.terminalStopReason ?? null, abortRequested: result?.abortRequested ?? false,
    budgetExceeded: result?.budgetExceeded ?? false, deadlineExpired: result?.deadlineExpired ?? false,
    verificationStatus: result?.verification?.status ?? null,
    events: result?.events.map((event) => event.type) ?? [],
    evidence: evidenceSaved ? "verification.json" : null,
    taskAcceptance: "not_evaluated",
    disposition: result !== null && evidenceSaved && verificationProbePasses(result) ? "passed" : "failed",
  }, null, 2) + "\n";
}
