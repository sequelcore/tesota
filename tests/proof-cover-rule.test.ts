import { expect, it } from "vitest";
import { proofCovered } from "../src/verification/proof-cover-rule.js";

it("covers a line only inside a proved function whose contract gained no assumption", () => {
  expect(proofCovered(3, [2, 7], [5, 9], [true, true], [false, false])).toBe(true);
  expect(proofCovered(6, [2, 7], [5, 9], [true, true], [false, false])).toBe(false);
  expect(proofCovered(3, [2], [5], [false], [false])).toBe(false);
  expect(proofCovered(3, [2], [5], [true], [true])).toBe(false);
  expect(proofCovered(3, [], [], [], [])).toBe(false);
});
