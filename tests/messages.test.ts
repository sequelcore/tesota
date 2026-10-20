import type { MessageRenderer, Theme } from "../src/contract.js";
import { shellTheme } from "../src/theme.js";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import type { SentBack } from "../src/gate.js";
import { hang, registerMessages } from "../src/messages.js";
import type { Receipt } from "../src/receipt.js";
import type { Weakening } from "../src/verification-changes.js";
import { emptyReceipt } from "./receipts.js";

let theme: Theme;
beforeAll(async () => {
  theme = shellTheme("dark", "truecolor");
  // Pi's binding for expanding tool output, as Pi defines it when it starts.
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } } as never));
});

function renderers(): Map<string, MessageRenderer> {
  const found = new Map<string, MessageRenderer>();
  registerMessages({ registerMessageRenderer: (type: string, renderer: MessageRenderer) => { found.set(type, renderer); } } as never);
  return found;
}

/** The message's rows at `width`, without escape sequences; each fits the width. */
function shown(type: string, details: unknown, width: number, expanded = false, content = "what the agent read"): string[] {
  const message = { role: "custom" as const, customType: type, content, display: true, details, timestamp: 0 };
  const component = renderers().get(type)?.(message, { expanded, outputPad: 1 }, theme);
  if (component === undefined) throw new Error(`no component for ${type}`);
  const rows = component.render(width);
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  return rows.map((row) => stripTerminalSequences(row).trimEnd());
}

const hash = "891029b9d1cdb8e3fab4ee4ef66d1cd9478120fbf486d65fcd2f813608fe87d0";
function evidence(outcome: Evidence["outcome"], output = ""): Evidence {
  return { verifier: "lemmascript", claim: "", limits: "", outcome, output, durationMs: 2118, files: ["src/range.ts", "src/range.dfy"],
    contentHash: hash };
}
const dafnyFailure = "Generated: C:\\work\\src\\range.dfy.gen\r\nRunning dafny verify...\r\n" +
  "range.dfy(16,0): Error: a postcondition could not be proved on this return path\r\n   |\r\n16 | {\r\n   | ^\r\n\r\n" +
  "range.dfy(15,30): Related location: this is the postcondition that could not be proved\r\n   |\r\n" +
  "15 |   ensures (inRange(x, lo, hi) <= hi)\r\n   |                               ^^\r\n\r\n" +
  "Dafny program verifier finished with 1 verified, 1 error";
const proved = { path: "src/range.ts", verdict: "proved", evidence: evidence("passed", "Dafny program verifier finished with 2 verified, 0 errors") } as const;
const passing = { command: "bun test", verdict: "proved", evidence: { ...evidence("passed"), verifier: "command" } } as const;
const contract = { path: "src/range.ts", name: "inRange", lines: [], mutation: { rejected: 6, survived: [], equivalent: 1, inconclusive: 0 } };
const survivor = { line: 4, operator: "comparison", before: "x > hi", after: "x >= hi" } as const;
const judged = { status: "judged", restatedBy: "openai/gpt-5.5", comparedBy: "openai/gpt-5.5" } as const;

const clean: Receipt = { ...emptyReceipt, proofs: [proved], tests: [passing],
  contracts: [{ ...contract, judgment: { verdict: "justified", explanation: "Matches." } }], claimcheck: judged,
  exercises: [{ path: "tests/range.test.ts", finding: "exercises", reason: "fails on the base, passes with the change" }] };
const attention: Receipt = { ...clean,
  contracts: [{ ...contract, mutation: { rejected: 5, survived: [survivor], equivalent: 1, inconclusive: 0 },
    judgment: { verdict: "partially_justified", explanation: "It does not say a value inside the range is returned unchanged." } }],
  exercises: [{ path: "tests/range.test.ts", finding: "does_not_exercise", reason: "it passes without the change" }],
  weakened: [{ path: "tests/clamp.test.ts", kind: "edited_test" },
    { path: "src/clamp.ts", kind: "removed_contract", annotation: "//@ ensures \\result >= lo && \\result <= hi" }],
  unverified: ["src/format.ts"], uncovered: [{ path: "src/range.ts", lines: [[9, 14]] }] };

it("keeps clarification context outside evidence and expands its exact submitted text", () => {
  const receipt: Receipt = { ...clean, clarifications: [{ reply: 0, callId: "clarify", at: "2026-10-20T00:00:00.000Z",
    questions: [{ question: "Which version?", options: [
      { label: "Three", description: "Use version three." }, { label: "Two", description: "Use version two." },
    ] }], answers: [{ selected: [0], text: "Explain first." }] }] };
  const collapsed = shown("tesota-receipt", receipt, 80).join("\n");
  expect(collapsed).toContain("1 request clarification");
  expect(collapsed).not.toContain("Explain first.");
  const expanded = shown("tesota-receipt", receipt, 40, true).join("\n");
  expect(expanded).toContain("Explain first.");
  expect(expanded).toContain("not evidence or acceptance");
});

it("wraps a line under its own text, cutting a word longer than the row", () => {
  expect(hang("  label         one two three four", 22, 16)).toEqual(["  label         one", "                two", "                three",
    "                four"]);
  expect(hang("  - a long line that wraps", 12, 4)).toEqual(["  - a long", "    line", "    that", "    wraps"]);
  expect(hang(`x ${hash}`, 20, 2)).toEqual(["x", `  ${hash.slice(0, 18)}`, `  ${hash.slice(18, 36)}`, `  ${hash.slice(36, 54)}`,
    `  ${hash.slice(54)}`]);
  expect(hang("short", 20, 2)).toEqual(["short"]);
});

it("shows a clean receipt as its verdict and one row of what holds", () => {
  const rows = shown("tesota-receipt", clean, 120);
  // The card's padding row, then the two rows, then the padding row.
  expect(rows).toHaveLength(4);
  expect(rows[1]).toMatch(/^ ✓ Nothing needs you +Tesota receipt$/u);
  expect(rows[2]).toMatch(/^ ✓ {2}Proved · Tests pass · Contract strong · Test catches the change · ◇ model: matches the request +ctrl\+o for details$/u);
  expect(rows.join("\n")).not.toContain(hash.slice(0, 12));
});

it("shows inherited files in one collapsed row and their paths only expanded", () => {
  const receipt: Receipt = { ...clean, inherited: ["old/a.ts", "old/b.ts"] };
  const collapsed = shown("tesota-receipt", receipt, 120).join("\n");
  expect(collapsed).toContain("○ 2 files already uncommitted, not this request's");
  expect(collapsed).not.toContain("old/a.ts");
  const expanded = shown("tesota-receipt", receipt, 120, true).join("\n");
  expect(expanded).toContain("old/a.ts");
  expect(expanded).toContain("old/b.ts");
  expect(expanded).toContain("tests ran with them");
});

it("explains unknown start states and unmeasured paths in both card views", () => {
  const receipt: Receipt = { ...emptyReceipt, startState: { status: "unknown", reason: "the index has unresolved conflicts" },
    unmeasured: [{ path: "large.bin", reason: "file exceeds 10 MiB" }] };
  for (const expanded of [false, true]) {
    const rows = shown("tesota-receipt", receipt, 120, expanded).join("\n");
    expect(rows).toContain("the index has unresolved conflicts");
    expect(rows).toContain("large.bin");
    expect(rows).toContain("file exceeds 10 MiB");
  }
});

it("counts a receipt's gaps in its verdict, amber, and keeps green for one with none", () => {
  const gapped: Receipt = { ...clean, unverified: ["notes.md"] };
  const rows = shown("tesota-receipt", gapped, 120);
  expect(rows[1]).toMatch(/^ ○ Nothing needs you · 1 unverified +Tesota receipt$/u);
  expect(rows).toContain(" UNVERIFIED (1)");
  const colored = (receipt: Receipt): string => renderers().get("tesota-receipt")?.({ customType: "tesota-receipt",
    content: "", details: receipt }, { expanded: false, outputPad: 1 }, theme)?.render(120)[1] ?? "";
  expect(colored(gapped)).toContain(theme.fg("warning", "\x1b[1m○ Nothing needs you · 1 unverified\x1b[22m"));
  expect(colored(clean)).toContain(theme.fg("success", "\x1b[1m✓ Nothing needs you\x1b[22m"));
});

it("shows a stopped receipt as not verified in both card views", () => {
  const receipt: Receipt = { ...emptyReceipt, stopped: "quota exhausted" };
  for (const expanded of [false, true]) {
    const rows = shown("tesota-receipt", receipt, 120, expanded);
    expect(rows[1]).toMatch(/^ ! 1 thing needs you +Tesota receipt$/u);
    expect(rows.join("\n")).toContain("Not verified");
    expect(rows.join("\n")).toContain("this request's changes — quota exhausted");
    expect(rows).not.toContain(" VERIFIED");
  }
});

it("shows the cases a model listed as left open as notes for the operator, outside the count", () => {
  const listed: Receipt = { ...clean, openCases: { status: "listed", model: "openai/gpt-6-sol",
    cases: [{ input: "lateFee(-1)", outcomes: ["0.", "-5."] }, { input: "lateFee(1.5)", outcomes: ["7.5", "5"] }] } };
  const rows = shown("tesota-receipt", listed, 120);
  expect(rows[1]).toMatch(/^ ✓ Nothing needs you · ◇ 2 model notes +Tesota receipt$/u);
  expect(rows.filter((row) => /^ [A-Z' ,]+$/u.test(row)).map((row) => row.trim())).toEqual(["MODEL'S OPINION, NOT A PROOF"]);
  expect(rows.join("\n")).toContain("◇  Model: open case");
  expect(rows.join("\n")).toContain("lateFee(-1) — 0 or -5");
  // Why no model listed them shows only expanded, so a session without the model keeps its two-row card.
  const unlisted: Receipt = { ...clean, openCases: { status: "not_listed", reason: "openai/gpt-6-sol was stopped" } };
  expect(shown("tesota-receipt", unlisted, 120)).toEqual(shown("tesota-receipt", clean, 120));
  expect(shown("tesota-receipt", unlisted, 120, true).join("\n")).toContain("◇  Not listed");
});

it("leads with what needs the operator and keeps the model's opinion out of the count", () => {
  const rows = shown("tesota-receipt", attention, 120);
  // Four findings the checks established; the model's partial match is a note beside them.
  expect(rows[1]).toMatch(/^ ! 4 things need you · ◇ 1 model note +Tesota receipt$/u);
  const headings = rows.filter((row) => /^ [A-Z' ,]+(?: \(\d+\))?$/u.test(row)).map((row) => row.trim());
  expect(headings).toEqual(["NEEDS YOU", "MODEL'S OPINION, NOT A PROOF", "UNVERIFIED (2)"]);
  const start = rows.indexOf(" NEEDS YOU") + 1;
  const needs = rows.slice(start, start + 4);
  expect(needs.map((row) => row.slice(1, 28).trim())).toEqual(["!  May weaken the evidence", "!  May weaken the evidence",
    "!  Contract too weak", "!  Test misses the change"]);
  expect(needs[2]).toContain("inRange · src/range.ts — 1 change to its code still proves");
  expect(rows.join("\n")).toContain("◇  Model: partial match");
  expect(rows.join("\n")).toContain("○  Not proved");
  expect(rows.at(-4)).toMatch(/^ ✓ {2}Proved · Tests pass$/u);
  expect(rows.at(-2)).toBe(" ctrl+o for details");
  // Collapsed, no hash and no detail lines.
  expect(rows.join("\n")).not.toContain("x > hi → x >= hi");
});

// #399: three functions marked `//@ extern` are trusted without proof, so the file proved only given them.
const extern = (name: string): Weakening => ({ path: "src/range.ts", kind: "added_assume", annotation: "//@ extern", function: name });
const unmeasured = (name: string): Receipt["contracts"][number] =>
  ({ ...contract, name, mutation: { rejected: 0, survived: [], equivalent: 0, inconclusive: 0 } });
const assumed: Receipt = { ...clean, contracts: [contract, unmeasured("lower"), unmeasured("upper"), unmeasured("clampOf")],
  weakened: [extern("lower"), extern("upper"), extern("clampOf")],
  exercises: [...clean.exercises, { path: "tests/clamp.test.ts", finding: "exercises", reason: "fails on the base, passes with the change" }] };

it("never sums up a proof that rests on assumptions the change added, or one strong contract of several, as plainly proved or strong", () => {
  const rows = shown("tesota-receipt", assumed, 140);
  expect(rows[1]).toMatch(/^ ! 3 things need you +Tesota receipt$/u);
  // Each in plain words, naming what it trusts; the line as written is in the details.
  expect(rows.filter((row) => /May weaken the evidence +src\/range\.ts — trusts (lower|upper|clampOf) without proving it$/u.test(row)))
    .toHaveLength(3);
  expect(rows.filter((row) => row.includes("Contract not measured"))).toHaveLength(3);
  expect(rows.at(-4)).toMatch(/^ ✓ {2}Proved, trusting 3 unproved parts · Tests pass · Contract strong \(1 of 4\) · Test catches the change \(2\)$/u);
  const expanded = shown("tesota-receipt", assumed, 140, true).join("\n");
  expect(expanded).toMatch(/Proved, trusting 3 unproved parts +src\/range\.ts — its contracts hold only if what the change trusts is right/u);
  expect(expanded).toContain("//@ extern");
});

it("names what an added //@ skip leaves out of the proof (#404)", () => {
  const skip = (more: { function: string; statement?: true }): Weakening =>
    ({ path: "src/range.ts", kind: "added_skip", annotation: "//@ skip", ...more });
  const rows = shown("tesota-receipt", { ...clean, weakened: [skip({ function: "clampOf" }), skip({ function: "lower", statement: true })] }, 140);
  expect(rows.some((row) => /May weaken the evidence +src\/range\.ts — leaves clampOf out of the proof$/u.test(row))).toBe(true);
  expect(rows.some((row) => /May weaken the evidence +src\/range\.ts — leaves a statement of lower out of the proof$/u.test(row))).toBe(true);
});

it("says how many of a check's findings hold when some do not, and only then", () => {
  const twoProofs: Receipt = { ...clean, contracts: [], exercises: [],
    proofs: [proved, { path: "src/clamp.ts", verdict: "no_progress", evidence: evidence("failed", dafnyFailure) }] };
  expect(shown("tesota-receipt", twoProofs, 120).at(-4)).toMatch(/^ ✓ {2}Proved \(1 of 2\) · Tests pass$/u);
  const bothProved: Receipt = { ...twoProofs, proofs: [proved, { ...proved, path: "src/clamp.ts" }] };
  expect(shown("tesota-receipt", bothProved, 120)[2]).toMatch(/^ ✓ {2}Proved \(2\) · Tests pass +ctrl\+o for details$/u);
});

it("counts a failure the agent repeated, and colors the verdict as one", () => {
  const failed: Receipt = { ...emptyReceipt, proofs: [{ path: "src/range.ts", verdict: "no_progress", evidence: evidence("failed", dafnyFailure) }] };
  const rows = shown("tesota-receipt", failed, 120);
  expect(rows[1]).toMatch(/^ ! 1 thing needs you/u);
  expect(rows.join("\n")).toContain("✗  Proof fails  src/range.ts — a postcondition could not be proved on this return path");
});

it("calls a contract unmeasured when no change was caught, rather than strong", () => {
  const unmeasured: Receipt = { ...clean, contracts: [{ ...contract, mutation: { rejected: 0, survived: [], equivalent: 2, inconclusive: 0 } }] };
  const rows = shown("tesota-receipt", unmeasured, 120).join("\n");
  expect(rows).toMatch(/○ {2}Contract not measured +inRange · src\/range\.ts — no change tried both differs from the code and was decided/u);
  expect(rows).not.toContain("Contract strong");
});

it("shows every finding's details when expanded, with the hash shortened", () => {
  const rows = shown("tesota-receipt", attention, 120, true).join("\n");
  expect(rows).toContain("line 4: x > hi → x >= hi");
  expect(rows).toContain("Of 7 changes tried: 5 caught · 1 behave the same as the code.");
  expect(rows).toContain("//@ ensures \\result >= lo && \\result <= hi");
  expect(rows).toContain("A model's opinion, not a proof: openai/gpt-5.5 restated and compared.");
  expect(rows).toContain("VERIFIED");
  expect(rows).toContain(`sha256 ${hash.slice(0, 12)} · 2.1s`);
  expect(rows).not.toContain(hash);
  expect(rows).toContain("check evidence, not a reviewer's acceptance");
});

it("fits narrow terminals, wrapping rows collapsed and expanded so no reason is cut", () => {
  for (const width of [80, 40]) {
    const collapsed = shown("tesota-receipt", attention, width);
    expect(collapsed[1]).toContain("! 4 things need you");
    expect(collapsed.some((row) => row.endsWith("…"))).toBe(false);
    expect(collapsed.join(" ").replace(/\s+/gu, " ")).toContain("1 change to its code still proves");
    const expanded = shown("tesota-receipt", attention, width, true);
    expect(expanded.join(" ")).toContain("still proves");
    expect(expanded.join(" ")).toContain("acceptance");
  }
});

it("shows what went back to the agent, and what it read when expanded", () => {
  const sent: SentBack = { round: "tests", commands: [{ command: "bun test", evidence: { ...evidence("failed"), verifier: "command" },
    failingTests: ["inRange lowers a value above the range"] }] };
  const content = "Tesota: `bun test` fails with your changes.\n\nThese tests fail:\n  inRange lowers a value above the range";
  const rows = shown("tesota-gate", sent, 120, false, content);
  expect(rows[1]).toMatch(/^ ↺ Sent back to the agent: the tests fail +Tesota$/u);
  expect(rows[3]).toBe(" ✗  Tests fail  bun test — 1 test fails: inRange lowers a value above the range");
  expect(rows[5]).toBe(" ctrl+o to see what the agent read");
  expect(rows.join("\n")).not.toContain("Tesota: `bun test` fails");
  const expanded = shown("tesota-gate", sent, 120, true, content);
  expect(expanded).toContain(" WHAT THE AGENT READ");
  expect(expanded).toContain(" Tesota: `bun test` fails with your changes.");
  expect(expanded).toContain("   inRange lowers a value above the range");
  const weak: SentBack = { round: "contracts", contracts: [{ ...contract, mutation: { ...contract.mutation, survived: [survivor] } }] };
  expect(shown("tesota-gate", weak, 120)[1]).toMatch(/^ ↺ Sent back to the agent: a contract is too weak/u);
  expect(shown("tesota-gate", weak, 120)[3]).toBe(" !  Contract too weak  inRange · src/range.ts — line 4: x > hi → x >= hi still proves");
  const proof: SentBack = { round: "proofs", proofs: [{ path: "src/range.ts", evidence: evidence("failed", dafnyFailure) }] };
  expect(shown("tesota-gate", proof, 120)[3]).toBe(" ✗  Proof fails  src/range.ts — a postcondition could not be proved on this return path");
});

it("leaves a message without details to Pi", () => {
  const message = { role: "custom" as const, customType: "tesota-gate", content: "text", display: true, timestamp: 0 };
  expect(renderers().get("tesota-gate")?.(message, { expanded: false, outputPad: 1 }, theme)).toBeUndefined();
  expect(renderers().get("tesota-receipt")?.({ ...message, customType: "tesota-receipt" }, { expanded: false, outputPad: 1 }, theme))
    .toBeUndefined();
});

it("names each repository's findings by its folder, the folders in none, and each repository's base when expanded", () => {
  const base = "a".repeat(40);
  const units: Receipt = { ...emptyReceipt, units: [{ ...attention, folder: "api", base },
    { ...emptyReceipt, folder: "notes", repository: false }] };
  const rows = shown("tesota-receipt", units, 120, true).join("\n");
  expect(rows).toContain("api/src/format.ts");
  expect(rows).toContain("cd api && bun test");
  expect(rows).toContain("Checked api/src/range.ts, api/src/range.dfy");
  expect(rows).toContain("notes — it is in no Git repository, so Tesota cannot tell what changed");
  expect(rows).toContain(`From api ${base.slice(0, 12)} · Tesota 0.1.0`);
});

it("names a snapshot as the base of a folder in no repository, and a file it left out for its size", () => {
  const base = "b".repeat(40);
  const snapshotted: Receipt = { ...clean, repository: false, snapshot: true, base, tooLarge: ["data/huge.csv"] };
  const rows = shown("tesota-receipt", snapshotted, 120, true).join("\n");
  expect(rows).toContain(`From Tesota's snapshot ${base.slice(0, 12)} · Tesota 0.1.0`);
  expect(rows).toContain("data/huge.csv — too large for Tesota's snapshot, which left it out");
});
