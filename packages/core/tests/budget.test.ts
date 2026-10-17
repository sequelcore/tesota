import { expect, test } from "bun:test";
import { type Measurements, median, overBudget } from "../scripts/budget.ts";

const measured = (values: Partial<Measurements>): Measurements => ({ startupMs: 0, binaryBytes: 0, loopMs: 0, loopRssBytes: 0, baseMs: 0, syncMs: 0, syncCount: 0, settleMs: 0, resumeMs: 0, sessionBytes: 0, firstFrameMs: 0, shellRssBytes: 0, ...values });

test("the median is the middle sample, whatever order the samples came in", () => {
  expect(median([30, 10, 20])).toBe(20);
  expect(median([9, 1, 5, 400, 7])).toBe(7);
  expect(() => median([])).toThrow();
});

test("a measurement over its limit fails the budget, and one at its limit keeps to it", () => {
  expect(overBudget(measured({ startupMs: 50, binaryBytes: 100 }), { startupMs: 50, binaryBytes: 100 })).toEqual([]);
  expect(overBudget(measured({ startupMs: 50.1, binaryBytes: 100 }), { startupMs: 50, binaryBytes: 100 }))
    .toEqual(["startupMs: 50.1 is over its limit of 50"]);
  expect(overBudget(measured({ startupMs: 10, binaryBytes: 101 }), { startupMs: 50, binaryBytes: 100 }))
    .toEqual(["binaryBytes: 101 is over its limit of 100"]);
});

test("a platform with no limit set fails until one is measured and recorded", () => {
  expect(overBudget(measured({ startupMs: 10, binaryBytes: 100 }), { startupMs: null, binaryBytes: 100 }))
    .toEqual(["startupMs: no limit set (measured 10)"]);
});

test("a measurement without a limit is reported, not checked", () => {
  expect(overBudget(measured({ loopMs: 99_999 }), { startupMs: 50 })).toEqual([]);
});
