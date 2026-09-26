/**
 * Decision 018's forecast rules. A forecast estimates only from enough
 * comparable measurements of the repository, and its estimate is the median:
 * the middle of the sorted measurements, averaged over the middle two when
 * their count is even.
 */

/** Whether this many comparable measurements are enough to estimate from. */
//@ ensures \result === (minimum > 0 && count >= minimum)
export function canEstimate(count: number, minimum: number): boolean {
  return minimum > 0 && count >= minimum;
}

/**
 * The lower and upper middle positions of `length` sorted values: at least
 * half the positions are at or before the lower one, and at least half at or
 * after the upper one; they coincide for an odd count and are adjacent for an
 * even one.
 */
//@ requires length > 0
//@ ensures 0 <= \result.lower && \result.lower <= \result.upper && \result.upper < length
//@ ensures (\result.lower + 1) * 2 >= length && (length - \result.upper) * 2 >= length
//@ ensures length % 2 === 1 ==> \result.lower === \result.upper
//@ ensures length % 2 === 0 ==> \result.upper === \result.lower + 1
export function middlePositions(length: number): { lower: number; upper: number } {
  const upper = Math.floor(length / 2);
  return { lower: length % 2 === 1 ? upper : upper - 1, upper };
}

export type ReviewStatus = "completed" | "incomplete";

/**
 * Whether a review step counts toward the repository's measured costs: only
 * when every reviewer finished, since an unfinished step did not cost what a
 * review costs.
 */
//@ ensures \result === forall(i: nat, i < statuses.length ==> statuses[i] === "completed")
export function countsAsMeasurement(statuses: ReviewStatus[]): boolean {
  return statuses.every((status) => status === "completed");
}
