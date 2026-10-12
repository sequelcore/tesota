import { expect, it } from "vitest";
import { decisions, partlyHolds } from "../src/verification/verdict-rule.js";

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
