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

const marks: Readonly<Record<PlanStatus, string>> = { pending: "○", in_progress: "▸", done: "✓", blocked: "!" };

function detail(step: PlanStep): string[] {
  const check = step.check?.trim();
  switch (step.status) {
    case "pending": return check === undefined || check === "" ? [] : [`will be checked: ${check}`];
    case "in_progress": return ["in progress", ...check === undefined || check === "" ? [] : [`will be checked: ${check}`]];
    case "done": return ["done (agent)", ...check === undefined || check === "" ? [] : [`check not run: ${check}`]];
    case "blocked": return [`blocked: ${step.blocked?.trim() ?? ""}`];
  }
}

/** The plan as the person reads it: progress, then each step with what is known about it. */
export function planLines(plan: WorkPlan): string[] {
  const done = plan.filter((step) => step.status === "done").length;
  return [`Plan · ${done} of ${plan.length} done`,
    ...plan.map((step) => `  ${marks[step.status]} ${[step.step, ...detail(step)].join(" · ")}`)];
}
