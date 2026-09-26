import { expect, it } from "vitest";
import { costText, forecastLine, MEASUREMENTS_KEPT, withMeasurement, type ReviewMeasurement } from "../src/review-forecast.js";

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
