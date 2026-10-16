import { expect, test } from "bun:test";
import { median, overBudget } from "../scripts/budget.ts";

test("the median is the middle sample, whatever order the samples came in", () => {
  expect(median([30, 10, 20])).toBe(20);
  expect(median([9, 1, 5, 400, 7])).toBe(7);
  expect(() => median([])).toThrow();
});

test("a measurement over its limit fails the budget, and one at its limit keeps to it", () => {
  expect(overBudget({ startupMs: 50, binaryBytes: 100 }, { startupMs: 50, binaryBytes: 100 })).toEqual([]);
  expect(overBudget({ startupMs: 50.1, binaryBytes: 100 }, { startupMs: 50, binaryBytes: 100 }))
    .toEqual(["startupMs: 50.1 is over its limit of 50"]);
  expect(overBudget({ startupMs: 10, binaryBytes: 101 }, { startupMs: 50, binaryBytes: 100 }))
    .toEqual(["binaryBytes: 101 is over its limit of 100"]);
});

test("a platform with no limit set fails until one is measured and recorded", () => {
  expect(overBudget({ startupMs: 10, binaryBytes: 100 }, { startupMs: null, binaryBytes: 100 }))
    .toEqual(["startupMs: no limit set (measured 10)"]);
});
