import { expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { inspectReview } from "../src/tesota-shell-inspection.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";

const snapshot: WorkspaceSnapshot = { base: "b".repeat(40), tree: "t".repeat(40), diff: "diff --git a/src/price.ts b/src/price.ts",
  changes: [{ status: "modified", path: "src/price.ts" }, { status: "modified", path: "src/price.test.ts" }] };
const check = { verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command: "bun run check", tree: snapshot.tree, environment: "host", guarantees: hostProvider.guarantees,
  outcome: "passed" as const, exitCode: 0, durationMs: 1, output: "" };

it("lists changes to what gets checked as the operator's decision, and the requests behind the result", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Charge over $100 less", "Keep the old test"],
    flags: [{ path: "src/price.test.ts", status: "modified", kind: "test" }], reviews: [] });
  expect(review.summary).toContain("  ✓ bun run check\n  ⚠ edited test: src/price.test.ts\n");
  expect(review.summary).toContain("only you can decide whether they are legitimate");
  expect(review.detail).toMatch(/^Requested\n {2}1\. Charge over \$100 less\n {2}2\. Keep the old test\n/u);
  expect(review.detail).toContain("Changes to what gets checked\n  modified src/price.test.ts (test)");
});

it("says nothing about flags when no check-affecting file changed", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Fix it"], flags: [], reviews: [] });
  expect(review.summary).not.toContain("⚠");
  expect(review.detail).not.toContain("Changes to what gets checked");
});

it("shows each finding once, marks the operator's calls, and never shows an unfinished review as clean", () => {
  const tree = snapshot.tree;
  const review = inspectReview({ snapshot, checks: [check], requests: ["Charge over $100 less"], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree, status: "completed", summary: "The boundary is wrong.", findings: [
      { severity: "high", disposition: "fixable", path: "src/price.ts", line: 3, statement: "Exactly $100 is discounted",
        reason: "The request says over $100" },
      { severity: "medium", disposition: "operator", statement: "Rounding is unspecified", reason: "Cents or dollars?" },
    ] },
    { reviewer: "Second reviewer", tree, status: "incomplete", reason: "the review was stopped" },
  ] });
  expect(review.summary).toContain("  ✗ high · src/price.ts:3 — Exactly $100 is discounted\n" +
    "  ⚠ needs you · Rounding is unspecified\n  ✗ Second reviewer did not finish: the review was stopped");
  expect(review.detail).toContain("Review\n  Tesota reviewer\n  The boundary is wrong.\n\n  high, fixable: src/price.ts:3 — " +
    "Exactly $100 is discounted\n  The request says over $100");
  const clean = inspectReview({ snapshot, checks: [check], requests: [], flags: [], reviews: [
    { reviewer: "Tesota reviewer", tree, status: "completed", summary: "Fine.", findings: [] }] });
  expect(clean.summary).toContain("  ✓ Tesota reviewer: no problems found");
});
