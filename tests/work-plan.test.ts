import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { workingAgentSetup } from "../src/integrations/pi-coding-session.js";
import { PLAN_GUIDANCE, planTool } from "../src/integrations/plan-tool.js";
import { MAX_PLAN_STEPS, planLines, planProblem, type WorkPlan } from "../src/work-plan.js";

/**
 * Decision 033: the agent's plan is visible progress, never evidence. A step
 * the agent marks done reads as the agent's word, and a check it declares is
 * shown as not yet run.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const plan: WorkPlan = [
  { step: "Read last month's budget", status: "done" },
  { step: "Update the totals", status: "done", check: "recalculates with zero errors" },
  { step: "Compare each total with its invoice", status: "in_progress", check: "totals match the invoices" },
  { step: "Write the summary", status: "pending" },
  { step: "Rename the archive folders", status: "blocked", blocked: "needs the user's approval" },
];

it("accepts a plan with at most one step in progress, a reason for every blocked step, and a bounded length", () => {
  expect(planProblem(plan)).toBeUndefined();
  expect(planProblem([])).toBe("a plan needs at least one step");
  expect(planProblem([{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }]))
    .toBe("only one step can be in progress at a time");
  expect(planProblem([{ step: "a", status: "blocked" }])).toBe("a blocked step must say why");
  expect(planProblem([{ step: "a", status: "blocked", blocked: "  " }])).toBe("a blocked step must say why");
  const long = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => ({ step: `s${index}`, status: "pending" as const }));
  expect(planProblem(long)).toBe(`a plan has at most ${MAX_PLAN_STEPS} steps`);
  expect(planProblem(long.slice(0, MAX_PLAN_STEPS))).toBeUndefined();
});

it("shows progress, a done step as the agent's word, and a declared check as not yet run", () => {
  expect(planLines(plan)).toEqual([
    "Plan · 2 of 5 done",
    "  ✓ Read last month's budget · done (agent)",
    "  ✓ Update the totals · done (agent) · check not run: recalculates with zero errors",
    "  ▸ Compare each total with its invoice · in progress · will be checked: totals match the invoices",
    "  ○ Write the summary",
    "  ! Rename the archive folders · blocked: needs the user's approval",
  ]);
});

it("updates the plan through the tool, and refuses an invalid one without changing it", async () => {
  const shown: WorkPlan[] = [];
  const tool = planTool((next) => { shown.push(next); });
  const call = (steps: unknown) => tool.execute("c", { steps } as never, new AbortController().signal, undefined, undefined as never);
  const text = (result: Awaited<ReturnType<typeof call>>): string =>
    result.content.map((part) => part.type === "text" ? part.text : "").join("");
  expect(text(await call(plan))).toBe("Plan updated: 2 of 5 steps done.");
  expect(shown).toEqual([plan]);
  await expect(call([{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }]))
    .rejects.toThrow("Plan not updated: only one step can be in progress at a time.");
  expect(shown).toHaveLength(1);
});

it("gives every working agent the plan tool and its guidance when the shell shows plans", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-plan-"));
  roots.push(root);
  const base = { cwd: root, environment: await hostProvider.prepare(root), sandboxed: false, approveCommand: async () => "deny" as const };
  const withPlan = workingAgentSetup({ ...base, plan: () => {} });
  expect(withPlan.tools.map((tool) => tool.name)).toContain("plan");
  expect(withPlan.systemPrompt).toContain(PLAN_GUIDANCE);
  const without = workingAgentSetup(base);
  expect(without.tools.map((tool) => tool.name)).not.toContain("plan");
  expect(without.systemPrompt).not.toContain(PLAN_GUIDANCE);
});
