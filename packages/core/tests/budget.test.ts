import { expect, test } from "bun:test";
import { type Measurements, median, overBudget } from "../scripts/budget.ts";

const measured = (values: Partial<Measurements>): Measurements => ({ startupMs: 0, binaryBytes: 0, loopMs: 0, loopRssBytes: 0, baseMs: 0, syncMs: 0, syncCount: 0, settleMs: 0, resumeMs: 0, sessionBytes: 0, firstFrameMs: 0, firstFrameRatio: 0, firstFrameResumeRatio: 0, shellRssBytes: 0, ...values });

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

test("a measurement over its limit only in the first attempt passes after a retry", () => {
  expect(overBudget(measured({ firstFrameMs: 197.4 }), { firstFrameMs: 180 }, measured({ firstFrameMs: 180 })))
    .toEqual([]);
});

test("a measurement over its limit in both attempts fails with both values", () => {
  expect(overBudget(measured({ firstFrameMs: 197.4 }), { firstFrameMs: 180 }, measured({ firstFrameMs: 188.2 })))
    .toEqual(["firstFrameMs: 197.4 then 188.2 is over its limit of 180"]);
});

test("a measurement within its limit needs no retry", () => {
  expect(overBudget(measured({ firstFrameMs: 180 }), { firstFrameMs: 180 })).toEqual([]);
});

test("a retry cannot pass a measurement with no limit set", () => {
  expect(overBudget(measured({ firstFrameMs: 197.4 }), { firstFrameMs: null }, measured({ firstFrameMs: 0 })))
    .toEqual(["firstFrameMs: no limit set (measured 197.4)"]);
});

test("each measurement can pass in a different attempt", () => {
  expect(overBudget(measured({ firstFrameMs: 197.4, startupMs: 50 }), { firstFrameMs: 180, startupMs: 50 },
    measured({ firstFrameMs: 180, startupMs: 50.1 }))).toEqual([]);
});

test("a first frame slowed with the startup keeps to a limit on their ratio, and one slowed alone does not", () => {
  expect(overBudget(measured({ startupMs: 17.5, firstFrameMs: 200.1, firstFrameRatio: 11.43 }), { firstFrameRatio: 12 })).toEqual([]);
  expect(overBudget(measured({ startupMs: 10, firstFrameMs: 130, firstFrameRatio: 13 }), { firstFrameRatio: 12 }))
    .toEqual(["firstFrameRatio: 13 is over its limit of 12"]);
});
