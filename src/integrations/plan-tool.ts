import { Type } from "@earendil-works/pi-ai";
// A plain string enum, which providers such as Google's accept where they refuse `anyOf`.
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_PLAN_STEPS, PLAN_STATUSES, planProblem, type WorkPlan } from "../work-plan.js";

/**
 * The `plan` tool (decision 033): the agent sends its whole plan each time,
 * as Codex's `update_plan` does, and Tesota shows it to the person. It is a
 * Tesota tool, so every engine has it, and it keeps the plan out of the
 * workspace's files.
 */

/** When the agent should keep a plan, and what marking a step done means. */
export const PLAN_GUIDANCE: string = "The plan tool shows the user your plan and your progress. Use it when a request " +
  "needs three or more distinct steps: send every step each time, with exactly one in_progress while work remains. " +
  "Mark a step done only when its work is actually done, and blocked with the reason when you cannot go on. When a " +
  "step's result can be checked, write in its check the criterion, before doing the work, such as the tests to pass or " +
  "the totals to match, and keep it unchanged afterwards: it is what will be checked, never what you found. Tesota " +
  "shows done steps as your claim until a check confirms them; report what you found in your reply. ";

export function planTool(show: (plan: WorkPlan) => void): ToolDefinition {
  return defineTool({
    name: "plan", label: "Plan",
    description: `Show the user your plan for this request, replacing the previous one: at most ${MAX_PLAN_STEPS} steps, ` +
      "each pending, in_progress, done or blocked.",
    parameters: Type.Object({ steps: Type.Array(Type.Object({
      step: Type.String({ description: "What this step does, in the user's terms" }),
      status: StringEnum(PLAN_STATUSES),
      check: Type.Optional(Type.String({ description: "The criterion the step's result can be checked against, " +
        "written before the work and kept unchanged; never a result" })),
      blocked: Type.Optional(Type.String({ description: "Why the step cannot go on; required when blocked" })),
    })) }),
    execute: async (_id, params) => {
      const plan: WorkPlan = params.steps.map((step) => ({ step: step.step, status: step.status,
        ...step.check === undefined ? {} : { check: step.check }, ...step.blocked === undefined ? {} : { blocked: step.blocked } }));
      const problem = planProblem(plan);
      if (problem !== undefined) throw new Error(`Plan not updated: ${problem}.`);
      show(plan);
      const done = plan.filter((step) => step.status === "done").length;
      return { content: [{ type: "text", text: `Plan updated: ${done} of ${plan.length} steps done.` }], details: undefined };
    },
  });
}
