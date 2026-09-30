import { DEFAULT_MODEL } from "./model-roles.js";
import type { ReviewDepth } from "./review-depth.js";
import { canEstimate, middlePositions } from "./verification/review-estimate.js";

/**
 * What a review step will run and what it has cost before (decision 018).
 * The forecast describes; it never asks for consent or changes the review,
 * and it is drawn only from this repository's measured reviews.
 */

/** The models a review step ran with (decision 020). */
export type ReviewModels = Readonly<{ reviewer: string; refuter: string; validator: string }>;

/** Measurements recorded before models were chosen per role all used the default. */
const earlierModels: ReviewModels = { reviewer: DEFAULT_MODEL, refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL };

/** One measured review step, from its first reviewer to its refuter. */
export interface ReviewMeasurement {
  readonly at: string;
  readonly depth: ReviewDepth;
  /** A correction round's review, which also validates each fix. */
  readonly correction: boolean;
  readonly durationMs: number;
  /** Every model token the step used, as the model provider reported it through Pi. */
  readonly tokens: number;
  /** Absent in measurements recorded before decision 020, which all used the default model. */
  readonly models?: ReviewModels | undefined;
}

/** What the review step is about to run. */
export interface ReviewPlan {
  readonly depth: ReviewDepth;
  readonly correction: boolean;
  /** Why this review is thorough, in words the operator reads. */
  readonly reasons?: readonly string[];
  /** The focused lenses of a deep review, by name. */
  readonly lenses: readonly string[];
  /** Whether the ClaimCheck method compares proved contracts. */
  readonly claimcheck: boolean;
  readonly models: ReviewModels;
}

function sameModels(a: ReviewModels, b: ReviewModels): boolean {
  return a.reviewer === b.reviewer && a.refuter === b.refuter && a.validator === b.validator;
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

/** One line: what the step runs, and what comparable reviews of this repository took. */
export function forecastLine(plan: ReviewPlan, history: readonly ReviewMeasurement[]): string {
  const subject = plan.correction ? "the agent's fix" : "the agent's changes";
  const why = plan.reasons?.length ? ` (reason: ${plan.reasons.join("; ")})` : "";
  const reviewers = 1 + plan.lenses.length + Number(plan.claimcheck);
  const steps = `${plan.correction ? "checking each fix, then " : ""}${reviewers} ` +
    `${reviewers === 1 ? "reviewer" : "reviewers"}, followed by a second check of any problems`;
  // Only reviews made the same way, with the same models, say what this one will cost.
  const comparable = history.filter((entry) => entry.depth === plan.depth && entry.correction === plan.correction &&
    sameModels(entry.models ?? earlierModels, plan.models));
  const basis = !canEstimate(comparable.length, MIN_MEASUREMENTS)
    ? `No reliable time estimate yet (${comparable.length} of ${MIN_MEASUREMENTS} comparable reviews measured).`
    : `Comparable reviews here took about ${Math.max(1, Math.round(median(comparable.map((entry) => entry.durationMs)) / 1_000))} s ` +
      `(median of ${comparable.length}).`;
  return `Reviewing ${subject}${plan.depth === "deep" ? " thoroughly" : ""}${why}: ${steps}. ${basis}`;
}

/** The history with a new measurement, keeping the newest. */
export function withMeasurement(history: readonly ReviewMeasurement[], measurement: ReviewMeasurement): ReviewMeasurement[] {
  return [...history, measurement].slice(-MEASUREMENTS_KEPT);
}
