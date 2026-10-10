import { expect, it } from "vitest";
import { type RemovedLine, changedLines } from "../src/diff-lines.js";
import { bodilessLemmas, type FileChange, weakenedEvidence } from "../src/verification-changes.js";
import { removalCounts, testWeakens } from "../src/verification/test-weakening-rule.js";
import { weakens } from "../src/verification/weakening-rule.js";

const numbered = (...lines: string[]): RemovedLine[] => lines.map((text, k) => ({ number: k + 1, base: k + 1, text }));

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

it("weakens tests on a deleted file, or an edit that removes a line that counts or changes how tests run", () => {
  expect(removalCounts(false, false, false)).toBe(true);
  expect(removalCounts(true, false, false)).toBe(false);
  expect(removalCounts(false, true, false)).toBe(false);
  expect(removalCounts(false, false, true)).toBe(false);
  expect(testWeakens("deleted", false, false)).toBe(true);
  expect(testWeakens("modified", true, false)).toBe(true);
  expect(testWeakens("modified", false, true)).toBe(true);
  expect(testWeakens("modified", false, false)).toBe(false);
  expect(testWeakens("added", true, true)).toBe(false);
});

const edit = (path: string, added: string[], removed: string[] = []): FileChange =>
  ({ path, status: "modified", added: numbered(...added), removed: numbered(...removed) });

it("does not flag a test file that only gains tests, blank lines or comments, or loses blank or comment lines", () => {
  // A JavaScript or TypeScript file's comment lines are read from its content, here only the lines the change shows.
  const added = ["", "it(\"clamps below\", () => {", "  expect(clamp(-1, 0, 2)).toBe(0);", "});", "// it.only would focus it",
    "const skipped = items.filter(Boolean);"];
  const removed = ["", "// an old note", "  /* wrapped", "   * note */"];
  expect(weakenedEvidence([
    { ...edit("tests/clamp.test.ts", added, removed), content: added.join("\n"), baseContent: removed.join("\n") },
    edit("app/test_orders.py", ["# @pytest.mark.skip later", "def test_total():", "    assert total(1) == 1",
      "@pytest.fixture", "def order():"], ["# old note"]),
    edit("internal/orders_test.go", ["func TestTotal(t *testing.T) {", "\tif total(1) != 1 {", "\t\tt.Fatal(\"total\")", "\t}", "}"]),
  ])).toEqual([]);
});

it("does not count an import the change widened, and counts one it retargets, narrows or drops", () => {
  const was = "import { clamp } from \"../src/clamp.ts\";";
  expect(weakenedEvidence([
    edit("tests/clamp.test.ts", ["import { clamp, inRange } from \"../src/clamp.ts\";"], [was]),
    edit("tests/both.test.ts", ["import clamp, {  inRange ,  lo as low } from '../src/clamp'"],
      ["import clamp, { lo as low } from '../src/clamp'"]),
    edit("tests/test_price.py", ["from price import total, tax"], ["from price import total"]),
  ])).toEqual([]);
  expect(weakenedEvidence([
    edit("tests/retarget.test.ts", ["import { clamp } from \"../src/fake.ts\";"], [was]),
    edit("tests/narrow.test.ts", ["import { inRange } from \"../src/clamp.ts\";"], [was]),
    edit("tests/type.test.ts", ["import type { clamp, inRange } from \"../src/clamp.ts\";"], [was]),
    edit("tests/setup.test.ts", [], ["import \"./setup\";"]),
    edit("tests/test_tax.py", ["from fake import total, tax"], ["from price import total"]),
  ]).map(({ path }) => path)).toEqual(["tests/retarget.test.ts", "tests/narrow.test.ts", "tests/type.test.ts",
    "tests/setup.test.ts", "tests/test_tax.py"]);
});

it("flags a test file that gains a focus or skip marker, a setup or teardown hook, or a module mock", () => {
  const added = [
    "it.only(\"x\", () => {});", "describe.skip(\"x\", () => {});", "test.todo(\"x\");", "it.skipIf(ci)(\"x\", () => {});",
    "xit(\"x\", () => {});", "xdescribe(\"x\", () => {});", "fit(\"x\", () => {});", "fdescribe(\"x\", () => {});",
    "beforeEach(() => {});", "beforeAll(() => {});", "afterEach(() => {});", "afterAll(() => {});",
    "vi.mock(\"../src/price\");", "jest.mock(\"../src/price\");", "mock.module(\"../src/price\", () => ({}));",
  ];
  for (const line of added) expect(weakenedEvidence([edit("tests/price.test.ts", [line])]), line).toHaveLength(1);
  for (const line of ["@Disabled", "@DisabledOnOs(OS.WINDOWS)", "@Ignore", "@BeforeEach", "@BeforeAll", "@AfterEach",
    "@AfterAll", "@Before", "@After", "@BeforeClass", "@AfterClass"]) {
    expect(weakenedEvidence([edit("src/test/java/PriceTest.java", [line])]), line).toHaveLength(1);
  }
  for (const line of ["@pytest.mark.skip", "@pytest.mark.skipif(True, reason=\"x\")", "@pytest.mark.xfail",
    "    pytest.skip(\"x\")", "@pytest.fixture(autouse=True)", "@unittest.skip(\"x\")", "    def setUp(self):",
    "    def tearDown(self):", "    def setUpClass(cls):", "def setup_method(self):", "def teardown_module():"]) {
    expect(weakenedEvidence([edit("tests/test_price.py", [line])]), line).toHaveLength(1);
  }
  expect(weakenedEvidence([edit("tests/price.rs", ["#[ignore]"])])).toHaveLength(1);
  for (const line of ["\tt.Skip(\"x\")", "\tt.SkipNow()", "\tt.Skipf(\"%d\", 1)", "func TestMain(m *testing.M) {"]) {
    expect(weakenedEvidence([edit("internal/price_test.go", [line])]), line).toHaveLength(1);
  }
});

it("flags a removed, changed or commented-out assertion, and a deleted test file", () => {
  const assertion = "  expect(clamp(5, 0, 2)).toBe(2);";
  expect(weakenedEvidence([
    edit("tests/removed.test.ts", [], [assertion]),
    edit("tests/changed.test.ts", ["  expect(clamp(5, 0, 2)).toBeDefined();"], [assertion]),
    edit("tests/commented.test.ts", ["  // expect(clamp(5, 0, 2)).toBe(2);"], [assertion]),
    edit("tests/moved.test.ts", [assertion], [assertion]),
    edit("tests/contract.test.ts", [], ["  //@ invariant k >= 0"]),
    { path: "tests/gone.test.ts", status: "deleted", added: [], removed: numbered(assertion) },
  ])).toEqual([
    { path: "tests/removed.test.ts", kind: "edited_test" },
    { path: "tests/changed.test.ts", kind: "edited_test" },
    { path: "tests/commented.test.ts", kind: "edited_test" },
    { path: "tests/moved.test.ts", kind: "edited_test" },
    { path: "tests/contract.test.ts", kind: "edited_test" },
    { path: "tests/gone.test.ts", kind: "deleted_test" },
  ]);
});

it("reads each file's added and removed lines with their numbers, a removed one's also before the change, and none for a file it does not show", () => {
  const diff = [
    "diff --git a/src/a b.ts b/src/a b.ts",
    "--- a/src/a b.ts",
    "+++ b/src/a b.ts",
    "@@ -1,2 +1,2 @@",
    " kept",
    "--- removed, not a header",
    "+added\r",
    "\\ No newline at end of file",
    "@@ -9 +10 @@",
    "-earlier",
    "+later",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");
  expect(changedLines(diff, [{ path: "src/a b.ts", status: "modified" }, { path: "img.png", status: "modified" },
    { path: "gone.ts", status: "deleted" }])).toEqual([
    { path: "src/a b.ts", status: "modified", added: [{ number: 2, text: "added" }, { number: 10, text: "later" }],
      removed: [{ number: 2, base: 2, text: "-- removed, not a header" }, { number: 10, base: 9, text: "earlier" }] },
    { path: "img.png", status: "modified", added: [], removed: [] },
    { path: "gone.ts", status: "deleted", added: [], removed: [] },
  ]);
});

it("flags weakened contracts, added assumptions and deleted or edited tests, and nothing else", () => {
  expect(weakenedEvidence([
    { path: "src/policy.ts", status: "modified",
      removed: numbered("//@ ensures denied(p) ==> \\result === false", "//@ requires p !== \"\"", "//@ invariant k >= 0",
        "  //@ ensures \\result >= 0"),
      added: numbered("//@ ensures true", "//@ assume p.length > 0", "//@ invariant k > 0", "//@ ensures  \\result >= 0") },
    { path: "src/plain.ts", status: "modified", removed: numbered("// @ensures x"), added: numbered("// @assume y") },
    { path: "src/policy.dfy", status: "modified", removed: numbered("  assume old;"),
      added: numbered("  assume {:axiom} false;", "  // assume nothing", "  assume old;", "  assert x;") },
    { path: "src/new.dfy", status: "added", removed: [], added: numbered("assume x;") },
    { path: "src/price.test.ts", status: "modified", removed: numbered("expect(total(1)).toBe(1);"), added: [] },
    { path: "tests/tax.spec.tsx", status: "deleted", removed: numbered("it()"), added: [] },
    { path: "pkg/__tests__/cart.js", status: "added", removed: [], added: numbered("it.only()") },
    { path: "app/test_orders.py", status: "modified", removed: [], added: numbered("@pytest.mark.skip") },
    { path: "internal/orders_test.go", status: "modified", removed: numbered("\tif got != 1 {"), added: [] },
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
  expect(weakenedEvidence([{ path: "src/rule.dfy", status: "modified", removed: numbered("{", "}"),
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

it("reads a test file's comment lines from its parsed content, inside a block comment or a template alike", () => {
  const removedFrom = (path: string, baseContent: string, base: number): FileChange => {
    const lines = baseContent.split("\n");
    return { path, status: "modified", added: [], removed: [{ number: base, base, text: lines[base - 1] ?? "" }],
      content: [...lines.slice(0, base - 1), ...lines.slice(base)].join("\n"), baseContent };
  };
  // A plain middle line of a block comment holds no check; a `//` line inside a template is part of what the test compares.
  const noted = "/* setup\n   plain notes\n*/\nit(\"adds\", () => expect(add(1, 1)).toBe(2));\n";
  const templated = "it(\"keeps\", () => expect(`\n// keep\n`).toContain(\"keep\"));\n";
  expect(weakenedEvidence([removedFrom("tests/noted.test.ts", noted, 2)])).toEqual([]);
  expect(weakenedEvidence([removedFrom("tests/templated.test.ts", templated, 2)]))
    .toEqual([{ path: "tests/templated.test.ts", kind: "edited_test" }]);
  // Without the content, no line is taken for a comment.
  expect(weakenedEvidence([{ ...removedFrom("tests/noted.test.ts", noted, 2), content: undefined, baseContent: undefined }]))
    .toEqual([{ path: "tests/noted.test.ts", kind: "edited_test" }]);
});
