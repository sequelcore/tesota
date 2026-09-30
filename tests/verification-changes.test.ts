import { expect, it } from "vitest";
import { flagVerificationChanges } from "../src/verification-changes.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";

function snapshot(changes: WorkspaceSnapshot["changes"], diff = ""): WorkspaceSnapshot {
  return { base: "b".repeat(40), tree: "t".repeat(40), changes, diff };
}

const noFiles = (): undefined => undefined;

it("flags changes to tests, check configuration, CI and Tesota setup, and nothing else", () => {
  const flags = flagVerificationChanges(snapshot([
    { status: "modified", path: "src/price.ts" },
    { status: "modified", path: "src/price.test.ts" },
    { status: "deleted", path: "tests/tax.spec.tsx" },
    { status: "added", path: "pkg/__tests__/cart.js" },
    { status: "modified", path: "app/test_orders.py" },
    { status: "modified", path: "internal/orders_test.go" },
    { status: "modified", path: "tsconfig.build.json" },
    { status: "modified", path: ".oxlintrc.json" },
    { status: "modified", path: "vitest.config.ts" },
    { status: "added", path: ".github/workflows/ci.yml" },
    { status: "modified", path: ".tesota/setup.sh" },
    { status: "modified", path: "docs/testing.md" },
    { status: "modified", path: "src/contest.ts" },
  ]), noFiles);
  expect(flags).toEqual([
    { path: "src/price.test.ts", status: "modified", kind: "test" },
    { path: "tests/tax.spec.tsx", status: "deleted", kind: "test" },
    { path: "pkg/__tests__/cart.js", status: "added", kind: "test" },
    { path: "app/test_orders.py", status: "modified", kind: "test" },
    { path: "internal/orders_test.go", status: "modified", kind: "test" },
    { path: "tsconfig.build.json", status: "modified", kind: "check configuration" },
    { path: ".oxlintrc.json", status: "modified", kind: "check configuration" },
    { path: "vitest.config.ts", status: "modified", kind: "check configuration" },
    { path: ".github/workflows/ci.yml", status: "added", kind: "CI workflow" },
    { path: ".tesota/setup.sh", status: "modified", kind: "Tesota setup" },
  ]);
});

it("flags package.json only when its scripts change", () => {
  const read = (revision: string, path: string): string | undefined => path !== "package.json" ? undefined :
    revision.startsWith("b") ? JSON.stringify({ version: "1.0.0", scripts: { test: "vitest run" } })
      : JSON.stringify({ version: "1.1.0", scripts: { test: "vitest run || true" } });
  expect(flagVerificationChanges(snapshot([{ status: "modified", path: "package.json" }]), read))
    .toEqual([{ path: "package.json", status: "modified", kind: "package scripts" }]);
  const versionOnly = (revision: string): string => JSON.stringify({ version: revision.startsWith("b") ? "1.0.0" : "1.1.0",
    scripts: { test: "vitest run" } });
  expect(flagVerificationChanges(snapshot([{ status: "modified", path: "package.json" }]), versionOnly)).toEqual([]);
});

it("flags formal specification files and changed //@ annotations in source", () => {
  const diff = [
    "diff --git a/src/policy.ts b/src/policy.ts",
    "--- a/src/policy.ts",
    "+++ b/src/policy.ts",
    "@@ -1,3 +1,3 @@",
    "-//@ ensures denied(p) ==> \result === false",
    "+//@ ensures true",
    " export function canAccess(p: string): boolean {",
    "diff --git a/src/plain.ts b/src/plain.ts",
    "--- a/src/plain.ts",
    "+++ b/src/plain.ts",
    "@@ -1 +1 @@",
    "-export const x = 1; // @ not an annotation",
    "+export const x = 2;",
    "",
  ].join("\n");
  expect(flagVerificationChanges(snapshot([
    { status: "modified", path: "src/policy.ts" },
    { status: "modified", path: "src/plain.ts" },
    { status: "added", path: "proofs/policy.dfy" },
  ], diff), noFiles)).toEqual([
    { path: "src/policy.ts", status: "modified", kind: "formal specification" },
    { path: "proofs/policy.dfy", status: "added", kind: "formal specification" },
  ]);
});
