import { expect, it } from "vitest";
import { type RemovedLine, changedLines } from "../src/diff-lines.js";
import { bodilessLemmas, commentLines, type FileChange, provedOnTrust, weakenedEvidence, withGrammarComments }
  from "../src/verification-changes.js";
import { addsItems, removalCounts, testWeakens, type Token, type TokenKind } from "../src/verification/test-weakening-rule.js";
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
  expect(weakens("skip", false, false, true)).toBe(true);
  expect(weakens("skip", false, false, false)).toBe(false);
  expect(weakens("skip", false, true, true)).toBe(false);
  expect(weakens("skip", true, false, true)).toBe(false);
});

it("weakens tests on a deleted file, or an edit that removes a line that counts or changes how tests run", () => {
  expect(removalCounts(false, false, false, false)).toBe(true);
  expect(removalCounts(true, false, false, false)).toBe(false);
  expect(removalCounts(false, true, false, false)).toBe(false);
  expect(removalCounts(false, false, true, false)).toBe(false);
  expect(removalCounts(false, false, false, true)).toBe(false);
  expect(testWeakens("deleted", false, false)).toBe(true);
  expect(testWeakens("modified", true, false)).toBe(true);
  expect(testWeakens("modified", false, true)).toBe(true);
  expect(testWeakens("modified", false, false)).toBe(false);
  expect(testWeakens("added", true, true)).toBe(false);
});

it("admits a replacement only with an alignment that keeps every token and adds whole list items without a check", () => {
  const t = (text: string, kind: TokenKind = "plain"): Token => ({ text, kind });
  const open = t("(", "open");
  const close = t(")", "close");
  const comma = t(",", "separator");
  const call = ["f", "(", "a", ")"];
  // f(a) → f(a, b), f(b, a) and f(a), g(b): an argument at the end, one at the start, and one after the call's end.
  expect(addsItems(call, [t("f"), open, t("a"), comma, t("b"), close], [0, 1, 2, 5])).toBe(true);
  expect(addsItems(call, [t("f"), open, t("b"), comma, t("a"), close], [0, 1, 4, 5])).toBe(true);
  expect(addsItems(call, [t("f"), open, t("a"), close, comma, t("g"), open, t("b"), close], [0, 1, 2, 3])).toBe(true);
  // f() → f(b): the first item of an empty list.
  expect(addsItems(["f", "(", ")"], [t("f"), open, t("b"), close], [0, 1, 3])).toBe(true);
  const extended = [t("f"), open, t("a"), comma, t("b"), close];
  expect(addsItems(call, extended, [0, 1, 4, 5])).toBe(false);
  expect(addsItems(call, extended, [0, 1, 2])).toBe(false);
  expect(addsItems(call, extended, [0, 2, 1, 5])).toBe(false);
  expect(addsItems(call, extended, [0, 1, 2, 6])).toBe(false);
  // f(a) → f(a, skip): an added token that checks or skips something.
  expect(addsItems(call, [t("f"), open, t("a"), comma, t("skip", "check"), close], [0, 1, 2, 5])).toBe(false);
  // f(a) → f(a b): an added token that is no list item.
  expect(addsItems(call, [t("f"), open, t("a"), t("b"), close], [0, 1, 2, 4])).toBe(false);
  // f(a, b) → f(a, x), g(y, b): balanced, but it closes the list it was added to.
  expect(addsItems(["f", "(", "a", ",", "b", ")"], [t("f"), open, t("a"), comma, t("x"), close, comma, t("g"), open, t("y"),
    comma, t("b"), close], [0, 1, 2, 3, 11, 12])).toBe(false);
  // f(a) → f(a, (b): a bracket the item does not close.
  expect(addsItems(call, [t("f"), open, t("a"), comma, open, t("b"), close], [0, 1, 2, 6])).toBe(false);
});

/** A file's change from one hunk at its first line, its lines marked " ", "-" or "+" as Git shows them, with its content on both sides. */
const hunk = (path: string, lines: string[]): FileChange => {
  const base = lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
  const now = lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
  const diff = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${base.length} +1,${now.length} @@`, ...lines];
  const [file] = changedLines(diff.join("\n"), [{ path, status: "modified" }]);
  if (file === undefined) throw new Error("no change");
  return { ...file, content: now.join("\n"), baseContent: base.join("\n") };
};

it("does not flag removed test lines whose replacements only gain arguments, properties or parameters (#578, #583)", () => {
  // PR #578: a helper's parameter list and destructuring each gained one option.
  const shell = hunk("packages/core/tests/shell.test.ts", [
    " function shellOn(script: readonly ScriptStep[], mode: TuiMode = \"fullscreen\", size: [number, number] = [80, 24],",
    "   extra: { tokensPerSecond?: number; copy?: (text: string) => Promise<boolean>; commands?: readonly SlashCommand[]; surface?: Surface;",
    "-    cwd?: string; command?: (text: string) => Promise<boolean> } = {}) {",
    "+    cwd?: string; command?: (text: string) => Promise<boolean>; answersQueriesAfterMs?: number } = {}) {",
    "   const faux = fauxProvider({ tokensPerSecond: extra.tokensPerSecond ?? 400 });",
    "   faux.setResponses(script.map(scriptedReply));",
    "   const models = createModels();",
    "   models.setProvider(faux.provider);",
    "-  const { cwd = folder(\"tesota-core-shell-\"), ...options } = extra;",
    "+  const { cwd = folder(\"tesota-core-shell-\"), answersQueriesAfterMs, ...options } = extra;",
    "   const session = createSession({ cwd, folder: folder(\"tesota-core-sessions-\"), models, model: faux.getModel(), verifier: accepts });",
    "   const terminal = new VirtualTerminal(...size);",
    "+  terminal.answersQueriesAfterMs = answersQueriesAfterMs;",
    "   const shell = startShell({ terminal, mode, fullRepaint: false, theme: shellTheme(\"dark\", \"truecolor\"), session,",
    "     status: () => \"scripted model\", ...options });",
    "   open.push({ session, shell });",
    "   return { terminal, session, shell };",
    " }",
  ]);
  // PR #583: calls that gained an argument.
  const claudeCode = hunk("packages/core/tests/claude-code.test.ts", [
    " function provider(start: StartQuery) {",
    "   const models = createModels();",
    "   const model = (id: string): Model<\"anthropic-messages\"> => models.getModel(\"claude-code\", id) as Model<\"anthropic-messages\">;",
    "   const step = async (messages: Message[], options: { sessionId?: string; signal?: AbortSignal; model?: string } = {}): Promise<AssistantMessage> =>",
    "     await models.streamSimple(model(options.model ?? \"claude-haiku-4-5\"), { systemPrompt, messages, tools: [echo] },",
    "-      { sessionId: options.sessionId ?? \"session-1\", ...options.signal === undefined ? {} : { signal: options.signal } }).result();",
    "+      { metadata: { cwd: process.cwd() }, sessionId: options.sessionId ?? \"session-1\", ...options.signal === undefined ? {} : { signal: options.signal } }).result();",
    "   return { models, step };",
    " }",
  ]);
  const compaction = hunk("packages/core/tests/compaction.test.ts", [
    " function scripted(responses: FauxResponseStep[], overrides: Partial<SummaryRequest> = {}) {",
    "   const models = createModels();",
    "   const request: SummaryRequest = {",
    "-    models, model: faux.getModel(), previous: undefined, messages: [],",
    "+    cwd: process.cwd(), models, model: faux.getModel(), previous: undefined, messages: [],",
    "     files: { read: [], changed: [] }, signal: new AbortController().signal, ...overrides,",
    "   };",
    "   return { faux, request };",
    " }",
    " ",
    " test(\"the model receives the fixed contract and a single text transcript with bounded tool results\", async () => {",
    "   const signal = new AbortController().signal;",
    "   const { faux, request } = scripted([(context, options) => {",
    "     expect(options?.signal).toBe(signal);",
    "+    expect(options?.metadata).toEqual({ cwd: \"session-worktree\" });",
    "     expect(context.messages).toHaveLength(2);",
    "     return fauxAssistantMessage([{ type: \"text\", text: \"  compact summary  \" }]);",
    "-  }], { signal, messages: [",
    "+  }], { cwd: \"session-worktree\", signal, messages: [",
    "     { role: \"system\", content: \"Earlier instructions\", timestamp: 0 },",
    "   ] });",
    "   expect(await summarize(request)).toMatchObject({ summary: \"compact summary\" });",
    " });",
  ]);
  expect([shell, claudeCode, compaction].map(({ removed }) => removed.length)).toEqual([2, 1, 2]);
  expect(weakenedEvidence([shell, claudeCode, compaction])).toEqual([]);
});

it("flags an in-place edit that changes an assertion, its expected value, a skip or a return, or adds more than list items", () => {
  const cases: [string, string[]][] = [
    ["assertion", ["-  expect(near(1)).toBeCloseTo(1);", "+  expect(near(1)).toBeCloseTo(1, -5);"]],
    ["expected", [" it(\"lists\", () => {", "   expect(list()).toEqual([", "-    \"a\",", "+    \"a\", \"b\",", "   ]);", " });"]],
    ["test", ["-it(\"adds\", () => {", "+it(\"adds\", { skip: true }, () => {", "   run();", " });"]],
    ["options", [" it(\"adds\",", "-  { timeout: 1000 },", "+  { todo: true, timeout: 1000 },", "   () => run());"]],
    ["retry", [" it(\"adds\",", "-  { mode: \"fast\" },", "+  { retry: 3, mode: \"fast\" },", "   () => run());"]],
    ["return", [" it(\"adds\", () => {", "-  run(input);", "+  run(input); return;", "   check(input);", " });"]],
    ["changed", ["-const total = sum([1, 2]);", "+const total = sum([1, 3]);"]],
    ["regrouped", ["-const total = add(a, b);", "+const total = add(a, x), other(y, b);"]],
    // An added item that opens a comment or a template, which would take in the lines after it.
    ["comment", ["-const order = create(base", "+const order = create(base, /*", "   , { total: 1 });", "+*/);"]],
    ["template", ["-const order = create(base", "+const order = create(base, `", "   , { total: 1 });", "+`);"]],
    ["elsewhere", ["-setup(a);", " check(a);", "+setup(a, b);"]],
  ];
  const changes = cases.map(([name, lines]) => hunk(`tests/${name}.test.ts`, lines));
  expect(weakenedEvidence(changes)).toEqual(cases.map(([name]) => ({ path: `tests/${name}.test.ts`, kind: "edited_test" })));
});

const edit = (path: string, added: string[], removed: string[] = []): FileChange =>
  ({ path, status: "modified", added: numbered(...added), removed: numbered(...removed) });

const manifestEdit = (path: string, baseContent: string, content: string | undefined): FileChange =>
  ({ ...edit(path, content === undefined ? [] : [content], [baseContent]), baseContent, content });

it("flags a removed discovered script, and scripts displaced by a new check even when their commands did not change", () => {
  const before = JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } });
  expect(weakenedEvidence([manifestEdit("web/package.json", before, JSON.stringify({ scripts: { lint: "eslint ." } }))]))
    .toEqual([{ path: "web/package.json", kind: "changed_check_script", script: "test" }]);
  expect(weakenedEvidence([manifestEdit("package.json", before,
    JSON.stringify({ scripts: { check: "node --test test/smoke.test.mjs", lint: "eslint .", test: "node --test" } }))]))
    .toEqual([
      { path: "package.json", kind: "changed_check_script", script: "lint" },
      { path: "package.json", kind: "changed_check_script", script: "test" },
    ]);
});

it("does not flag manifest formatting, dependencies, unrelated scripts or a newly added check without previous checks", () => {
  const before = JSON.stringify({ scripts: { check: "node --test", dev: "vite" }, dependencies: { lib: "1" } });
  expect(weakenedEvidence([manifestEdit("package.json", before,
    JSON.stringify({ dependencies: { lib: "2" }, scripts: { dev: "vite --host", check: "node --test" } }, null, 2)),
  manifestEdit("web/package.json", JSON.stringify({ scripts: { dev: "vite" } }),
    JSON.stringify({ scripts: { check: "node --test", dev: "vite" } })),
  { ...manifestEdit("new/package.json", "", JSON.stringify({ scripts: { check: "node --test" } })), status: "added" },
  ])).toEqual([]);
});

it("keeps a warning when a manifest with checks is deleted, invalidated or loses its scripts object", () => {
  const before = JSON.stringify({ scripts: { check: "node --test" } });
  for (const content of [undefined, "{", JSON.stringify({ scripts: null }), JSON.stringify({ scripts: { check: false } })]) {
    expect(weakenedEvidence([{ ...manifestEdit("package.json", before, content),
      status: content === undefined ? "deleted" : "modified" }])).toEqual([
      { path: "package.json", kind: "changed_check_script", script: "check" },
    ]);
  }
});

it("does not flag a test file that only gains tests, blank lines or comments, or loses blank or comment lines", async () => {
  // A file's comment lines are read from its content, here only the lines the change shows.
  const added = ["", "it(\"clamps below\", () => {", "  expect(clamp(-1, 0, 2)).toBe(0);", "});", "// it.only would focus it",
    "const skipped = items.filter(Boolean);"];
  const removed = ["", "// an old note", "  /* wrapped", "   * note */"];
  const python = ["# @pytest.mark.skip later", "def test_total():", "    assert total(1) == 1", "@pytest.fixture", "def order():"];
  expect(weakenedEvidence([
    { ...edit("tests/clamp.test.ts", added, removed), content: added.join("\n"), baseContent: removed.join("\n") },
    await withGrammarComments({ ...edit("app/test_orders.py", python, ["# old note"]), content: python.join("\n"),
      baseContent: "# old note" }),
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

// The shape `lsc gen` 0.6.4 emits for a `//@ extern` function and a `split` call: both are `{:axiom}` functions.
const generatedProgram = ["// Generated by lsc from rule.ts", "", "function {:axiom} StringSplit(s: string, d: string): seq<string>",
  "  requires |d| > 0", "  ensures |StringSplit(s, d)| >= 1", "", "function {:axiom} helper(n: int): int", "  ensures (helper(n) >= 0)", "",
  "lemma f_ensures(n: int)", "  ensures (f(n) >= 0)", "{", "}", ""];

it("counts a proof's lines that LemmaScript generated as its own, and the source's //@ extern as the change's (#399)", () => {
  const lines = [...generatedProgram.slice(0, -1), "lemma Given()", "  ensures false", "", "method g()", "{", "  assume false;", "}", ""];
  const added = lines.map((text, k) => ({ number: k + 1, text }));
  const content = lines.join("\n");
  expect(weakenedEvidence([{ path: "src/rule.dfy", status: "added", removed: [], added, content, generated: generatedProgram.join("\n") }]))
    .toEqual([
      { path: "src/rule.dfy", kind: "added_assume", annotation: "assume false;" },
      { path: "src/rule.dfy", kind: "added_assume", annotation: "lemma Given without a body" },
    ]);
  // Without the program LemmaScript generated, every line of the proof counts as written by hand.
  expect(weakenedEvidence([{ path: "src/rule.dfy", status: "added", removed: [], added, content }])).toHaveLength(4);
  const source = ["//@ extern", "//@ ensures \\result >= 0", "export function helper(n: number): number {", "  return Math.abs(n);", "}",
    "", "//@ extern", ""].join("\n");
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed: [],
    added: [{ number: 1, text: "//@ extern" }, { number: 7, text: "//@ extern" }], content: source, baseContent: source }])).toEqual([
    { path: "src/rule.ts", kind: "added_assume", annotation: "//@ extern", function: "helper" },
    { path: "src/rule.ts", kind: "added_assume", annotation: "//@ extern" },
  ]);
});

it("flags a //@ skip added to what the base had, and not one on something new or one that only moved (#404)", () => {
  const baseContent = ["//@ ensures \\result >= 0", "export function clamp(n: number): number {", "  const m = n;", "  return m;", "}", "",
    "export const limit = (n: number): number => n;", "", "class Box {", "  //@ verify", "  get(): number { return 1; }", "}", "",
    "//@ skip", "export function moved(): number { return 0; }", ""].join("\n");
  const content = ["//@ skip", "//@ ensures \\result >= 0", "export function clamp(n: number): number {", "  //@ skip",
    "  const m = n;", "  return m;", "}", "", "//@ skip", "export const limit = (n: number): number => n;", "", "class Box {",
    "  //@ skip", "  //@ verify", "  get(): number { return 1; }", "}", "", "//@ skip", "export function fresh(): number { return 0; }", "",
    "//@ skip", "export function moved(): number { return 0; }", ""].join("\n");
  const at = (...numbers: number[]) => numbers.map((number) => ({ number, text: content.split("\n")[number - 1] ?? "" }));
  const added = at(1, 4, 9, 13, 18, 19, 21);
  const removed = [{ base: 14, number: 21, text: "//@ skip" }];
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed, added, content, baseContent }])).toEqual([
    { path: "src/rule.ts", kind: "added_skip", annotation: "//@ skip", function: "clamp" },
    { path: "src/rule.ts", kind: "added_skip", annotation: "//@ skip", function: "clamp", statement: true },
    { path: "src/rule.ts", kind: "added_skip", annotation: "//@ skip", function: "limit" },
    { path: "src/rule.ts", kind: "added_skip", annotation: "//@ skip", function: "get" },
  ]);
  // A skip taken off one function and put on another leaves the other out: it did not only move.
  const traded = baseContent.replace("//@ skip\nexport function moved", "export function moved").replace("export function clamp",
    "//@ skip\nexport function clamp");
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed, added: [{ number: 2, text: "//@ skip" }],
    content: traded, baseContent }])).toEqual([{ path: "src/rule.ts", kind: "added_skip", annotation: "//@ skip", function: "clamp" }]);
  // A new file has nothing the base proved; a modified one that was not read counts as having it.
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "added", removed: [], added, content }])).toEqual([]);
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed, added, content, baseContent: undefined }]))
    .toHaveLength(6);
});

it("places a requires or extern on an arrow function, or inside a function body, as LemmaScript reads it", () => {
  const baseContent = "export const half = (n: number): number => n / 2;\n\nexport function body(n: number): number {\n  return n;\n}\n";
  const content = ["//@ extern", "//@ requires n >= 0", "export const half = (n: number): number => n / 2;", "",
    "export function body(n: number): number {", "  //@ requires n > 0", "  return n;", "}", "", "//@ requires m > 0",
    "export const fresh = (m: number): number => m;", ""].join("\n");
  const added = [1, 2, 6, 10].map((number) => ({ number, text: content.split("\n")[number - 1] ?? "" }));
  expect(weakenedEvidence([{ path: "src/rule.ts", status: "modified", removed: [], added, content, baseContent }])).toEqual([
    { path: "src/rule.ts", kind: "added_assume", annotation: "//@ extern", function: "half" },
    { path: "src/rule.ts", kind: "added_requires", annotation: "//@ requires n >= 0" },
    { path: "src/rule.ts", kind: "added_requires", annotation: "//@ requires n > 0" },
  ]);
});

it("lists what a whole proof takes on trust or leaves out, and not the lines LemmaScript generated (#402)", () => {
  const source = ["//@ extern", "//@ ensures \\result >= 0", "export function helper(n: number): number {", "  return Math.abs(n);", "}", "",
    "//@ requires n >= 0", "export function f(n: number): number {", "  //@ assume n < 10", "  return helper(n);", "}", "",
    "//@ skip", "export function g(): number { return 0; }", ""].join("\n");
  const generated = generatedProgram.join("\n");
  expect(provedOnTrust([{ path: "src/rule.ts", content: source },
    { path: "src/rule.dfy", content: `${generated}\nlemma Given()\n  ensures false\n`, generated }])).toEqual([
    { path: "src/rule.ts", kind: "added_assume", annotation: "//@ extern", function: "helper" },
    { path: "src/rule.ts", kind: "added_assume", annotation: "//@ assume n < 10" },
    { path: "src/rule.ts", kind: "added_skip", annotation: "//@ skip", function: "g" },
    { path: "src/rule.dfy", kind: "added_assume", annotation: "lemma Given without a body" },
  ]);
  expect(provedOnTrust([{ path: "src/plain.ts", content: "//@ requires n >= 0\nexport function f(n: number): number { return n; }\n" }]))
    .toEqual([]);
});

it("flags a //@ verify that leaves out a function the base proved, and lists every one it leaves out of a whole proof", () => {
  const good = "//@ ensures \\result >= 0\nexport function good(x: number): number {\n  return x * x;\n}\n";
  const wrong = "//@ ensures \\result > 100\nexport function wrong(x: number): number {\n  return 1;\n}\n";
  const selecting = `//@ verify\n${good}\n${wrong}`;
  const change = (baseContent: string | undefined, status: "added" | "modified" = "modified"): FileChange =>
    ({ path: "src/rule.ts", status, added: [{ number: 1, text: "//@ verify" }], removed: [], content: selecting, baseContent });
  const leftOut = { path: "src/rule.ts", kind: "added_skip", annotation: "//@ verify", function: "wrong" };
  expect(weakenedEvidence([change(`${good}\n${wrong}`)])).toEqual([leftOut]);
  expect(weakenedEvidence([change(undefined)])).toEqual([leftOut]);
  // Already left out at the base, or a file the base lacked: nothing the base proved is lost.
  expect(weakenedEvidence([change(`//@ verify\n${good}\n${wrong.replace("> 100", "> 99")}`)])).toEqual([]);
  expect(weakenedEvidence([change(undefined, "added")])).toEqual([]);
  expect(provedOnTrust([{ path: "src/rule.ts", content: selecting }])).toEqual([leftOut]);
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

/** A change that removes line `base` of `baseContent` from `path`, with its content on both sides. */
const removedFrom = (path: string, baseContent: string, base: number): FileChange => {
  const lines = baseContent.split("\n");
  return { path, status: "modified", added: [], removed: [{ number: base, base, text: lines[base - 1] ?? "" }],
    content: [...lines.slice(0, base - 1), ...lines.slice(base)].join("\n"), baseContent };
};

it("reads a test file's comment lines from its parsed content, inside a block comment or a template alike", () => {
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

it("reads Python and Go test files' comment lines with their grammars, never a line inside a string", async () => {
  const removing = (path: string, baseContent: string, base: number): Promise<FileChange> =>
    withGrammarComments(removedFrom(path, baseContent, base));
  // A `#` line inside a triple-quoted string is part of what the test compares; a `*p = 2` line is a Go statement.
  const python = "def test_title():\n    # the heading must stay\n    assert render() == \"\"\"\n# Heading\n\"\"\"\n";
  const go = "package price\n\n// Total adds.\n/* plain\n   notes\n*/\nfunc TestSet(t *testing.T) {\n\tp := new(int)\n\t*p = 2\n}\n";
  expect(weakenedEvidence(await Promise.all([removing("tests/test_title.py", python, 2), removing("price_test.go", go, 3),
    removing("price_test.go", go, 5)]))).toEqual([]);
  expect(weakenedEvidence(await Promise.all([removing("tests/test_title.py", python, 4), removing("price_test.go", go, 9)])))
    .toEqual([{ path: "tests/test_title.py", kind: "edited_test" }, { path: "price_test.go", kind: "edited_test" }]);
});

it("takes no line for a comment in a file that does not parse, or in a language no grammar reads", async () => {
  // An unterminated string: tree-sitter would recover and guess, so nothing counts as a comment.
  expect(weakenedEvidence([await withGrammarComments(removedFrom("tests/test_open.py", "x = \"\"\"\n# open\n", 2)),
    await withGrammarComments(removedFrom("tests/price.rs", "// a note\n#[test]\nfn total() {}\n", 1))]))
    .toEqual([{ path: "tests/test_open.py", kind: "edited_test" }, { path: "tests/price.rs", kind: "edited_test" }]);
});

it("does not take a docstring for a comment", async () => {
  const content = "def total():\n    \"\"\"The total, in cents.\"\"\"\n    return 1\n";
  const change = await withGrammarComments({ path: "src/price.py", status: "modified", removed: [],
    added: [{ number: 2, text: "    \"\"\"The total, in cents.\"\"\"" }], content, baseContent: "def total():\n    return 1\n" });
  expect(change.added.map((line) => commentLines(change).added(line))).toEqual([false]);
});
