import type { ReviewDepth } from "./review-depth.js";
import { canEstimate, middlePositions } from "./verification/review-estimate.js";

/**
 * What a review step will run and what it has cost before (decision 018).
 * The forecast describes; it never asks for consent or changes the review,
 * and it is drawn only from this repository's measured reviews.
 */

/** One measured review step, from its first reviewer to its refuter. */
export interface ReviewMeasurement {
  readonly at: string;
  readonly depth: ReviewDepth;
  /** A correction round's review, which also validates each fix. */
  readonly correction: boolean;
  readonly durationMs: number;
  /** Every model token the step used, as the model provider reported it through Pi. */
  readonly tokens: number;
}

/** What the review step is about to run. */
export interface ReviewPlan {
  readonly depth: ReviewDepth;
  readonly correction: boolean;
  /** The focused lenses of a deep review, by name. */
  readonly lenses: readonly string[];
  /** Whether the ClaimCheck method compares proved contracts. */
  readonly claimcheck: boolean;
}

/** Measurements kept per repository, newest last. */
export const MEASUREMENTS_KEPT = 20;
/** Fewer comparable measurements than this and the forecast says so instead of estimating. */
export const MIN_MEASUREMENTS = 3;

/** The median of at least one value, from the proved middle positions. */
function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const { lower, upper } = middlePositions(sorted.length);
  return ((sorted[lower] ?? 0) + (sorted[upper] ?? 0)) / 2;
}

function tokens(count: number): string {
  return count < 1_000 ? `${Math.round(count)} tokens` : `${Math.round(count / 1_000)}k tokens`;
}

/** Duration and tokens in the words the operator reads, such as "42 s and 118k tokens". */
export function costText(durationMs: number, tokenCount: number): string {
  return `${Math.max(1, Math.round(durationMs / 1_000))} s and ${tokens(tokenCount)}`;
}

function steps(plan: ReviewPlan): string {
  const reviewers = [plan.lenses.length === 0 ? "the reviewer" : `the reviewer and ${plan.lenses.length} focused ` +
    `${plan.lenses.length === 1 ? "one" : "ones"} (${plan.lenses.join(", ")})`,
  ...(plan.claimcheck ? ["the ClaimCheck method"] : [])].join(" and ");
  return `${plan.correction ? "a check of each fix, " : ""}${reviewers}, then a refuter for any findings`;
}

/** One line: what the step runs, and what comparable reviews of this repository took. */
export function forecastLine(plan: ReviewPlan, history: readonly ReviewMeasurement[]): string {
  const kind = `${plan.depth === "deep" ? "Deep review" : "Review"}${plan.correction ? " of a correction" : ""}`;
  const comparable = history.filter((entry) => entry.depth === plan.depth && entry.correction === plan.correction);
  const basis = !canEstimate(comparable.length, MIN_MEASUREMENTS)
    ? `Not enough ${plan.depth === "deep" ? "deep " : ""}reviews of this repository have been measured to estimate its cost ` +
      `(${comparable.length} of ${MIN_MEASUREMENTS}).`
    : `Comparable reviews of this repository took about ${costText(median(comparable.map((entry) => entry.durationMs)),
      median(comparable.map((entry) => entry.tokens)))} (median of ${comparable.length}).`;
  return `${kind}: ${steps(plan)}. ${basis}`;
}

/** The history with a new measurement, keeping the newest. */
export function withMeasurement(history: readonly ReviewMeasurement[], measurement: ReviewMeasurement): ReviewMeasurement[] {
  return [...history, measurement].slice(-MEASUREMENTS_KEPT);
}
