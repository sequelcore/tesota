import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import type { SentBack } from "../src/gate.js";
import { hang, registerMessages } from "../src/messages.js";
import type { Receipt } from "../src/receipt.js";
import { loadThemes, themeIn } from "./pi-themes.js";
import { emptyReceipt } from "./receipts.js";

let theme: Theme;
beforeAll(async () => {
  theme = themeIn(await loadThemes(), "tesota-dark");
  // Pi's binding for expanding tool output, as Pi defines it when it starts.
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } } as never));
}, 30_000);

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

it("leads with what needs the operator and keeps the model's opinion out of the count", () => {
  const rows = shown("tesota-receipt", attention, 120);
  // Four findings the checks established; the model's partial match is a note beside them.
  expect(rows[1]).toMatch(/^ ! 4 things need you · ◇ 1 model note +Tesota receipt$/u);
  const headings = rows.filter((row) => /^ [A-Z' ,]+$/u.test(row)).map((row) => row.trim());
  expect(headings).toEqual(["NEEDS YOU", "MODEL'S OPINION, NOT A PROOF", "NOT PROVED"]);
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

it("fits narrow terminals, cutting rows collapsed and wrapping them expanded", () => {
  for (const width of [80, 40]) {
    const collapsed = shown("tesota-receipt", attention, width);
    expect(collapsed[1]).toContain("! 4 things need you");
    expect(collapsed.some((row) => row.endsWith("…"))).toBe(true);
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
  expect(rows).toContain(`From api ${base.slice(0, 12)} · Pi`);
});

it("names a snapshot as the base of a folder in no repository, and a file it left out for its size", () => {
  const base = "b".repeat(40);
  const snapshotted: Receipt = { ...clean, repository: false, snapshot: true, base, tooLarge: ["data/huge.csv"] };
  const rows = shown("tesota-receipt", snapshotted, 120, true).join("\n");
  expect(rows).toContain(`From Tesota's snapshot ${base.slice(0, 12)} · Pi`);
  expect(rows).toContain("data/huge.csv — too large for Tesota's snapshot, which left it out");
});
