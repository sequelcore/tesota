import { expect, it } from "vitest";
import { applyRefutation, refutationMessage, verdictsFrom } from "../src/integrations/pi-refuter.js";
import type { Finding, ReviewInput, ReviewReport } from "../src/review.js";

const tree = "t".repeat(40);
const finding = (statement: string): Finding => ({ severity: "high", disposition: "fixable", origin: "introduced",
  path: "src/price.ts", line: 3, statement, reason: `why ${statement}` });
const reports: ReviewReport[] = [
  { reviewer: "Tesota reviewer", tree, status: "completed", summary: "Two.", findings: [finding("A"), finding("B")] },
  { reviewer: "Stopped reviewer", tree, status: "incomplete", reason: "stopped" },
  { reviewer: "ClaimCheck method", tree, status: "completed", summary: "One.", findings: [finding("C")] },
];

it("gives each finding the refuter's verdict in order across reports, and leaves unanswered ones unsettled", () => {
  const tested = applyRefutation(reports, [
    { id: 1, verdict: "confirmed", evidence: "price.ts:3 uses >=" },
    { id: 2, verdict: "refuted", evidence: "handled on line 9" },
  ]);
  expect(tested[0]).toMatchObject({ findings: [
    { statement: "A", standing: "confirmed", refutation: "price.ts:3 uses >=" },
    { statement: "B", standing: "refuted", refutation: "handled on line 9" }] });
  expect(tested[1]).toEqual(reports[1]);
  expect(tested[2]).toMatchObject({ findings: [{ statement: "C", standing: "unsettled" }] });
  const third = tested[2];
  expect(third?.status === "completed" && "refutation" in (third.findings[0] ?? {})).toBe(false);
});

it("never confirms or clears a finding when the refuter did not finish", () => {
  expect(verdictsFrom({ status: "cancelled" }, [{ id: 1, verdict: "refuted", evidence: "" }])).toBeUndefined();
  expect(verdictsFrom({ status: "unsettled" }, [{ id: 1, verdict: "confirmed", evidence: "" }])).toBeUndefined();
  expect(verdictsFrom({ status: "completed", reply: "" }, undefined)).toBeUndefined();
  const tested = applyRefutation(reports, undefined);
  expect(tested.flatMap((report) => report.status === "completed" ? report.findings.map((entry) => entry.standing) : []))
    .toEqual(["unsettled", "unsettled", "unsettled"]);
  const undetermined = applyRefutation(reports, [{ id: 1, verdict: "undetermined", evidence: "No test shows it" }]);
  expect(undetermined[0]).toMatchObject({ findings: [{ standing: "unsettled", refutation: "No test shows it" }, { standing: "unsettled" }] });
});

it("shows the refuter each finding's claim, numbered, with the review input", () => {
  const input: ReviewInput = { checkout: "C:/work/repo", requests: ["Discount orders over $100"], checks: [], flags: [],
    snapshot: { base: "b".repeat(40), tree, diff: "diff --git a/src/price.ts b/src/price.ts", changes: [{ status: "modified", path: "src/price.ts" }] } };
  const message = refutationMessage(input, [finding("A"), finding("C")]);
  expect(message).toContain("1. Discount orders over $100");
  expect(message).toContain("Findings to test, one verdict each:\n1. [high, introduced] at src/price.ts:3: A\n   Reviewer's reason: why A\n2.");
});
