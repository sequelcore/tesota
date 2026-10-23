import type { MessageRenderer, Theme } from "../src/contract.js";
import { shellTheme } from "../src/theme.js";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import type { SentBack } from "../src/gate.js";
import { hang, registerMessages } from "../src/messages.js";
import { GateOperations } from "../src/operations.js";
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
  exercises: [{ path: "tests/range.test.ts", provenance: "added", sensitivity: "fails_then_passes", reason: "fails on the base, passes with the change" }] };
const attention: Receipt = { ...clean,
  contracts: [{ ...contract, mutation: { rejected: 5, survived: [survivor], equivalent: 1, inconclusive: 0 },
    judgment: { verdict: "partially_justified", explanation: "It does not say a value inside the range is returned unchanged." } }],
  exercises: [{ path: "tests/range.test.ts", provenance: "added", sensitivity: "passes_on_base", reason: "it passes without the change too" }],
  weakened: [{ path: "tests/clamp.test.ts", kind: "edited_test" },
    { path: "src/clamp.ts", kind: "removed_contract", annotation: "//@ ensures \\result >= lo && \\result <= hi" }],
  unverified: ["src/format.ts"], uncovered: [{ path: "src/range.ts", lines: [[9, 14]] }] };


/** The card's rows as text, without the box's blank padding rows or the margin. */
const text = (rows: readonly string[]): string[] => rows.map((row) => row.slice(1)).filter((row, k, all) =>
  !(row === "" && (k === 0 || k === all.length - 1)));

it("keeps clarification context outside evidence and expands its exact submitted text", () => {
  const receipt: Receipt = { ...clean, clarifications: [{ reply: 0, callId: "clarify", at: "2026-10-20T00:00:00.000Z",
    questions: [{ question: "Which version?", options: [
      { label: "Three", description: "Use version three." }, { label: "Two", description: "Use version two." },
    ] }], answers: [{ selected: [0], text: "Explain first." }] }] };
  const collapsed = shown("tesota-receipt", receipt, 80).join("\n");
  expect(collapsed).toContain("▸ Context · 1 answer");
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

it("shows a clean receipt as its counts, the acceptance line and one row per method, each saying only what ran", () => {
  expect(text(shown("tesota-receipt", clean, 120))).toEqual([
    "Tesota receipt",
    "No review flags · no verification limits",
    "Check evidence, not your acceptance.",
    "",
    "✓ Tested      bun test · 0:02",
    "✓ Proved      src/range.ts · 0:02",
    "○ Models      none recorded",
    "✓ Exercised   1 test file failed on the base and passed with the change",
    "✓ Contracts   1 contract: every decided change broke its proof",
    "",
    "▸ Details · paths, output, assumptions, model opinions",
  ]);
  expect(shown("tesota-receipt", clean, 120).join("\n")).not.toContain(hash.slice(0, 12));
});

it("shows inherited files as context in one row, and their paths only expanded", () => {
  const receipt: Receipt = { ...clean, inherited: ["old/a.ts", "old/b.ts"] };
  const collapsed = shown("tesota-receipt", receipt, 120).join("\n");
  expect(collapsed).toContain("▸ Context · 2 files already uncommitted, not this request's");
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

it("counts a receipt's limits, amber, and keeps green for one with none", () => {
  const gapped: Receipt = { ...clean, unverified: ["notes.md"] };
  const rows = text(shown("tesota-receipt", gapped, 120));
  expect(rows[1]).toBe("No review flags · 1 verification limit");
  expect(rows).toContain("○ No proof covers 1 changed file");
  const colored = (receipt: Receipt): string => renderers().get("tesota-receipt")?.({ customType: "tesota-receipt",
    content: "", details: receipt }, { expanded: false, outputPad: 1 }, theme)?.render(120)[2] ?? "";
  expect(colored(gapped)).toContain(theme.fg("warning", "\x1b[1mNo review flags · 1 verification limit\x1b[22m"));
  expect(colored(clean)).toContain(theme.fg("success", "\x1b[1mNo review flags · no verification limits\x1b[22m"));
});

it("shows a stopped receipt as not verified in both card views, with no method claimed", () => {
  const receipt: Receipt = { ...emptyReceipt, stopped: "quota exhausted" };
  for (const expanded of [false, true]) {
    const rows = text(shown("tesota-receipt", receipt, 120, expanded));
    expect(rows[1]).toBe("1 review flag · no verification limits");
    expect(rows).toContain("! Not verified · this request's changes");
    expect(rows).toContain("  quota exhausted");
    expect(rows.filter((row) => row.startsWith("✓"))).toEqual([]);
  }
});

it("shows the cases a model listed as left open in the opinions, outside the count", () => {
  const listed: Receipt = { ...clean, openCases: { status: "listed", model: "openai/gpt-6-sol",
    cases: [{ input: "lateFee(-1)", outcomes: ["0.", "-5."] }, { input: "lateFee(1.5)", outcomes: ["7.5", "5"] }] } };
  const rows = text(shown("tesota-receipt", listed, 120));
  expect(rows[1]).toBe("No review flags · no verification limits");
  const opinions = rows.indexOf("Model opinions · not evidence, not counted");
  expect(rows[opinions + 1]).toBe("◇ 2 open cases for you to settle, listed by openai/gpt-6-sol");
  expect(rows.join("\n")).not.toContain("lateFee(-1)");
  expect(shown("tesota-receipt", listed, 120, true).join("\n")).toContain("lateFee(-1): 0 or -5");
  // A listing that did not happen is a limit of the opinion, in the same group.
  const unlisted: Receipt = { ...clean, openCases: { status: "not_listed", reason: "openai/gpt-6-sol was stopped" } };
  const without = text(shown("tesota-receipt", unlisted, 120));
  expect(without[1]).toBe("No review flags · no verification limits");
  expect(without.slice(without.indexOf("Model opinions · not evidence, not counted") + 1, -2))
    .toEqual(["◇ Open cases not listed", "  openai/gpt-6-sol was stopped"]);
});

it("leads with what needs the operator, grouped by reason, and keeps the model's opinion out of the count", () => {
  const rows = text(shown("tesota-receipt", attention, 120));
  expect(rows.slice(1, 2)).toEqual(["4 review flags · 2 verification limits"]);
  expect(rows.slice(rows.indexOf("○ Models   none recorded") + 2)).toEqual([
    "! Review test edits · 1 heuristic flag",
    "  May weaken evidence; not confirmed weakening.",
    "! Review removed or changed contracts · 1 heuristic flag",
    "  May weaken evidence; not confirmed weakening.",
    "! Contract too weak · inRange · src/range.ts",
    "  1 change to its code still proves",
    "! Test passes without the change · 1 test file",
    "  it passes without the change too",
    "○ No proof covers changed lines in 1 file",
    "○ No proof covers 1 changed file",
    "",
    "Model opinions · not evidence, not counted",
    "◇ ClaimCheck: covers only part of the request · inRange · src/range.ts",
    "",
    "▸ Details · paths, output, assumptions, model opinions",
  ]);
  // Collapsed, no detail lines.
  expect(rows.join("\n")).not.toContain("x > hi");
});

// #399: three functions marked `//@ extern` are trusted without proof, so the file proved only given them.
const extern = (name: string): Weakening => ({ path: "src/range.ts", kind: "added_assume", annotation: "//@ extern", function: name });
const unmeasured = (name: string): Receipt["contracts"][number] =>
  ({ ...contract, name, mutation: { rejected: 0, survived: [], equivalent: 0, inconclusive: 0 } });
const assumed: Receipt = { ...clean, contracts: [contract, unmeasured("lower"), unmeasured("upper"), unmeasured("clampOf")],
  weakened: [extern("lower"), extern("upper"), extern("clampOf")],
  exercises: [...clean.exercises, { path: "tests/clamp.test.ts", provenance: "added", sensitivity: "fails_then_passes", reason: "fails on the base, passes with the change" }] };

it("never sums up a proof that rests on assumptions the change added, or one strong contract of several, as plainly proved or strong", () => {
  const rows = text(shown("tesota-receipt", assumed, 140));
  expect(rows[1]).toBe("3 review flags · 3 verification limits");
  expect(rows).toContain("◐ Proved      src/range.ts · trusting 3 unproved parts · 0:02");
  expect(rows).toContain("◐ Contracts   1 of 4 contracts: every decided change broke its proof");
  expect(rows).toContain("! Review added assumptions · 3 heuristic flags");
  expect(rows).toContain("○ Contract not measured · 3");
  const expanded = shown("tesota-receipt", assumed, 140, true).join("\n");
  for (const name of ["lower", "upper", "clampOf"]) expect(expanded).toContain(`may weaken    src/range.ts: trusts ${name} without proving it (//@ extern)`);
  expect(expanded).toContain("proved        src/range.ts, trusting 3 unproved parts the change added");
});

it("names what an added //@ skip leaves out of the proof (#404)", () => {
  const skip = (more: { function: string; statement?: true }): Weakening =>
    ({ path: "src/range.ts", kind: "added_skip", annotation: "//@ skip", ...more });
  const receipt = { ...clean, weakened: [skip({ function: "clampOf" }), skip({ function: "lower", statement: true })] };
  expect(text(shown("tesota-receipt", receipt, 140))).toContain("! Review parts left out of proofs · 2 heuristic flags");
  const expanded = shown("tesota-receipt", receipt, 140, true).join("\n");
  expect(expanded).toContain("src/range.ts: leaves clampOf out of the proof (//@ skip)");
  expect(expanded).toContain("src/range.ts: leaves a statement of lower out of the proof (//@ skip)");
});

it("says how many of a method's results hold when some do not", () => {
  const twoProofs: Receipt = { ...clean, contracts: [], exercises: [],
    proofs: [proved, { path: "src/clamp.ts", verdict: "no_progress", evidence: evidence("failed", dafnyFailure) }] };
  const rows = text(shown("tesota-receipt", twoProofs, 120));
  expect(rows).toContain("◐ Proved   src/range.ts · 0:02; src/clamp.ts · fails · 0:02");
  expect(rows[1]).toBe("1 failed check · no review flags · no verification limits");
  const bothProved: Receipt = { ...twoProofs, proofs: [proved, { ...proved, path: "src/clamp.ts" }] };
  expect(text(shown("tesota-receipt", bothProved, 120))).toContain("✓ Proved   src/range.ts · 0:02; src/clamp.ts · 0:02");
});

it("counts a failure the agent repeated, and colors it as one", () => {
  const failed: Receipt = { ...emptyReceipt, proofs: [{ path: "src/range.ts", verdict: "no_progress", evidence: evidence("failed", dafnyFailure) }] };
  const rows = text(shown("tesota-receipt", failed, 120));
  expect(rows[1]).toBe("1 failed check · no review flags · no verification limits");
  expect(rows).toContain("✗ Proved   src/range.ts · fails · 0:02");
  const colored = renderers().get("tesota-receipt")?.({ customType: "tesota-receipt", content: "", details: failed },
    { expanded: false, outputPad: 1 }, theme)?.render(120).join("\n") ?? "";
  expect(colored).toContain(theme.fg("error", "✗"));
  expect(shown("tesota-receipt", failed, 120, true).join("\n")).toContain("a postcondition could not be proved on this return path");
});

it("calls a contract unmeasured when no change was caught, rather than strong", () => {
  const receipt: Receipt = { ...clean, contracts: [{ ...contract, mutation: { rejected: 0, survived: [], equivalent: 2, inconclusive: 0 } }] };
  const rows = text(shown("tesota-receipt", receipt, 120));
  expect(rows).toContain("○ Contract not measured · inRange · src/range.ts");
  expect(rows).toContain("  no change tried both differs from the code and was decided");
  expect(rows.join("\n")).not.toContain("Contracts ");
});

it("shows every fact when expanded, each claim with what it does not show", () => {
  const rows = shown("tesota-receipt", attention, 120, true).join("\n");
  expect(rows).toContain("line 4: x > hi became x >= hi");
  expect(rows).toContain("//@ ensures \\result >= lo && \\result <= hi");
  expect(rows).toContain("model judged  by ClaimCheck on openai/gpt-5.5, one model for both requests,");
  expect(rows).toContain(`content sha256 ${hash}`);
  expect(rows).toContain("▾ Details");
  expect(rows).toContain("From the first commit · Tesota 0.1.0");
  expect(rows).toContain("Check evidence, not your acceptance.");
});

it("fits narrow terminals, wrapping rows collapsed and expanded so no reason is cut", () => {
  for (const width of [80, 40]) {
    const collapsed = shown("tesota-receipt", attention, width);
    expect(collapsed.join(" ")).toContain("4 review flags");
    expect(collapsed.some((row) => row.endsWith("…"))).toBe(false);
    expect(collapsed.join(" ").replace(/\s+/gu, " ")).toContain("1 change to its code still proves");
    const expanded = shown("tesota-receipt", attention, width, true);
    expect(expanded.join(" ")).toContain("still prove");
    expect(expanded.join(" ").replace(/\s+/gu, " ")).toContain("Check evidence, not your acceptance.");
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
  const collapsed = text(shown("tesota-receipt", units, 120));
  expect(collapsed).toContain("✓ Tested   cd api && bun test · 0:02");
  expect(collapsed).toContain("! Not verified · notes");
  const rows = shown("tesota-receipt", units, 120, true).join("\n");
  expect(rows).toContain("api/src/format.ts");
  expect(rows).toContain("not verified  notes: it is in no Git repository, so Tesota cannot tell what changed");
  expect(rows).toContain(`From api ${base.slice(0, 12)} · Tesota 0.1.0`);
});

it("names a snapshot as the base of a folder in no repository, and a file it left out for its size", () => {
  const base = "b".repeat(40);
  const snapshotted: Receipt = { ...clean, repository: false, snapshot: true, base, tooLarge: ["data/huge.csv"] };
  const rows = shown("tesota-receipt", snapshotted, 120, true).join("\n");
  expect(rows).toContain(`From Tesota's snapshot ${base.slice(0, 12)} · Tesota 0.1.0`);
  expect(rows).toContain("data/huge.csv: too large for Tesota's snapshot, which left it out");
});

it("draws the gate's live ledger as the receipt's block: what runs, what ended, and every check once expanded (#591)", () => {
  const rows = [{ glyph: "↺", text: "Attempt 1 · returned to agent · 1 check", depth: 0 }, { glyph: "✓", text: "Proof · src/a.ts · 0:02", depth: 0 },
    { glyph: "›", text: "Running project check · bun run check · 1:02", depth: 0 }] as const;
  const seen: boolean[] = [];
  const detail = { line: () => undefined, subscribe: () => () => undefined,
    ledger: (_now: number, all: boolean) => { seen.push(all); return all ? [...rows, { glyph: "✗", text: "Proof · src/a.ts · 0:03", depth: 1 }] : rows; } };
  expect(text(shown("tesota-ledger", detail, 80))).toEqual([
    "Verifying                                                       Tesota receipt",
    "↺ Attempt 1 · returned to agent · 1 check",
    "✓ Proof · src/a.ts · 0:02",
    "› Running project check · bun run check · 1:02",
  ]);
  expect(text(shown("tesota-ledger", detail, 80, true)).at(-1)).toBe("  ✗ Proof · src/a.ts · 0:03");
  expect(seen).toEqual([false, true]);
  const colored = renderers().get("tesota-ledger")?.({ customType: "tesota-ledger", content: "", details: detail },
    { expanded: false, outputPad: 1 }, theme)?.render(80).join("\n") ?? "";
  expect(colored).toContain(theme.fg("success", "✓"));
  expect(colored).toContain(theme.fg("warning", "↺"));
  expect(renderers().get("tesota-ledger")?.({ customType: "tesota-ledger", content: "", details: undefined },
    { expanded: false, outputPad: 1 }, theme)).toBeUndefined();
  // The gate's operations name this renderer as their block, so the shell draws them with it.
  const operations = new GateOperations(() => 0);
  expect(text(shown(operations.block, operations, 80))).toEqual(["Verifying                                                       Tesota receipt"]);
});