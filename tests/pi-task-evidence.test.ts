import { expect, it } from "vitest";
import type { CandidateTaskCheck } from "../src/candidate-task.js";
import { PI_TASK_LIMITS, piTaskPasses, type PiTaskResult } from "../src/integrations/pi-task.js";

const before: CandidateTaskCheck = {
  task: "typescript-change", status: "check_failed", outcome: "check_failed", settlement: "observed",
  provenance: "issued", diagnostics: ["not changed"], typecheck: null, sourceInputsSha256: "d".repeat(64),
  baseline: "a".repeat(40), writeSetSha256: "1".repeat(64), taskAcceptance: "not_evaluated",
};
const after: CandidateTaskCheck = {
  ...before, status: "passed", outcome: "passed", writeSetSha256: "2".repeat(64),
  typecheck: { profile: "typescript-no-emit/v1", status: "passed", reason: null, diagnostics: [], process: "exited",
    container: "absent", binding: {} as never, authority: "none", provenance: "issued" },
};
const current: CandidateTaskCheck = { ...after, provenance: "recorded_untrusted" };
const result: PiTaskResult = {
  status: "completed", modelInvocations: 5, toolCalls: 4, edits: 1,
  checks: [before, after], checksSuppliedToModel: 2, finalCheckSuppliedToModel: true,
  deadlineExpired: false, denied: false, terminalStopReason: "stop", settlement: "observed", taskAcceptance: "not_evaluated",
};

it("keeps a finite task window that accommodates the qualified Windows profile", () => {
  expect(PI_TASK_LIMITS.sessionMs).toBe(300_000);
});

it("accepts consistent completed task evidence", () => {
  expect(piTaskPasses(result, current)).toBe(true);
});

it("rejects incomplete delivery or a stale current check", () => {
  expect(piTaskPasses({ ...result, finalCheckSuppliedToModel: false }, current)).toBe(false);
  expect(piTaskPasses(result, { ...current, writeSetSha256: "3".repeat(64) })).toBe(false);
});

it("rejects changed or absent source bindings across execution evidence", () => {
  expect(piTaskPasses(result, { ...current, sourceInputsSha256: "e".repeat(64) })).toBe(false);
  expect(piTaskPasses({ ...result, checks: [{ ...before, sourceInputsSha256: "e".repeat(64) }, after] }, current)).toBe(false);
  expect(piTaskPasses({ ...result, checks: [{ ...before, sourceInputsSha256: null },
    { ...after, sourceInputsSha256: null }] }, { ...current, sourceInputsSha256: null })).toBe(false);
});

it("rejects a result whose session or checks have unconfirmed settlement", () => {
  expect(piTaskPasses({ ...result, settlement: "unconfirmed" }, current)).toBe(false);
  expect(piTaskPasses({ ...result, checks: [{ ...before, settlement: "unconfirmed" }, after] }, current)).toBe(false);
});

it("rejects an accepted result", () => {
  const invalidResult = { ...result, taskAcceptance: "accepted" } as unknown as PiTaskResult;
  expect(piTaskPasses(invalidResult, current)).toBe(false);
});

it("rejects an accepted issued check", () => {
  const acceptedCheck = { ...after, taskAcceptance: "accepted" } as unknown as CandidateTaskCheck;
  const invalidResult = { ...result, checks: [before, acceptedCheck] } as unknown as PiTaskResult;
  expect(piTaskPasses(invalidResult, current)).toBe(false);
});

it("rejects an accepted current check", () => {
  const acceptedCurrent = { ...current, taskAcceptance: "accepted" } as unknown as CandidateTaskCheck;
  expect(piTaskPasses(result, acceptedCurrent)).toBe(false);
});

it("rejects an issued rather than recorded-untrusted current check", () => {
  const issuedCurrent = { ...current, provenance: "issued" } as unknown as CandidateTaskCheck;
  expect(piTaskPasses(result, issuedCurrent)).toBe(false);
});
