import { expect, it } from "vitest";
import { costText, forecastLine, MEASUREMENTS_KEPT, withMeasurement, type ReviewMeasurement } from "../src/review-forecast.js";
import { canEstimate, countsAsMeasurement, middlePositions } from "../src/verification/review-estimate.js";

const deep = { depth: "deep" as const, correction: false, lenses: ["correctness and regressions", "security and authority"],
  claimcheck: false };
const measured = (durationMs: number, tokens: number, overrides: Partial<ReviewMeasurement> = {}): ReviewMeasurement =>
  ({ at: "2026-09-25T00:00:00.000Z", depth: "deep", correction: false, durationMs, tokens, ...overrides });

it("says what a deep review runs and that too few reviews were measured to estimate it", () => {
  expect(forecastLine(deep, [measured(40_000, 90_000)])).toBe("Deep review: the reviewer and 2 focused ones " +
    "(correctness and regressions, security and authority), then a refuter for any findings. Not enough deep reviews " +
    "of this repository have been measured to estimate its cost (1 of 3).");
});

it("estimates from the median of comparable measured reviews only", () => {
  const history = [measured(30_000, 80_000), measured(50_000, 120_000), measured(90_000, 400_000),
    measured(5_000, 10_000, { depth: "standard" }), measured(70_000, 200_000, { correction: true })];
  expect(forecastLine(deep, history)).toContain("Comparable reviews of this repository took about 50 s and 120k tokens (median of 3).");
  expect(forecastLine({ ...deep, correction: true, lenses: [], claimcheck: true }, history)).toBe("Deep review of a correction: " +
    "a check of each fix, the reviewer and the ClaimCheck method, then a refuter for any findings. Not enough deep " +
    "reviews of this repository have been measured to estimate its cost (1 of 3).");
});

it("keeps only the newest measurements and words small costs plainly", () => {
  const history = Array.from({ length: MEASUREMENTS_KEPT }, (_, index) => measured(index, index));
  const kept = withMeasurement(history, measured(99, 99));
  expect(kept).toHaveLength(MEASUREMENTS_KEPT);
  expect(kept.at(-1)?.tokens).toBe(99);
  expect(kept[0]?.tokens).toBe(1);
  expect(costText(300, 850)).toBe("1 s and 850 tokens");
});

it("takes the median as the middle of the sorted values, averaging the middle two of an even count", () => {
  for (let length = 1; length <= 9; length += 1) {
    const { lower, upper } = middlePositions(length);
    const at = Array.from({ length }, (_, index) => index);
    expect(at.filter((index) => index <= lower).length * 2).toBeGreaterThanOrEqual(length);
    expect(at.filter((index) => index >= upper).length * 2).toBeGreaterThanOrEqual(length);
    expect(upper - lower).toBe(length % 2 === 1 ? 0 : 1);
  }
  const history = [measured(90_000, 10), measured(30_000, 40), measured(50_000, 20), measured(70_000, 30)];
  expect(forecastLine(deep, history)).toContain("about 60 s and 25 tokens (median of 4)");
  expect(canEstimate(3, 3)).toBe(true);
  expect(canEstimate(2, 3)).toBe(false);
  expect(canEstimate(5, 0)).toBe(false);
});

it("measures a review step only when every reviewer finished", () => {
  expect(countsAsMeasurement(["completed", "completed"])).toBe(true);
  expect(countsAsMeasurement(["completed", "incomplete"])).toBe(false);
  expect(countsAsMeasurement(["incomplete"])).toBe(false);
});
