import { expect, it } from "vitest";
import type { CandidateTaskCheck } from "../src/candidate-task.js";
import { piTaskPasses, type PiTaskResult } from "../src/integrations/pi-task.js";

const before: CandidateTaskCheck = {
  task: "documentation-change", status: "check_failed", provenance: "issued", diagnostics: ["not changed"],
  baseline: "a".repeat(40), writeSetSha256: "1".repeat(64), taskAcceptance: "not_evaluated",
};
const after: CandidateTaskCheck = {
  ...before, status: "passed", writeSetSha256: "2".repeat(64),
};
const current: CandidateTaskCheck = { ...after, provenance: "recorded_untrusted" };
const result: PiTaskResult = {
  status: "completed", modelInvocations: 5, toolCalls: 4, edits: 1,
  checks: [before, after], checksSuppliedToModel: 2, finalCheckSuppliedToModel: true,
  deadlineExpired: false, denied: false, terminalStopReason: "stop", taskAcceptance: "not_evaluated",
};

it("accepts consistent completed task evidence", () => {
  expect(piTaskPasses(result, current)).toBe(true);
});

it("rejects incomplete delivery or a stale current check", () => {
  expect(piTaskPasses({ ...result, finalCheckSuppliedToModel: false }, current)).toBe(false);
  expect(piTaskPasses(result, { ...current, writeSetSha256: "3".repeat(64) })).toBe(false);
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
