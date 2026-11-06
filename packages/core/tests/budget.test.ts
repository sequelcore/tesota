import { expect, test } from "bun:test";
import { type Measurements, median, overBudget, ratio, slowerThanBase } from "../scripts/budget.ts";
import budgets from "../budgets.json" with { type: "json" };

const measured = (values: Partial<Measurements>): Measurements => ({ startupMs: 0, binaryBytes: 0, loopMs: 0, loopRssBytes: 0, baseMs: 0, syncMs: 0, syncCount: 0, settleMs: 0, resumeMs: 0, sessionBytes: 0, firstFrameMs: 0, shellRssBytes: 0, ...values });
const attempt = (change: Partial<Measurements>, base: Partial<Measurements>) => ({ change: measured(change), base: measured(base) });

test("a slow Windows runner passes while a change that slows the loop by half fails", () => {
  // CI's Windows loop ranged from 139 to 459 ms on unchanged code; both binaries run on the same runner.
  const limits = { loopMs: budgets.win32.versusBase.loopMs };
  for (const loopMs of [139, 218, 459]) {
    expect(slowerThanBase(attempt({ loopMs }, { loopMs }), limits)).toEqual([]);
    expect(slowerThanBase(attempt({ loopMs: loopMs * 1.5 }, { loopMs }), limits))
      .toEqual([expect.stringContaining("loopMs: 1.5 is over its limit of 1.25 times the base")]);
  }
});

test("a change as fast as its base, or faster, keeps to the comparison", () => {
  const limits = { loopMs: 1.25, firstFrameMs: 1.25 };
  expect(slowerThanBase(attempt({ loopMs: 125, firstFrameMs: 80 }, { loopMs: 100, firstFrameMs: 100 }), limits)).toEqual([]);
});

test("a change slower than its base in one attempt only passes after the retry", () => {
  const limits = { loopMs: 1.25 };
  expect(slowerThanBase(attempt({ loopMs: 140 }, { loopMs: 100 }), limits, attempt({ loopMs: 110 }, { loopMs: 100 }))).toEqual([]);
  expect(slowerThanBase(attempt({ loopMs: 140 }, { loopMs: 100 }), limits, attempt({ loopMs: 150 }, { loopMs: 110 })))
    .toEqual(["loopMs: 1.4 then 1.36 is over its limit of 1.25 times the base (140 against the base's 100, then 150 against the base's 110)"]);
});

test("the ratio to the base is to the hundredth", () => {
  expect(ratio(150, 100)).toBe(1.5);
  expect(ratio(100, 300)).toBe(0.33);
});

test("an absolute backstop fails a slowdown shared by both binaries", () => {
  expect(overBudget(measured({ loopMs: 241 }), budgets.linux.limits)).toContainEqual(expect.stringContaining("loopMs"));
});

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
