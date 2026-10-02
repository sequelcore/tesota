import { expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { inspectReview } from "../src/tesota-shell-inspection.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";

const snapshot: WorkspaceSnapshot = { base: "b".repeat(40), tree: "t".repeat(40), diff: "diff --git a/src/price.ts b/src/price.ts",
  changes: [{ status: "modified", path: "src/price.ts" }, { status: "modified", path: "src/price.test.ts" }] };
const check = { verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command: "bun run check", tree: snapshot.tree, environment: "host", guarantees: hostProvider.guarantees,
  outcome: "passed" as const, exitCode: 0, durationMs: 1, output: "" };

it("says where the checks ran by the sandbox's own name, or on this computer without isolation", () => {
  const where = (environment: string, filesystem: "workspace" | "host"): string => inspectReview({ snapshot, requests: [], flags: [],
    reviews: [], checks: [{ ...check, environment, guarantees: { ...hostProvider.guarantees, filesystem } }] }).summary;
  expect(where("wsl", "workspace")).toContain("Checks ran on this exact content in the WSL sandbox.");
  expect(where("docker-sandboxes", "workspace")).toContain("Checks ran on this exact content in Docker Sandboxes.");
  expect(where("host", "host")).toContain("Checks ran on this exact content on this computer, without isolation.");
  expect(where("vm", "workspace")).toContain("Checks ran on this exact content in the isolated vm environment.");
  expect(inspectReview({ snapshot, requests: [], flags: [], reviews: [], checks: [] }).summary).toContain("No checks ran.");
});

it("keeps each line of a request of several lines under its number, so none reads as a section of the record", () => {
  const review = inspectReview({ snapshot, checks: [check], flags: [], reviews: [],
    requests: ["Redesign the explorer.\nTarget design:\n\n- Header line: the path\nAcceptance", "Run it"] });
  expect(review.detail).toMatch(/^Your requests\n {2}1\. Redesign the explorer\.\n {5}Target design:\n\n {5}- Header line: the path\n {5}Acceptance\n {2}2\. Run it\n/u);
  // The record's own headings are its only unindented lines after a blank one.
  const headings = review.detail.split(/\n\n(?=\S)/u).map((section) => section.split("\n", 1)[0]);
  expect(headings).toEqual(["Your requests", "Files", "Checks", "Review", "Content"]);
});

it("lists changes to what gets checked as the operator's decision, and the requests behind the result", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Charge over $100 less", "Keep the old test"],
    flags: [{ path: "src/price.test.ts", status: "modified", kind: "test" }], reviews: [] });
  expect(review.summary).toContain("Needs you\n  ! edited test: src/price.test.ts");
  expect(review.summary).toContain("For context\n  ✓ bun run check");
  expect(review.summary).toContain("only you can tell whether that is legitimate");
  expect(review.detail).toMatch(/^Your requests\n {2}1\. Charge over \$100 less\n {2}2\. Keep the old test\n/u);
  expect(review.detail).toContain("Changes to how the result is checked\n  modified src/price.test.ts (test)");
});

it("keeps the diff apart from the record, for the result panel to draw as a diff", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Fix it"], flags: [], reviews: [] });
  expect(review.diff).toBe(snapshot.diff);
  expect(review.detail).not.toContain("diff --git");
  expect(review.detail).toContain(`Content\n  tree ${snapshot.tree}\n  base ${snapshot.base}`);
});

it("says nothing about flags when no check-affecting file changed", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Fix it"], flags: [], reviews: [] });
  expect(review.summary).not.toContain("! ");
  expect(review.detail).not.toContain("Changes to how the result is checked");
});

it("shows each finding once, marks the operator's calls, and never shows an unfinished review as clean", () => {
  const tree = snapshot.tree;
  const review = inspectReview({ snapshot, checks: [check], requests: ["Charge over $100 less"], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree, status: "completed", summary: "The boundary is wrong.", findings: [
      { severity: "high", disposition: "fixable", origin: "introduced" as const, standing: "confirmed", path: "src/price.ts", line: 3, statement: "Exactly $100 is discounted",
        reason: "The request says over $100" },
      { severity: "medium", disposition: "operator", origin: "introduced" as const, statement: "Rounding is unspecified", reason: "Cents or dollars?" },
    ] },
    { reviewer: "Second reviewer", tree, status: "incomplete", reason: "the review was stopped" },
  ] });
  expect(review.summary).toContain("For the agent to fix\n  ✗ high · src/price.ts:3 — Exactly $100 is discounted");
  expect(review.summary).toContain("  ✗ Second reviewer did not finish: the review was stopped");
  expect(review.summary).toContain("? medium · not checked a second time · Rounding is unspecified");
  expect(review.detail).toContain("Review\n  Tesota reviewer\n    The boundary is wrong.\n\n    ✗ high, fixable: src/price.ts:3 — " +
    "Exactly $100 is discounted\n      The request says over $100");
  expect(review.detail).toContain("  ✗ Second reviewer did not finish (the review was stopped)");
  const clean = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree, status: "completed", summary: "Fine.", findings: [] }] });
  expect(clean.summary).toContain("  ✓ The reviewers found no problem this change caused");
  const tested = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree, status: "completed", summary: "Three claims.", findings: [
      { severity: "high", disposition: "fixable", origin: "introduced", standing: "confirmed", statement: "Real", reason: "r" },
      { severity: "high", disposition: "fixable", origin: "introduced", standing: "unsettled", statement: "Unclear", reason: "r" },
      { severity: "high", disposition: "fixable", origin: "introduced", standing: "refuted", statement: "Wrong", reason: "r",
        refutation: "Line 4 already handles it" }] }] });
  expect(tested.summary).toContain("For the agent to fix\n  ✗ high · Real");
  expect(tested.summary).toContain("Needs you\n  ? high · the second check could not decide · Unclear");
  expect(tested.summary).toContain("· 1 suspected problem was ruled out by a second check; see the result panel");
  expect(tested.summary).not.toContain("Wrong");
  expect(tested.detail).toContain("    · high, fixable: Wrong\n      r\n      Next: for context\n      Cause: this change\n      Second check: ruled out. Line 4 already handles it");
  const deep = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [],
    depth: { depth: "deep", reasons: ["changes existing tests (src/price.test.ts)", "changes 500 lines"] } });
  expect(deep.summary).toContain("  · thorough review: changes existing tests (src/price.test.ts); changes 500 lines");
  const measured = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [],
    depth: { depth: "deep", reasons: ["changes 500 lines"] },
    measurement: { at: "2026-09-25T00:00:00.000Z", depth: "deep", correction: false, durationMs: 42_400, tokens: 118_300 } });
  expect(measured.summary).toContain("  · thorough review (took 42 s and 118k tokens): changes 500 lines");
  expect(inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [], depth: { depth: "standard", reasons: [] } })
    .summary).not.toContain("thorough review");
  const context = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree, status: "completed", summary: "Only an old problem.", findings: [
      { severity: "high", disposition: "fixable", origin: "preexisting", path: "src/tax.ts", statement: "Tax ignores refunds",
        reason: "Unchanged code" }] }] });
  expect(context.summary).toContain("  ✓ The reviewers found no problem this change caused\n  · already there before · src/tax.ts — Tax ignores refunds");
});

it("shows a finding whose cause Tesota could not establish as the operator's call, with the reason in the detail", () => {
  const note = "The reviewer said this change caused it, but this change does not touch src/tax.ts.";
  const review = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree: snapshot.tree, status: "completed", summary: "One unclear.", findings: [
      { severity: "high", disposition: "fixable", origin: "unknown", originNote: note, path: "src/tax.ts", line: 9,
        statement: "Tax ignores refunds", reason: "r", standing: "confirmed" }] }] });
  expect(review.summary).toContain("  ! high · cause unclear · src/tax.ts:9 — Tax ignores refunds");
  expect(review.summary).not.toContain("no problems introduced");
  expect(review.detail).toContain(`    ! high, fixable: src/tax.ts:9 — Tax ignores refunds\n      r\n      Next: needs your decision\n      Cause: unclear. ${note}\n      Second check: confirmed`);
});

it("nests a check's claim, limits and output under it, with the output behind a gutter", () => {
  const failed = { ...check, outcome: "failed" as const, exitCode: 1, output: "\n FAIL tests/a.test.ts\n\n expected 1\n" };
  const review = inspectReview({ snapshot, checks: [check, failed], requests: [], flags: [], reviews: [] });
  expect(review.detail).toContain("Checks\n  ✓ passed (exit 0): bun run check\n    Next: for context\n" +
    "    A pass shows: exits 0\n    It does not show: only what it tests\n\n" +
    "  ✗ failed (exit 1): bun run check\n    Next: needs your decision\n    A pass shows: exits 0\n    It does not show: only what it tests\n" +
    "    │  FAIL tests/a.test.ts\n    │ \n    │  expected 1\n\nReview");
});

it("says how a failing check ended without the changes, beside it in the summary and the record", () => {
  const failed = { ...check, outcome: "failed" as const, exitCode: 1, output: "",
    base: { outcome: "failed" as const, exitCode: 1, origin: "preexisting" as const } };
  const review = inspectReview({ snapshot, checks: [failed], requests: [], flags: [], reviews: [] });
  expect(review.summary).toContain("For context\n  · bun run check (failed, exit 1)\n" +
    "      also failed (exit 1) without these changes, so it does not come from them");
  expect(review.detail).toContain("    Next: for context\n    A pass shows: exits 0\n    It does not show: only what it tests\n" +
    "    also failed (exit 1) without these changes, so it does not come from them");
});

it("names the tests that fail only with the changes when the check fails without them too", () => {
  const failed = { ...check, outcome: "failed" as const, exitCode: 1, output: "",
    base: { outcome: "failed" as const, exitCode: 1, origin: "introduced" as const, introducedTests: ["tests/a.test.ts > rounds"] } };
  const review = inspectReview({ snapshot, checks: [failed], requests: [], flags: [], reviews: [] });
  expect(review.summary).toContain("also failed (exit 1) without these changes, but this test fails only with them, " +
    "so the failure comes with them: tests/a.test.ts > rounds");
});
