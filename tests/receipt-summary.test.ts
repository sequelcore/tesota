import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageRenderer, Theme } from "../src/contract.js";
import { registerMessages } from "../src/messages.js";
import { receiptMarkdown } from "../src/pull-request-receipt.js";
import { entryReceipt, isReceipt, type Receipt, receiptDecisions, receiptEntry, receiptStanding, receiptSummary, renderReceipt, renderReceiptMessage } from "../src/receipt.js";
import { shellTheme } from "../src/theme.js";
import { emptyReceipt } from "./receipts.js";

const themes = { dark: shellTheme("dark", "truecolor"), light: shellTheme("light", "truecolor") };
beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } } as never));
});

function renderer(): MessageRenderer {
  let found: MessageRenderer | undefined;
  registerMessages({ registerMessageRenderer: (type: string, draw: MessageRenderer) => { if (type === "tesota-receipt") found = draw; } } as never);
  if (found === undefined) throw new Error("no receipt renderer");
  return found;
}

function card(receipt: unknown, width: number, expanded: boolean, theme: Theme = themes.dark): string[] {
  const component = renderer()({ customType: "tesota-receipt", content: "", details: receipt }, { expanded, outputPad: 1 }, theme);
  if (component === undefined) throw new Error("no card");
  const rows = component.render(width);
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  return rows;
}
const plain = (rows: readonly string[]): string => rows.map((row) => stripTerminalSequences(row).replace(/^ [│┆] ?/u, "").trimEnd()).join("\n");
const flat = (text: string): string => text.replace(/\s+/gu, " ");
const markdownEscape = /\\[\\`*_{}[\]()#+!|<>~-]/u;

// Historical receipts stay untouched; a v3 reader must refuse their format.
describe.each([574, 575, 577, 584])("historical receipt #%i", (issue) => {
  it("refuses v2 without inventing request context", () => {
    const historical: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "receipts", `receipt-${issue}.json`), "utf8"));
    expect(isReceipt(historical)).toBe(false);
    expect(flat(plain(card(historical, 80, false)))).toContain("Unsupported receipt format");
    expect(flat(plain(card(historical, 80, true)))).toContain("receipt v3 only");
  });
});

/** Explicitly synthetic current data: no historical session is migrated or reconstructed. */
const synthetic: Receipt = { ...emptyReceipt, model: "test/worker", requestContext: { requests: [{ run: 1, text: ["Keep amounts below 100 unchanged."] }] },
  codeEvidence: { ...emptyReceipt.codeEvidence,
    tests: [{ command: "bun test", verdict: "proved", evidence: { verifier: "command", claim: "", limits: "", outcome: "passed", output: "2 pass", durationMs: 1200, files: [], contentHash: "h" } }],
    exercises: [{ path: "tests/total.test.ts", provenance: "added", sensitivity: "unknown", reason: "Base fails too; no per-test failure report." }],
    unverified: ["src/total.ts"] },
  specificationEvidence: { contracts: [{ path: "src/total.ts", name: "total", lines: ["//@ ensures result >= 0"], mutation: { rejected: 1, survived: [], equivalent: 0, inconclusive: 0 } }], weakened: [] },
  requestReview: { ...emptyReceipt.requestReview, contractComparison: { scope: "eligible_changed_contracts", status: "completed", runs: [{ status: "completed", restatedBy: "test/reader", comparedBy: "test/reviewer" }],
    contracts: [{ folder: "", path: "src/total.ts", name: "total", text: "//@ ensures result >= 0", restatement: { preconditions: "None.", postcondition: "Returns a nonnegative amount." },
      assessment: { verdict: "mismatch", explanation: "The contract permits changing amounts below 100." } }] },
    openCases: { status: "listed", model: "test/lister", cases: [{ input: "total(100)", outcomes: ["100", "90"] }] } },
  children: [{ description: "inspect total", outcome: "completed", writes: false, model: "test/child", session: "synthetic-child" }] };

const stopped: Receipt = { ...emptyReceipt, stopped: "the operator stopped the run while Tesota verified it" };
const outside: Receipt = { ...emptyReceipt, repository: false };
const units: Receipt = { ...emptyReceipt, units: [{ ...synthetic, folder: "api" }, { ...emptyReceipt, folder: "notes", repository: false }] };

describe.each([["synthetic", synthetic], ["stopped", stopped], ["outside Git", outside], ["multi-unit", units]] as const)("current %s receipt", (_name, receipt) => {
  it("renders plain text and Markdown", () => {
    expect(renderReceipt(receipt)).toMatchSnapshot("plain");
    expect(renderReceiptMessage(receipt)).toMatchSnapshot("markdown");
  });
  it.each([40, 80, 120])("fits %i columns in both themes without cutting reasons", (width) => {
    for (const expanded of [false, true]) {
      const text = plain(card(receipt, width, expanded));
      expect(text).toMatchSnapshot(`${expanded ? "expanded" : "collapsed"} ${width}`);
      expect(plain(card(receipt, width, expanded, themes.light))).toBe(text);
      expect(text).not.toContain("…");
      expect(text).not.toMatch(markdownEscape);
    }
  });
  it("preserves stored details through the session entry", () => {
    const entry = receiptEntry("tui", receipt);
    expect(entry.type === "custom_message" ? entry.details : undefined).toBe(receipt);
    expect(entryReceipt(JSON.parse(JSON.stringify(entry)) as never)).toEqual(receipt);
  });
});

it("shows context before mechanical sections, keeps model review visible when collapsed, and closes with human acceptance", () => {
  const words = flat(plain(card(synthetic, 120, false)));
  const context = words.indexOf("Request context");
  expect(context).toBeGreaterThan(0);
  expect(words.indexOf("Keep amounts below 100 unchanged.")).toBeGreaterThan(context);
  expect(words.indexOf("Code evidence")).toBeGreaterThan(context);
  expect(words.indexOf("Specification evidence")).toBeGreaterThan(words.indexOf("Code evidence"));
  expect(words).toContain("Evidence standing:");
  expect(words).toContain("Request review — model opinion");
  expect(words).toContain("Mismatch reported");
  expect(words.trimEnd().endsWith("Acceptance remains with the reviewer.")).toBe(true);
});

it("keeps every recorded fact reachable in the expanded card and plain text", () => {
  const facts = ["test/worker", "bun test", "tests/total.test.ts", "src/total.ts", "inspect total", "test/child", "test/lister", "total(100)",
    "The contract permits changing amounts below 100.", "Returns a nonnegative amount."];
  for (const text of [renderReceipt(synthetic), plain(card(synthetic, 120, true))]) {
    for (const fact of facts) expect(flat(text)).toContain(fact);
    expect(text).not.toMatch(markdownEscape);
  }
});

it.each(["no_mismatch_identified", "partial_match", "mismatch", "suspected_vacuity"] as const)("never lets %s change mechanical standing, decisions, flags, limits or methods", (verdict) => {
  const review = synthetic.requestReview.contractComparison;
  const changed: Receipt = { ...synthetic, requestReview: { ...synthetic.requestReview,
    contractComparison: { ...review, contracts: review.contracts.map((contract) => ({ ...contract, assessment: { verdict, explanation: "model opinion" } })) } } };
  const before = receiptSummary(synthetic);
  const after = receiptSummary(changed);
  expect(receiptStanding(changed)).toBe(receiptStanding(synthetic));
  expect(receiptDecisions(changed)).toBe(receiptDecisions(synthetic));
  expect([after.methods, after.flags, after.limits]).toEqual([before.methods, before.flags, before.limits]);
  expect(flat(plain(card(changed, 120, false)))).toContain("model opinion");
});

it.each([
  ["listed-empty", { status: "listed", model: "test/lister", cases: [] }],
  ["disabled", { status: "disabled", reason: "operator disabled open cases" }],
  ["unavailable", { status: "not_run", reason: "no model is selected" }],
] as const)("always shows %s open-case status and no-contract comparison", (_name, openCases) => {
  const receipt: Receipt = { ...emptyReceipt, requestReview: { ...emptyReceipt.requestReview, openCases } };
  const words = flat(plain(card(receipt, 120, false)));
  expect(words).toContain("Request review — model opinion");
  expect(words).toContain("no eligible changed contract");
  expect(words).toContain(`Open cases: ${openCases.status}`);
  expect(words).toContain("reason" in openCases ? openCases.reason : "0 listed");
  expect(receiptDecisions(receipt)).toBe(0);
});

it("retains a literal restatement when comparison fails", () => {
  const comparison = synthetic.requestReview.contractComparison;
  const receipt: Receipt = { ...synthetic, requestReview: { ...synthetic.requestReview, contractComparison: { ...comparison,
    status: "partial", reason: "comparison was stopped", runs: [{ status: "partial", restatedBy: "test/reader", comparedBy: "test/reviewer", failedStage: "comparison" }],
    contracts: comparison.contracts.map(({ assessment: _assessment, ...contract }) => contract) } } };
  for (const text of [renderReceipt(receipt), plain(card(receipt, 120, true))]) {
    expect(flat(text)).toContain("comparison was stopped");
    expect(flat(text)).toContain("Returns a nonnegative amount.");
  }
});

it("keeps subagents and floor refusals as context and omits refused subjects", () => {
  const receipt: Receipt = { ...synthetic, floorRefusals: [{ tool: "write", subject: "../private.txt", reason: "Tesota never allows this: it is outside the session's folder." }] };
  const before = receiptSummary(synthetic);
  const after = receiptSummary(receipt);
  expect([after.methods, after.flags, after.limits]).toEqual([before.methods, before.flags, before.limits]);
  for (const text of [renderReceipt(receipt), renderReceiptMessage(receipt), plain(card(receipt, 120, true))]) {
    expect(flat(text)).toContain("inspect total");
    expect(flat(text)).toContain("outside the session's folder");
    expect(text).not.toContain("private.txt");
  }
});

it("says stopped runs verified nothing and claims no method", () => {
  expect(receiptSummary(stopped).methods.map(({ glyph, text }) => [glyph, text])).toEqual([["○", "none recorded"], ["○", "none recorded"], ["○", "none recorded"]]);
  expect(receiptStanding(stopped)).toBe("incomplete");
});

it("qualifies workspace paths and keeps each unresolved repository visible", () => {
  const receipt: Receipt = { ...emptyReceipt, units: ["api", "rules"].map((folder) => ({ ...emptyReceipt, folder,
    base: "H", startState: { status: "known", head: "H" }, endState: { status: "known", head: "other" },
    codeEvidence: { ...emptyReceipt.codeEvidence, unheaded: ["models/NoHeader.tla"] } })) };
  for (const text of [renderReceipt(receipt), renderReceiptMessage(receipt), plain(card(receipt, 80, false))]) {
    expect(flat(text)).toContain("api: history moved");
    expect(flat(text)).toContain("rules: history moved");
    expect(flat(text).match(/history moved/gu)).toHaveLength(2);
  }
});

it("exports fenced plain text without interpreting receipt content", () => {
  const markdown = receiptMarkdown(synthetic, { commit: "abc", owner: "operator", sessionId: "session", stale: [], changedAfter: [] });
  const fenced = markdown.slice(markdown.indexOf("```text") + 8, markdown.lastIndexOf("```"));
  expect(fenced.trimEnd()).toBe(renderReceipt(synthetic));
});

it("shows stopped-run capture gaps beside changed paths", () => {
  const receipt: Receipt = { ...stopped, changed: [{ path: "src/a.ts", blob: "b".repeat(40) }], unmeasured: [{ path: "cache/", reason: "untracked directory" }],
    tooLarge: ["data/huge.csv"], endState: { status: "unknown", reason: "Git could not read HEAD" } };
  const text = renderReceipt(receipt);
  expect(text).toContain("left changed  src/a.ts");
  expect(text).toContain("cache/: untracked directory");
  expect(text).toContain("data/huge.csv: Tesota's snapshot left it out for its size");
  expect(text).toContain("the run's end: Git could not read HEAD");
});
