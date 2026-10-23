import { expect, it } from "vitest";
import { checksModel, faultVerdict, modelOutcome, runOutcome, staleness, tlcRun, writtenWithCode } from "../src/verification/model-rule.js";

it("reads TLC's exit status: a pass needs a reachable state, a violation needs 10 to 14, a parse error is the model's", () => {
  expect(tlcRun(false, false, true, 0, 9)).toBe("passed");
  expect(tlcRun(false, false, true, 0, 0)).toBe("vacuous");
  expect(tlcRun(false, false, true, 11, 4)).toBe("violated");
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
  expect(faultVerdict("violated")).toBe("caught");
  expect(faultVerdict("passed")).toBe("passes");
  expect(faultVerdict("malformed")).toBe("broken");
  expect(faultVerdict("timed_out")).toBe("unrun");
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
