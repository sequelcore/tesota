import { expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { inspectReview } from "../src/tesota-shell-inspection.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";

const snapshot: WorkspaceSnapshot = { base: "b".repeat(40), tree: "t".repeat(40), diff: "diff --git a/src/price.ts b/src/price.ts",
  changes: [{ status: "modified", path: "src/price.ts" }, { status: "modified", path: "src/price.test.ts" }] };
const check = { command: "bun run check", tree: snapshot.tree, environment: "host", guarantees: hostProvider.guarantees,
  outcome: "passed" as const, exitCode: 0, durationMs: 1, output: "" };

it("lists changes to what gets checked as the operator's decision, and the requests behind the result", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Charge over $100 less", "Keep the old test"],
    flags: [{ path: "src/price.test.ts", status: "modified", kind: "test" }] });
  expect(review.summary).toContain("  ✓ bun run check\n  ⚠ edited test: src/price.test.ts\n");
  expect(review.summary).toContain("only you can decide whether they are legitimate");
  expect(review.detail).toMatch(/^Requested\n {2}1\. Charge over \$100 less\n {2}2\. Keep the old test\n/u);
  expect(review.detail).toContain("Changes to what gets checked\n  modified src/price.test.ts (test)");
});

it("says nothing about flags when no check-affecting file changed", () => {
  const review = inspectReview({ snapshot, checks: [check], requests: ["Fix it"], flags: [] });
  expect(review.summary).not.toContain("⚠");
  expect(review.detail).not.toContain("Changes to what gets checked");
});
