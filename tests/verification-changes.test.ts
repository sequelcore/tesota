import { expect, it } from "vitest";
import { type AddedLine, changedLines } from "../src/diff-lines.js";
import { bodilessLemmas, weakenedEvidence } from "../src/verification-changes.js";
import { weakens } from "../src/verification/weakening-rule.js";

const numbered = (...lines: string[]): AddedLine[] => lines.map((text, k) => ({ number: k + 1, text }));

it("weakens on a removed requires or ensures, a requires added to an existing function and an added assume, unless the line only moved", () => {
  expect(weakens("requires", true, false, true)).toBe(true);
  expect(weakens("ensures", true, false, true)).toBe(true);
  expect(weakens("assume", false, false, false)).toBe(true);
  expect(weakens("requires", false, false, true)).toBe(true);
  expect(weakens("requires", false, false, false)).toBe(false);
  expect(weakens("ensures", false, false, true)).toBe(false);
  expect(weakens("ensures", true, true, true)).toBe(false);
  expect(weakens("assume", false, true, false)).toBe(false);
  expect(weakens("requires", false, true, true)).toBe(false);
  expect(weakens("assume", true, false, false)).toBe(false);
  expect(weakens("other", true, false, true)).toBe(false);
});

it("reads each file's added lines with their numbers and its removed lines, and none for a file it does not show", () => {
  const diff = [
    "diff --git a/src/a b.ts b/src/a b.ts",
    "--- a/src/a b.ts",
    "+++ b/src/a b.ts",
    "@@ -1,2 +1,2 @@",
    " kept",
    "--- removed, not a header",
    "+added\r",
    "\\ No newline at end of file",
    "@@ -9,0 +10 @@",
    "+later",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");
  expect(changedLines(diff, [{ path: "src/a b.ts", status: "modified" }, { path: "img.png", status: "modified" },
    { path: "gone.ts", status: "deleted" }])).toEqual([
    { path: "src/a b.ts", status: "modified", added: [{ number: 2, text: "added" }, { number: 10, text: "later" }],
      removed: ["-- removed, not a header"] },
    { path: "img.png", status: "modified", added: [], removed: [] },
    { path: "gone.ts", status: "deleted", added: [], removed: [] },
  ]);
});

it("flags weakened contracts, added assumptions and deleted or edited tests, and nothing else", () => {
  expect(weakenedEvidence([
    { path: "src/policy.ts", status: "modified",
      removed: ["//@ ensures denied(p) ==> \\result === false", "//@ requires p !== \"\"", "//@ invariant k >= 0",
        "  //@ ensures \\result >= 0"],
      added: numbered("//@ ensures true", "//@ assume p.length > 0", "//@ invariant k > 0", "//@ ensures  \\result >= 0") },
    { path: "src/plain.ts", status: "modified", removed: ["// @ensures x"], added: numbered("// @assume y") },
    { path: "src/policy.dfy", status: "modified", removed: ["  assume old;"],
      added: numbered("  assume {:axiom} false;", "  // assume nothing", "  assume old;", "  assert x;") },
    { path: "src/new.dfy", status: "added", removed: [], added: numbered("assume x;") },
    { path: "src/price.test.ts", status: "modified", removed: [], added: [] },
    { path: "tests/tax.spec.tsx", status: "deleted", removed: ["it()"], added: [] },
    { path: "pkg/__tests__/cart.js", status: "added", removed: [], added: numbered("it()") },
    { path: "app/test_orders.py", status: "modified", removed: [], added: [] },
    { path: "internal/orders_test.go", status: "modified", removed: [], added: [] },
    { path: "src/contest.ts", status: "modified", removed: [], added: [] },
  ])).toEqual([
    { path: "src/policy.ts", kind: "removed_contract", annotation: "//@ ensures denied(p) ==> \\result === false" },
    { path: "src/policy.ts", kind: "removed_contract", annotation: "//@ requires p !== \"\"" },
    { path: "src/policy.ts", kind: "added_assume", annotation: "//@ assume p.length > 0" },
    { path: "src/policy.dfy", kind: "added_assume", annotation: "assume {:axiom} false;" },
    { path: "src/new.dfy", kind: "added_assume", annotation: "assume x;" },
    { path: "src/price.test.ts", kind: "edited_test" },
    { path: "tests/tax.spec.tsx", kind: "deleted_test" },
    { path: "app/test_orders.py", kind: "edited_test" },
    { path: "internal/orders_test.go", kind: "edited_test" },
  ]);
});

it("finds lemmas declared without a body, whatever their attributes, and not those with one", () => {
  const dafny = [
    "lemma {:axiom} Trusted(x: int)", "  ensures x > 0", "",
    "ghost lemma Bare(x: int) ensures x < 0", "method M() {", "}", "",
    "lemma Proved(x: int)", "  ensures x == x", "{", "}", "",
    "lemma Inline() ensures true {}",
    "lemma Brace(s: set<int>)", "  ensures s <= s {", "}",
    "// lemma Commented()", "/* lemma Hidden()", "*/",
    "module Inner {", "  lemma Last()", "}",
  ].join("\n");
  expect(bodilessLemmas(dafny)).toEqual(["Trusted", "Bare", "Last"]);
});

it("flags an {:axiom} and a lemma left without a body in a proof, unless the base had it so", () => {
  const baseContent = "lemma Old()\n  ensures true\n\nlemma Kept()\n  ensures true\n{\n}\n";
  const content = "lemma Old()\n  ensures true\n\nlemma Kept()\n  ensures true\n\nlemma {:axiom} New()\n  ensures false\n";
  expect(weakenedEvidence([{ path: "src/rule.dfy", status: "modified", removed: ["{", "}"],
    added: [{ number: 7, text: "lemma {:axiom} New()" }, { number: 8, text: "  ensures false" },
      { number: 9, text: "  // not {:axiom} here" }], content, baseContent }])).toEqual([
    { path: "src/rule.dfy", kind: "added_assume", annotation: "lemma {:axiom} New()" },
    { path: "src/rule.dfy", kind: "added_assume", annotation: "lemma Kept without a body" },
    { path: "src/rule.dfy", kind: "added_assume", annotation: "lemma New without a body" },
  ]);
});

it("flags a requires added to a function the base had, or one it cannot place, and not one on a new function", () => {
  const content = ["//@ requires x > 0", "export function old(x: number): number { return x; }", "",
    "//@ requires y > 0", "export function fresh(y: number): number { return y; }", "", "//@ requires z > 0", ""].join("\n");
  const added = [{ number: 1, text: "//@ requires x > 0" }, { number: 4, text: "//@ requires y > 0" },
    { number: 5, text: "export function fresh(y: number): number { return y; }" }, { number: 7, text: "//@ requires z > 0" }];
  const baseContent = "export function old(x: number): number { return x; }\n";
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed: [], added, content, baseContent }])).toEqual([
    { path: "src/rule.ts", kind: "added_requires", annotation: "//@ requires x > 0" },
    { path: "src/rule.ts", kind: "added_requires", annotation: "//@ requires z > 0" },
  ]);
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "added", removed: [], added, content }])).toEqual([]);
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed: [], added, content: undefined, baseContent }]))
    .toHaveLength(3);
});
