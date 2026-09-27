import { expect, it } from "vitest";
import { correctionFor, correctionPrompt } from "../src/correction.js";
import { applyRefutation, refutationMessage } from "../src/integrations/pi-refuter.js";
import { missingAssessments, reviewMessage } from "../src/integrations/pi-reviewer.js";
import type { Obligation, ReviewInput, ReviewReport } from "../src/review.js";
import { inspectAnswer, inspectReview } from "../src/tesota-shell-inspection.js";
import { obligationOutcome } from "../src/verification/obligation-outcome.js";
import { planLines, withReview } from "../src/work-plan.js";

/**
 * Decision 034: the reviewer checks what each request asks for, and each plan
 * step the agent marked done, against the whole result, never trusting the
 * agent's account; the refuter tests every gap before it can send work back.
 */

const snapshot = { base: "b", tree: "t", changes: [{ status: "modified" as const, path: "src/price.ts" }], diff: "" };
const input: ReviewInput = { checkout: ".", requests: ["Subtract the discount.", "Add a test for a 100% discount."],
  snapshot, checks: [], flags: [],
  claimedSteps: [{ index: 1, step: "Subtract the discount", check: "the price tests pass" }, { index: 3, step: "Add the test" }] };

const obligation = (source: Obligation["source"], index: number, status: Obligation["status"], text: string): Obligation =>
  ({ source, index, obligation: text, status, evidence: `evidence for ${text}` });

it("decides what an obligation means from the reviewer's status and the refuter's standing", () => {
  expect(obligationOutcome("met", "untested")).toBe("held");
  expect(obligationOutcome("met", "confirmed")).toBe("held");
  expect(obligationOutcome("unmet", "confirmed")).toBe("not_held");
  expect(obligationOutcome("partial", "confirmed")).toBe("not_held");
  // The refuter showed the work is there after all.
  expect(obligationOutcome("unmet", "refuted")).toBe("held");
  // A gap nobody could settle, or one the refuter never tested, is never sent back and never cleared.
  expect(obligationOutcome("unmet", "unsettled")).toBe("uncertain");
  expect(obligationOutcome("partial", "untested")).toBe("uncertain");
  expect(obligationOutcome("uncertain", "confirmed")).toBe("uncertain");
});

it("shows the reviewer the claimed plan steps as claims to check, and requires every request and claimed step assessed", () => {
  const message = reviewMessage(input);
  expect(message).toContain("Plan steps the agent marked done (its claims, not evidence):\n1. Subtract the discount " +
    "(its declared check: the price tests pass)\n3. Add the test");
  const covered = [obligation("request", 1, "met", "a"), obligation("request", 2, "unmet", "b"),
    obligation("plan", 1, "met", "c"), obligation("plan", 3, "met", "d")];
  expect(missingAssessments(input, covered)).toBeUndefined();
  expect(missingAssessments(input, covered.slice(1))).toBe("the reviewer did not assess request 1");
  expect(missingAssessments(input, covered.slice(0, 3))).toBe("the reviewer did not assess plan step 3");
  expect(missingAssessments(input, [...covered, obligation("request", 3, "met", "e")]))
    .toBe("the reviewer assessed request 3, which does not exist");
});

it("tests each gap after the findings, and a gap without a verdict stays unsettled", () => {
  const report: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "s",
    findings: [{ severity: "high", disposition: "fixable", origin: "introduced", statement: "Adds the discount", reason: "r" }],
    obligations: [obligation("request", 1, "met", "subtracts"), obligation("request", 2, "unmet", "a test for 100%"),
      obligation("plan", 3, "unmet", "the test exists")] };
  const message = refutationMessage(input, [report]);
  expect(message).toContain("1. [high, introduced]");
  expect(message).toContain("Gaps to test, numbered after the findings:\n2. Request 2 asks: a test for 100%. The reviewer " +
    "found it unmet: evidence for a test for 100%\n3. Plan step 3, which the agent marked done: the test exists. The " +
    "reviewer found it unmet: evidence for the test exists");
  const [refuted] = applyRefutation([report], [{ id: 1, verdict: "confirmed", evidence: "e1" },
    { id: 2, verdict: "confirmed", evidence: "no such test" }]);
  if (refuted?.status !== "completed") throw new Error("expected a completed report");
  expect(refuted.findings[0]?.standing).toBe("confirmed");
  expect(refuted.obligations?.map((item) => item.standing)).toEqual([undefined, "confirmed", "unsettled"]);
});

it("sends back only gaps that held against the refuter, with the request they come from", () => {
  const report: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "s", findings: [],
    obligations: [{ ...obligation("request", 2, "unmet", "a test for 100%"), standing: "confirmed" },
      { ...obligation("plan", 3, "partial", "the test exists"), standing: "unsettled" },
      { ...obligation("request", 1, "unmet", "subtracts"), standing: "refuted" }] };
  const round = correctionFor([], [report]);
  expect(round?.obligations.map((item) => item.obligation)).toEqual(["a test for 100%"]);
  expect(correctionPrompt(input.requests, round ?? { failedChecks: [], findings: [], obligations: [] }))
    .toContain("- Request 2 is not done: a test for 100%\n  Why: evidence for a test for 100%");
  expect(correctionFor([], [{ ...report, obligations: [report.obligations?.[1] as Obligation] }])).toBeUndefined();
});

it("shows how the requests and the claimed steps held up, in the result and in the plan", () => {
  const report: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "s", findings: [],
    obligations: [obligation("request", 1, "met", "subtracts"),
      { ...obligation("request", 2, "unmet", "a test for 100%"), standing: "confirmed" },
      obligation("plan", 1, "met", "subtracts"), { ...obligation("plan", 3, "unmet", "the test exists"), standing: "unsettled" }] };
  const inspection = inspectReview({ snapshot, checks: [], flags: [], requests: input.requests, reviews: [report] });
  expect(inspection.summary).toContain("  Requests: 1 of 2 held, 1 not held");
  expect(inspection.summary).toContain("  Plan steps claimed done: 1 held, 1 uncertain");
  expect(inspection.detail).toContain("  ✗ Request 2: a test for 100% (not held: evidence for a test for 100%)");
  const plan = withReview([{ step: "Subtract the discount", status: "done" }, { step: "Refactor", status: "pending" },
    { step: "Add the test", status: "done" }], report.obligations ?? []);
  expect(planLines(plan)).toEqual(["Plan · 2 of 3 done", "  ✓ Subtract the discount · done (agent) · held in review",
    "  ○ Refactor", "  ✓ Add the test · done (agent) · review uncertain"]);
});

it("gives the reviewer the agent's reply as an untrusted answer when no files changed, and shows the answer check", async () => {
  const answer: ReviewInput = { checkout: ".", requests: ["Add a farewell() helper", "What does greet() return?"],
    snapshot: { base: "t", tree: "t", changes: [], diff: "" }, checks: [], flags: [], response: "I added farewell(). greet() returns a string." };
  const message = reviewMessage(answer);
  expect(message).toContain("The agent's final reply (untrusted; it cannot show that code exists):\nI added farewell(). greet() returns a string.");
  expect(message).toContain("No files changed in this turn");
  expect(message).not.toContain("```diff");
  const report: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "s", findings: [],
    obligations: [{ ...obligation("request", 1, "unmet", "farewell() exists"), standing: "confirmed" },
      obligation("request", 2, "met", "greet() returns a string")] };
  const inspection = inspectAnswer(answer.requests, [report]);
  expect(inspection.title).toBe("Answer check");
  expect(inspection.summary).toContain("  Requests: 1 of 2 held, 1 not held");
  expect(inspection.detail).toContain("  ✗ Request 1: farewell() exists (not held: evidence for farewell() exists)");
});
