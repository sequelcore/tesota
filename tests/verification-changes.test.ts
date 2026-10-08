import { expect, it } from "vitest";
import { changedLines } from "../src/diff-lines.js";
import { weakenedEvidence } from "../src/verification-changes.js";
import { weakens } from "../src/verification/weakening-rule.js";

it("weakens on a removed requires or ensures and an added assume, unless the line only moved", () => {
  expect(weakens("requires", true, false)).toBe(true);
  expect(weakens("ensures", true, false)).toBe(true);
  expect(weakens("assume", false, false)).toBe(true);
  expect(weakens("ensures", true, true)).toBe(false);
  expect(weakens("assume", false, true)).toBe(false);
  expect(weakens("requires", false, false)).toBe(false);
  expect(weakens("assume", true, false)).toBe(false);
  expect(weakens("other", true, false)).toBe(false);
});

it("reads each file's added and removed lines from a diff, and none for a file it does not show", () => {
  const diff = [
    "diff --git a/src/a b.ts b/src/a b.ts",
    "--- a/src/a b.ts",
    "+++ b/src/a b.ts",
    "@@ -1,2 +1,2 @@",
    " kept",
    "--- removed, not a header",
    "+added\r",
    "\\ No newline at end of file",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");
  expect(changedLines(diff, [{ path: "src/a b.ts", status: "modified" }, { path: "img.png", status: "modified" },
    { path: "gone.ts", status: "deleted" }])).toEqual([
    { path: "src/a b.ts", status: "modified", added: ["added"], removed: ["-- removed, not a header"] },
    { path: "img.png", status: "modified", added: [], removed: [] },
    { path: "gone.ts", status: "deleted", added: [], removed: [] },
  ]);
});

it("flags weakened contracts, added assumptions and deleted or edited tests, and nothing else", () => {
  expect(weakenedEvidence([
    { path: "src/policy.ts", status: "modified",
      removed: ["//@ ensures denied(p) ==> \\result === false", "//@ requires p !== \"\"", "//@ invariant k >= 0",
        "  //@ ensures \\result >= 0"],
      added: ["//@ ensures true", "//@ assume p.length > 0", "//@ invariant k > 0", "//@ ensures  \\result >= 0"] },
    { path: "src/plain.ts", status: "modified", removed: ["// @ensures x"], added: ["// @assume y"] },
    { path: "src/price.test.ts", status: "modified", removed: [], added: [] },
    { path: "tests/tax.spec.tsx", status: "deleted", removed: ["it()"], added: [] },
    { path: "pkg/__tests__/cart.js", status: "added", removed: [], added: ["it()"] },
    { path: "app/test_orders.py", status: "modified", removed: [], added: [] },
    { path: "internal/orders_test.go", status: "modified", removed: [], added: [] },
    { path: "src/contest.ts", status: "modified", removed: [], added: [] },
  ])).toEqual([
    { path: "src/policy.ts", kind: "removed_contract", annotation: "//@ ensures denied(p) ==> \\result === false" },
    { path: "src/policy.ts", kind: "removed_contract", annotation: "//@ requires p !== \"\"" },
    { path: "src/policy.ts", kind: "added_assume", annotation: "//@ assume p.length > 0" },
    { path: "src/price.test.ts", kind: "edited_test" },
    { path: "tests/tax.spec.tsx", kind: "deleted_test" },
    { path: "app/test_orders.py", kind: "edited_test" },
    { path: "internal/orders_test.go", kind: "edited_test" },
  ]);
});
