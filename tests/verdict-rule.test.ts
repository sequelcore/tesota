import { expect, it } from "vitest";
import { decisions, partlyHolds, verdictTone } from "../src/verification/verdict-rule.js";

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
