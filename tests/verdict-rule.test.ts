import { expect, it } from "vitest";
import { decisions } from "../src/verification/verdict-rule.js";

it("counts only what the checks established, never a model's opinion", () => {
  expect(decisions([])).toBe(0);
  expect(decisions(["holds", "gap", "opinion", "opinion"])).toBe(0);
  expect(decisions(["decide", "opinion", "decide", "gap"])).toBe(2);
});
