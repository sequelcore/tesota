import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { classifyLiveOAuthFailure, LIVE_CODEX_MODEL_ID, LIVE_LIMITS, liveProbePasses,
  type LiveCodexExperimentResult, type LiveCodexTurnResult } from "./pi-live.js";

const implementationFiles = [
  "src/live-codex.ts", "src/integrations/pi-live.ts", "src/integrations/pi-live-evidence.ts",
  "dist/live-codex.js", "dist/integrations/pi-live.js", "dist/integrations/pi-live-evidence.js",
  "package.json", "bun.lock", "tsconfig.json", "tsconfig.build.json",
] as const;

export function liveSourceIdentity(): Readonly<Record<string, string>> {
  return Object.fromEntries(implementationFiles.map((file) =>
    [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
}

/** Explicit allowlist; never spread a provider/session/result object into evidence. */
function probeEvidence(probe: LiveCodexTurnResult, abort: boolean) {
  return {
    status: probe.status,
    modelInvocationCount: probe.modelInvocationCount,
    invocationAttempts: probe.invocationAttempts,
    toolExecutionStartCount: probe.toolExecutionStartCount,
    streamUpdateCount: probe.streamUpdateCount,
    terminalStopReason: probe.terminalStopReason,
    terminalObserved: probe.terminalObserved,
    abortRequested: probe.abortRequested,
    taskAcceptance: probe.taskAcceptance,
    responseMatchesExpectedToken: probe.responseMatchesExpectedToken,
    requestBudgetExceeded: probe.requestBudgetExceeded,
    deadlineExpired: probe.deadlineExpired,
    settlement: probe.settlement,
    events: [...probe.events],
    requestBoundRespected: !probe.requestBudgetExceeded && probe.modelInvocationCount <= LIVE_LIMITS.modelInvocationsPerProbe,
    turnBoundRespected: !probe.deadlineExpired,
    disposition: liveProbePasses(probe, abort) ? "passed" : "failed",
  };
}

/** A fixed M3.1a artifact, not a general evidence store. Null means no model probe ran. */
export function serializeLiveEvidence(
  sourceSha256: Readonly<Record<string, string>>, timestamp: string,
  result: LiveCodexExperimentResult | null,
  failure?: unknown,
): string {
  const passed = result !== null && liveProbePasses(result.turn, false) &&
    result.abortProbe !== null && liveProbePasses(result.abortProbe, true);
  return JSON.stringify({
    format: "tesota-m31a-live-evidence", version: 2,
    provenance: "machine_generated", timestamp,
    implementation: { binding: "sha256_of_source_and_executed_javascript", sourceSha256 },
    provider: "openai-codex", api: "openai-codex-responses", model: LIVE_CODEX_MODEL_ID,
    authType: "oauth", limits: LIVE_LIMITS,
    oauthFailureCategory: result === null ? classifyLiveOAuthFailure(failure) : null,
    modelInvocationCount: result === null ? 0 : result.turn.modelInvocationCount + (result.abortProbe?.modelInvocationCount ?? 0),
    turn: result === null ? null : probeEvidence(result.turn, false),
    abortProbe: result?.abortProbe == null ? null : probeEvidence(result.abortProbe, true),
    disposition: passed ? "passed" : "failed",
  }, null, 2) + "\n";
}
