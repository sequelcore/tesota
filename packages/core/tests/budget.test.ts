import { expect, test } from "bun:test";
import { type Budget, exceptionLines, type Limits, type Measurements, median, overBudget, ratio, slowerThanBase, versusBaseFor } from "../scripts/budget.ts";
import budgets from "../budgets.json" with { type: "json" };

const alpha9 = "74e4f0b829c34a51da79007a337ec67a44153b35";
const windows = budgets.win32 as Budget;
const linux = budgets.linux as Budget;
/** One measurement's limit alone; a missing one reads as no limit set, which fails. */
const only = (limits: Limits, name: keyof Measurements): Limits => ({ [name]: limits[name] ?? null });

test("Windows resume against alpha.9 at alpha.10 is held to 1.40, and every other ratio to 1.25", () => {
  const { limits, applied } = versusBaseFor(windows, alpha9, "0.1.0-alpha.10");
  expect(limits).toEqual({ startupMs: 1.25, loopMs: 1.25, resumeMs: 1.4, firstFrameMs: 1.25 });
  expect(applied.map((exception) => exception.issue)).toEqual(["#848"]);
  // The two attempts the exception was approved from pass; a slower resume still fails.
  const measuredAttempts = [attempt({ resumeMs: 22 }, { resumeMs: 17.1 }), attempt({ resumeMs: 21 }, { resumeMs: 15.4 })] as const;
  expect(slowerThanBase(measuredAttempts[0], only(limits, "resumeMs"), measuredAttempts[1])).toEqual([]);
  expect(slowerThanBase(attempt({ resumeMs: 22 }, { resumeMs: 15 }), only(limits, "resumeMs"), attempt({ resumeMs: 22 }, { resumeMs: 15 })))
    .toEqual([expect.stringContaining("resumeMs: 1.47 then 1.47 is over its limit of 1.4")]);
  expect(slowerThanBase(attempt({ loopMs: 130 }, { loopMs: 100 }), only(limits, "loopMs"), attempt({ loopMs: 130 }, { loopMs: 100 })))
    .toEqual([expect.stringContaining("loopMs: 1.3 then 1.3 is over its limit of 1.25")]);
});

test("the exception applies to no other version, base, platform or measurement", () => {
  const usual = (budget: Budget, base: string, version: string) => {
    const { limits, applied } = versusBaseFor(budget, base, version);
    expect(applied).toEqual([]);
    expect(limits).toEqual(budget.versusBase);
  };
  usual(windows, alpha9, "0.1.0-alpha.11");
  usual(windows, alpha9, "0.1.0-alpha.9");
  usual(windows, "9c05be22863d07e12a8f4a90672720c927cd5ae3", "0.1.0-alpha.10");
  usual(windows, "74e4f0b8", "0.1.0-alpha.10");
  usual(linux, alpha9, "0.1.0-alpha.10");
  const other = { ...windows, versusBase: { loopMs: 1.25 } };
  usual(other, alpha9, "0.1.0-alpha.10");
});

test("an applied exception is stated, with each measurement only it allows, and never as the usual budget", () => {
  const { applied } = versusBaseFor(windows, alpha9, "0.1.0-alpha.10");
  const overUsual = slowerThanBase(attempt({ resumeMs: 22 }, { resumeMs: 17.1 }), only(windows.versusBase, "resumeMs"),
    attempt({ resumeMs: 21 }, { resumeMs: 15.4 }));
  const lines = exceptionLines(applied, windows.versusBase, overUsual);
  expect(lines).toEqual([
    expect.stringMatching(/^Exception applied: resumeMs may be 1\.4 times the base instead of 1\.25, for 0\.1\.0-alpha\.10 against 74e4f0b8.*Approved 2026-11-06 by the owner; removed by #848\.$/),
    "Over the usual budget, allowed only by the exception: resumeMs: 1.29 then 1.36 is over its limit of 1.25 times the base (22 against the base's 17.1, then 21 against the base's 15.4)",
  ]);
  expect(exceptionLines([], windows.versusBase, overUsual)).toEqual([]);
});

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
