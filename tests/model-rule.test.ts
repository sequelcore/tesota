import { expect, it } from "vitest";
import { checksModel, faultVerdict, modelOutcome, reportedTlcRun, runOutcome, staleness, tlcRun, writtenWithCode } from "../src/verification/model-rule.js";

it("reads TLC's exit status: a pass needs a reachable state, a property violation needs 12 to 14, a parse error is the model's", () => {
  expect(tlcRun(false, false, true, 0, 9)).toBe("passed");
  expect(tlcRun(false, false, true, 0, 0)).toBe("vacuous");
  expect(tlcRun(false, false, true, 11, 4)).toBe("deadlocked");
  expect(tlcRun(false, false, true, 12, 13)).toBe("violated");
  expect(tlcRun(false, false, true, 150, 0)).toBe("malformed");
  expect(tlcRun(false, false, true, 75, 1)).toBe("malformed");
  expect(tlcRun(false, false, true, 255, 0)).toBe("not_started");
  expect(tlcRun(false, false, false, -1, 0)).toBe("not_started");
  expect(tlcRun(false, true, true, 0, 9)).toBe("timed_out");
  expect(tlcRun(true, true, true, 0, 9)).toBe("cancelled");
  expect(runOutcome("violated")).toBe("failed");
  expect(runOutcome("malformed")).toBe("failed");
});

it("catches a planted fault only by a violation, and sends back a model whose fault passes or that plants none", () => {
  expect(faultVerdict("violated", false)).toBe("caught");
  expect(faultVerdict("passed", false)).toBe("passes");
  expect(faultVerdict("malformed", false)).toBe("broken");
  expect(faultVerdict("timed_out", false)).toBe("unrun");
  expect(modelOutcome("passed", ["caught", "caught"])).toBe("passed");
  expect(modelOutcome("passed", ["caught", "unrun"])).toBe("passed");
  expect(modelOutcome("passed", ["caught", "passes"])).toBe("failed");
  expect(modelOutcome("passed", ["broken"])).toBe("failed");
  expect(modelOutcome("passed", [])).toBe("vacuous");
  expect(modelOutcome("violated", ["passes"])).toBe("failed");
  expect(modelOutcome("not_started", [])).toBe("not_started");
});

it("checks a touched model unless the session passed the same content, and tells staleness and models written with their code", () => {
  expect(checksModel(true, false)).toBe(true);
  expect(checksModel(true, true)).toBe(false);
  expect(checksModel(false, false)).toBe(false);
  expect(staleness(false, "passed", true, [false, false])).toBe("current");
  expect(staleness(false, "passed", true, [false, true])).toBe("possibly_stale");
  expect(staleness(false, "passed", false, [false])).toBe("unknown");
  expect(staleness(true, "passed", true, [false, true])).toBe("current");
  expect(staleness(true, "passed", false, [true])).toBe("current");
  expect(staleness(true, "failed", true, [false, true])).toBe("possibly_stale");
  expect(writtenWithCode(true, true)).toBe(true);
  expect(writtenWithCode(true, false)).toBe(false);
});

it("keeps deadlocks distinct from declared violations, including continued TLC runs (#762)", () => {
  expect(faultVerdict("deadlocked", false)).toBe("unrun");
  expect(faultVerdict("assumption_failed", false)).toBe("broken");
  expect(faultVerdict("assumption_failed", true)).toBe("unrun");
  expect(runOutcome("assumption_failed")).toBe("failed");
  expect(runOutcome("deadlocked")).toBe("failed");
  expect(tlcRun(false, false, true, 10, 0)).toBe("assumption_failed");
  expect(tlcRun(false, false, true, 13, 4)).toBe("violated");
  expect(tlcRun(false, false, true, 14, 4)).toBe("violated");
  expect(reportedTlcRun("passed", false, true)).toBe("deadlocked");
  expect(reportedTlcRun("deadlocked", true, true)).toBe("violated");
  expect(reportedTlcRun("passed", true, true)).toBe("violated");
  expect(reportedTlcRun("timed_out", true, true)).toBe("timed_out");
});

it("judges each deadlock retry outcome without crediting an error or unfinished exploration (#762)", () => {
  expect(faultVerdict("violated", true)).toBe("caught");
  expect(faultVerdict("passed", true)).toBe("passes");
  expect(faultVerdict("malformed", true)).toBe("unrun");
  expect(faultVerdict("vacuous", true)).toBe("unrun");
  expect(faultVerdict("timed_out", true)).toBe("unrun");
  expect(faultVerdict("cancelled", true)).toBe("unrun");
  expect(faultVerdict("not_started", true)).toBe("unrun");
});
