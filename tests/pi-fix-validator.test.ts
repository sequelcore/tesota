import { expect, it } from "vitest";
import { validationMessage, validationReport } from "../src/integrations/pi-fix-validator.js";
import { reviewMessage } from "../src/integrations/pi-reviewer.js";
import type { Finding, ReviewInput } from "../src/review.js";

const tree = "t".repeat(40);
const finding = (statement: string): Finding => ({ severity: "high", disposition: "fixable", origin: "introduced",
  standing: "confirmed", path: "src/price.js", line: 2, statement, reason: `why ${statement}` });
const sentBack = [finding("Exactly $100 is discounted"), finding("Totals are not rounded"), finding("No test for $100")];
const input: ReviewInput = { checkout: "C:/work/repo", requests: ["Orders over $100 get 10% off, rounded to cents"],
  checks: [], flags: [], correction: { sentBack },
  snapshot: { base: "p".repeat(40), tree, changes: [{ status: "modified", path: "src/price.js" }],
    diff: "-  return amount >= 100\n+  return amount > 100" } };

it("marks each finding sent back as resolved, still present or not re-checked, keeping the resolved to show (#250)", () => {
  const report = validationReport(tree, sentBack, { status: "completed", reply: "" }, [
    { id: 1, verdict: "resolved", evidence: "price.js:2 uses > 100" },
    { id: 2, verdict: "unresolved", evidence: "No Math.round anywhere" },
    { id: 3, verdict: "undetermined", evidence: "Tests not found" },
  ]);
  expect(report).toMatchObject({ reviewer: "Fix validation", status: "completed", summary: "1 of 3 findings sent back is resolved.",
    findings: [
      { statement: "Exactly $100 is discounted", recheck: "resolved", standing: "refuted",
        refutation: "After the correction: price.js:2 uses > 100" },
      { statement: "Totals are not rounded", recheck: "present", standing: "confirmed",
        refutation: "After the correction: No Math.round anywhere" },
      { statement: "No test for $100", recheck: "unchecked", standing: "unsettled" }] });
});

it("re-checks nothing when the validator does not finish", () => {
  for (const turn of [{ status: "cancelled" as const }, { status: "unsettled" as const }, { status: "timed_out" as const }]) {
    const report = validationReport(tree, sentBack, turn, [{ id: 1, verdict: "resolved", evidence: "" }]);
    expect(report.status === "completed" && report.findings.map((entry) => [entry.recheck, entry.standing])).toEqual(
      [["unchecked", "unsettled"], ["unchecked", "unsettled"], ["unchecked", "unsettled"]]);
  }
});

it("keeps every finding sent back present when the correction changed nothing, whatever a validator said (#250)", () => {
  const report = validationReport(tree, sentBack, { status: "completed", reply: "" },
    [{ id: 1, verdict: "resolved", evidence: "looks fine" }], false);
  expect(report).toMatchObject({ summary: "The correction changed nothing, so the 3 findings sent back are still present." });
  expect(report.status === "completed" && report.findings.map((entry) => [entry.recheck, entry.standing, entry.refutation])).toEqual(
    sentBack.map(() => ["present", "confirmed",
      "After the correction: the correction changed nothing, so the content is as it was when this was sent back"]));
});

it("shows the validator the correction's diff and what was sent back, and tells the reviewer to judge only the correction", () => {
  const message = validationMessage(input, sentBack);
  expect(message).toContain("1. [high] at src/price.js:2: Exactly $100 is discounted\n   Why it was a problem: why Exactly $100 is discounted");
  expect(message).toContain("Diff of the correction, from the result that was sent back to the current one (the left " +
    "column numbers each line of the changed files):\n`````diff\n-  return amount >= 100");
  const review = reviewMessage(input);
  expect(review).toContain("report only problems the correction itself introduced:\n- Exactly $100 is discounted");
  expect(review).toContain("Diff of the correction, from the result that was sent back to the current one (the left column");
  const { correction: _correction, ...firstRound } = input;
  expect(reviewMessage(firstRound)).toContain("Diff from the starting point (the left column numbers each line of the changed files):");
});
