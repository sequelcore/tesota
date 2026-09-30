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
  expect(verdictsFrom({ status: "timed_out" }, [{ id: 1, verdict: "confirmed", evidence: "" }])).toBeUndefined();
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
  const message = refutationMessage(input, [{ reviewer: "Tesota reviewer", tree, status: "completed", summary: "", findings: [finding("A"), finding("C")] }]);
  expect(message).toContain("1. Discount orders over $100");
  expect(message).toContain("Findings to test, one verdict each:\n1. [high, introduced] at src/price.ts:3: A\n   Reviewer's reason: why A\n2.");
});

it("marks a finding left to the operator, which may report work beyond the requests rather than a defect", () => {
  const input: ReviewInput = { checkout: "C:/work/repo", requests: ["Discount orders over $100"], checks: [], flags: [],
    snapshot: { base: "b".repeat(40), tree, diff: "diff --git a/src/price.ts b/src/price.ts", changes: [{ status: "modified", path: "src/price.ts" }] } };
  const message = refutationMessage(input, [{ reviewer: "Tesota reviewer", tree, status: "completed", summary: "",
    findings: [{ ...finding("A refactor nobody asked for"), disposition: "operator" }] }]);
  expect(message).toContain("1. [high, introduced, operator's call] at src/price.ts:3: A refactor nobody asked for");
});

it("marks a premise dispute so the refuter checks the premise against the repository, not the request", () => {
  const input: ReviewInput = { checkout: "C:/work/repo", requests: ["Exactly 100 is charged; fix it"], checks: [], flags: [],
    snapshot: { base: "b".repeat(40), tree, diff: "diff --git a/src/price.ts b/src/price.ts", changes: [{ status: "modified", path: "src/price.ts" }] } };
  const message = refutationMessage(input, [{ reviewer: "Tesota reviewer", tree, status: "completed", summary: "",
    findings: [{ ...finding("The pricing policy charges exactly 100"), disposition: "operator", premise: true }] }]);
  expect(message).toContain("1. [high, introduced, premise dispute, operator's call] at src/price.ts:3: The pricing policy");
});

it("merges a finding that repeats an earlier one, and ignores a duplicate that points forward", () => {
  const tested = applyRefutation(reports, [
    { id: 1, verdict: "confirmed", evidence: "price.ts:3" },
    { id: 2, verdict: "confirmed", evidence: "same line", duplicateOf: 1 },
    { id: 3, verdict: "confirmed", evidence: "ok", duplicateOf: 3 },
  ]);
  expect(tested[0]).toMatchObject({ findings: [{ statement: "A" }, { statement: "B", duplicateOf: "Tesota reviewer: A" }] });
  const first = tested[0];
  expect(first?.status === "completed" && "duplicateOf" in (first.findings[0] ?? {})).toBe(false);
  const third = tested[2];
  expect(third?.status === "completed" && "duplicateOf" in (third.findings[0] ?? {})).toBe(false);
});

it("groups findings at the same place for the refuter, and never across files", async () => {
  const { locationGroups } = await import("../src/integrations/pi-refuter.js");
  const at = (path: string | undefined, line?: number): Finding => {
    const base = { severity: "high" as const, disposition: "fixable" as const, origin: "introduced" as const, statement: "s", reason: "r" };
    return { ...base, ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) };
  };
  expect(locationGroups([at("a.js", 2), at("b.js", 2), at("a.js", 4), at("a.js", 30), at("b.js"), at("b.js"), at(undefined)]))
    .toEqual([[1, 3], [5, 6]]);
  const message = refutationMessage({ checkout: "C:/work/repo", requests: [], checks: [], flags: [],
    snapshot: { base: "b".repeat(40), tree, diff: "", changes: [] } },
    [{ reviewer: "Tesota reviewer", tree, status: "completed", summary: "", findings: [at("a.js", 2), at("a.js", 3)] }]);
  expect(message).toContain("Findings at the same place, which may report one problem more than once.");
  expect(message).toContain("- 1, 2 at a.js:2");
});

it("never merges an introduced finding into one whose origin differs", () => {
  const unclear: ReviewReport = { reviewer: "Tesota reviewer", tree, status: "completed", summary: "",
    findings: [{ ...finding("Weakened test"), origin: "unknown" }, finding("Weakened test, again")] };
  const [report] = applyRefutation([unclear], [{ id: 1, verdict: "confirmed", evidence: "" },
    { id: 2, verdict: "confirmed", evidence: "", duplicateOf: 1 }]);
  expect(report?.status === "completed" && report.findings.map((entry) => entry.duplicateOf)).toEqual([undefined, undefined]);
});

it("does not merge findings in different files even when the refuter says so", () => {
  const split: ReviewReport[] = [{ reviewer: "Tesota reviewer", tree, status: "completed", summary: "", findings: [
    finding("A"), { ...finding("B"), path: "src/other.ts" }] }];
  const tested = applyRefutation(split, [{ id: 1, verdict: "confirmed", evidence: "" },
    { id: 2, verdict: "confirmed", evidence: "", duplicateOf: 1 }]);
  const report = tested[0];
  expect(report?.status === "completed" && report.findings.map((entry) => entry.duplicateOf)).toEqual([undefined, undefined]);
});
