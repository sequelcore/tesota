import type { Obligation } from "./review.js";
import { type ObligationOutcome, obligationOutcome } from "./verification/obligation-outcome.js";
import { planAccepted } from "./verification/plan-rule.js";

/**
 * The agent's plan (decision 033): the steps it means to take and where it
 * is, shown to the person as progress. A plan is the agent's own account,
 * never evidence: a step it marks done reads as its word, and a check it
 * declares for a step is shown as not yet run until gates exist to run it.
 */

export const PLAN_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStatus;
  /** How the step's result is to be checked, as the agent declares it. */
  readonly check?: string | undefined;
  /** Why a blocked step cannot go on. */
  readonly blocked?: string | undefined;
  /** What the review found of a step the agent marked done (decision 034): a judged check, never proof. */
  readonly review?: ObligationOutcome | undefined;
}

export type WorkPlan = readonly PlanStep[];

/** The most steps a plan may have; `planAccepted` states the same bound. */
export const MAX_PLAN_STEPS = 20;

/** Why a plan update is refused, or undefined when it is accepted (`planAccepted`). */
export function planProblem(plan: WorkPlan): string | undefined {
  const inProgress = plan.filter((step) => step.status === "in_progress").length;
  const unexplained = plan.filter((step) => step.status === "blocked" && (step.blocked ?? "").trim() === "").length;
  if (planAccepted(plan.length, inProgress, unexplained)) return undefined;
  if (plan.length === 0) return "a plan needs at least one step";
  if (plan.length > MAX_PLAN_STEPS) return `a plan has at most ${MAX_PLAN_STEPS} steps`;
  if (inProgress > 1) return "only one step can be in progress at a time";
  return "a blocked step must say why";
}

const reviewText: Readonly<Record<ObligationOutcome, string>> =
  { held: "held in review", not_held: "not held in review", uncertain: "review uncertain" };

/** The plan with what the review found of each step the agent marked done, from the main reviewer's obligations. */
export function withReview(plan: WorkPlan, obligations: readonly Obligation[]): WorkPlan {
  return plan.map((step, index) => {
    const assessed = obligations.filter((item) => item.source === "plan" && item.index === index + 1)
      .map((item) => obligationOutcome(item.status, item.standing ?? "untested"));
    if (step.status !== "done" || assessed.length === 0) return step;
    const review = assessed.includes("not_held") ? "not_held" : assessed.includes("uncertain") ? "uncertain" : "held";
    return { ...step, review };
  });
}

const marks: Readonly<Record<PlanStatus, string>> = { pending: "○", in_progress: "▸", done: "✓", blocked: "!" };

function detail(step: PlanStep): string[] {
  const check = step.check?.trim();
  switch (step.status) {
    case "pending": return check === undefined || check === "" ? [] : [`will be checked: ${check}`];
    case "in_progress": return ["in progress", ...check === undefined || check === "" ? [] : [`will be checked: ${check}`]];
    case "done": return ["done (agent)", ...step.review === undefined ? [] : [reviewText[step.review]],
      ...check === undefined || check === "" ? [] : [`check not run: ${check}`]];
    case "blocked": return [`blocked: ${step.blocked?.trim() ?? ""}`];
  }
}

/** The plan as the person reads it: progress, then each step with what is known about it. */
export function planLines(plan: WorkPlan): string[] {
  const done = plan.filter((step) => step.status === "done").length;
  return [`Plan · ${done} of ${plan.length} done`,
    ...plan.map((step) => `  ${marks[step.status]} ${[step.step, ...detail(step)].join(" · ")}`)];
}
