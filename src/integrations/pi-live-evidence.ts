import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LIVE_CODEX_MODEL_ID, LIVE_LIMITS, liveProbePasses,
  type LiveCodexRunResult, type LiveCodexTurnResult } from "./pi-live.js";

const implementationFiles = [
  "src/live-codex.ts", "src/integrations/pi-live.ts", "src/integrations/pi-live-evidence.ts", "src/integrations/codex-credentials.ts",
  "dist/live-codex.js", "dist/integrations/pi-live.js", "dist/integrations/pi-live-evidence.js", "dist/integrations/codex-credentials.js",
  "package.json", "bun.lock", "tsconfig.json", "tsconfig.build.json",
] as const;

declare const sourceIdentityBrand: unique symbol;
export type LiveSourceIdentity = Readonly<Record<(typeof implementationFiles)[number], string>> & {
  readonly [sourceIdentityBrand]: true;
};
const capturedIdentities = new WeakSet<object>();

export function liveSourceIdentity(): LiveSourceIdentity {
  // SAFETY: this module enumerates every key, freezes the result and admits only captured identities.
  const identity = Object.freeze(Object.fromEntries(implementationFiles.map((file) =>
    [file, createHash("sha256").update(readFileSync(new URL(`../../${file}`, import.meta.url))).digest("hex")]))) as LiveSourceIdentity;
  capturedIdentities.add(identity);
  return identity;
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
    responseDiagnostic: {
      messageObserved: probe.responseDiagnostic.messageObserved,
      textBlockCount: probe.responseDiagnostic.textBlockCount,
      nonTextBlockCount: probe.responseDiagnostic.nonTextBlockCount,
      thinkingBlockCount: probe.responseDiagnostic.thinkingBlockCount,
      textMatchesExpectedToken: probe.responseDiagnostic.textMatchesExpectedToken,
    },
    requestBudgetExceeded: probe.requestBudgetExceeded,
    deadlineExpired: probe.deadlineExpired,
    settlement: probe.settlement,
    events: [...probe.events],
    providerDiagnostic: {
      httpStatus: probe.providerDiagnostic.httpStatus,
      failureStage: probe.providerDiagnostic.failureStage,
      providerErrorCode: null,
    },
    requestBoundRespected: !probe.requestBudgetExceeded && probe.modelInvocationCount <= LIVE_LIMITS.modelInvocationsPerProbe,
    turnBoundRespected: !probe.deadlineExpired,
    disposition: liveProbePasses(probe, abort) ? "passed" : "failed",
  };
}

/** Only this module's immutable, fixed-file captures can become source identity. */
export function serializeLiveEvidence(
  sourceSha256: LiveSourceIdentity, timestamp: string,
  run: LiveCodexRunResult,
): string {
  if (!capturedIdentities.has(sourceSha256)) throw new Error("Unrecognized live source identity");
  const result = run.experiment;
  const passed = result !== null && liveProbePasses(result.turn, false) &&
    result.abortProbe !== null && liveProbePasses(result.abortProbe, true);
  return JSON.stringify({
    format: "tesota-codex-evidence", version: 9,
    provenance: "machine_generated", timestamp,
    implementation: { binding: "sha256_of_source_and_executed_javascript", sourceSha256 },
    provider: "openai-codex", api: "openai-codex-responses", model: LIVE_CODEX_MODEL_ID,
    authType: "oauth", authenticationMethod: run.authenticationMethod, mode: run.mode, authenticationOutcome: run.authentication.outcome,
    inferenceAttempted: run.inferenceAttempted, limits: LIVE_LIMITS,
    oauthFailureCategory: run.authentication.oauthFailureCategory,
    modelInvocationCount: result === null ? 0 : result.turn.modelInvocationCount + (result.abortProbe?.modelInvocationCount ?? 0),
    turn: result === null ? null : probeEvidence(result.turn, false),
    abortProbe: result?.abortProbe == null ? null : probeEvidence(result.abortProbe, true),
    disposition: run.mode === "auth_only" ?
      run.authentication.outcome === "succeeded" && !run.inferenceAttempted ? "succeeded" : "failed" :
      passed ? "passed" : "failed",
  }, null, 2) + "\n";
}
