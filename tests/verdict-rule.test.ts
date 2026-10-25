import { expect, it } from "vitest";
import { decisions, methodStanding, partlyHolds, runStanding, verdictTone } from "../src/verification/verdict-rule.js";

it("counts only what the checks established, never a model's opinion", () => {
  expect(decisions([])).toBe(0);
  expect(decisions(["holds", "gap", "opinion", "opinion"])).toBe(0);
  expect(decisions(["decide", "opinion", "decide", "gap"])).toBe(2);
});

it("asks a summary to say how many of a check's findings hold when one needs the operator or is a gap", () => {
  expect(partlyHolds([])).toBe(false);
  expect(partlyHolds(["holds", "holds", "opinion"])).toBe(false);
  expect(partlyHolds(["holds", "gap"])).toBe(true);
  expect(partlyHolds(["decide", "holds"])).toBe(true);
});

it("colors a verdict green only when nothing needs the operator and nothing is a gap, red only when a check failed", () => {
  expect(verdictTone(0, false, 0)).toBe("success");
  expect(verdictTone(0, false, 1)).toBe("warning");
  expect(verdictTone(2, false, 0)).toBe("warning");
  expect(verdictTone(1, true, 3)).toBe("error");
});

it("sums up a method as holding only when every run held outright (#591)", () => {
  expect(methodStanding(2, 0, 0, 2)).toBe("holds");
  expect(methodStanding(1, 0, 1, 2)).toBe("partly");
  expect(methodStanding(0, 1, 0, 1)).toBe("partly");
  expect(methodStanding(0, 0, 1, 2)).toBe("fails");
  expect(methodStanding(0, 0, 0, 1)).toBe("none");
  expect(methodStanding(0, 0, 0, 0)).toBe("none");
});

it("calls a run verified only with passing evidence, every changed path covered, no gap, no decision and no stop (#668)", () => {
  expect(runStanding(true, false, 0, false, 1, 0, [true], [false], [false])).toBe("verified");
  expect(runStanding(true, false, 0, false, 1, 0, [false], [true], [true])).toBe("verified");
  expect(runStanding(true, false, 0, false, 1, 0, [false], [true], [false])).toBe("incomplete");
  expect(runStanding(true, false, 0, false, 1, 0, [false], [false], [true])).toBe("incomplete");
  expect(runStanding(true, false, 0, false, 1, 1, [true], [false], [false])).toBe("incomplete");
  expect(runStanding(true, false, 0, false, 0, 0, [], [], [])).toBe("unverified");
  expect(runStanding(false, false, 0, false, 3, 0, [], [], [])).toBe("unchanged");
  expect(runStanding(true, false, 1, false, 1, 0, [], [], [])).toBe("incomplete");
  expect(runStanding(true, false, 1, true, 1, 0, [], [], [])).toBe("failed");
  expect(runStanding(true, true, 0, false, 1, 0, [], [], [])).toBe("incomplete");
  expect(runStanding(false, true, 0, true, 0, 0, [], [], [])).toBe("failed");
});
