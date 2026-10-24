import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageRenderer, Theme } from "../src/contract.js";
import { registerMessages } from "../src/messages.js";
import { receiptMarkdown } from "../src/pull-request-receipt.js";
import { entryReceipt, isReceipt, type Receipt, receiptEntry, receiptStanding, receiptSummary, renderReceipt, renderReceiptMessage } from "../src/receipt.js";
import { shellTheme } from "../src/theme.js";
import { emptyReceipt } from "./receipts.js";

/**
 * The battle-test receipts of 2026-10-22 (#574, #575, #577, #584), as their
 * sessions recorded their `details`, with each subagent's session path made
 * neutral. #591's redesign is judged on these.
 */
const real = (issue: number): Receipt =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "receipts", `receipt-${issue}.json`), "utf8")) as Receipt;
const fixtures = [574, 575, 577, 584].map((issue) => [issue, real(issue)] as const);

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

/** The receipt card's rows at `width`, with their escape sequences; each must fit the width. */
function card(receipt: Receipt, width: number, expanded: boolean, theme: Theme = themes.dark): string[] {
  const component = renderer()({ customType: "tesota-receipt", content: "", details: receipt }, { expanded, outputPad: 1 }, theme);
  if (component === undefined) throw new Error("no card");
  const rows = component.render(width);
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  return rows;
}

const plain = (rows: readonly string[]): string => rows.map((row) => stripTerminalSequences(row).trimEnd()).join("\n");
const flat = (text: string): string => text.replace(/\s+/gu, " ");

/** A Markdown escape: a backslash before a character Markdown would otherwise read. */
const markdownEscape = /\\[\\`*_{}[\]()#+!|<>~-]/u;

describe("the real receipt of #584, as the issue shows it", () => {
  const receipt = real(584);

  it("leads with its counts and the acceptance line, then each method, then grouped reasons", () => {
    expect(renderReceipt(receipt).split("\n").slice(0, 15)).toEqual([
      "Tesota receipt",
      "2 review flags · 6 verification limits",
      "Check evidence, not your acceptance.",
      "",
      "✓ Tested   bun run check · 5:58",
      "○ Proved   none recorded",
      "○ Models   none recorded",
      "",
      "! Review test edits · 2 heuristic flags",
      "  May weaken evidence; not confirmed weakening.",
      "○ Change sensitivity unknown · 3 test files",
      "  Base fails too; no per-test failure report.",
      "○ No proof covers 3 changed files",
      "",
      "Details",
    ]);
  });

  it("collapsed in the transcript, ends with what Ctrl+O shows and the request's context", () => {
    const rows = plain(card(receipt, 120, false)).split("\n").map((row) => row.trim()).filter((row) => row !== "");
    expect(rows.slice(0, 3)).toEqual(["Tesota receipt", "2 review flags · 6 verification limits", "Check evidence, not your acceptance."]);
    expect(rows.slice(-2)).toEqual(["▸ Details · paths, output, assumptions, model opinions", "▸ Context · 1 answer · 1 subagent"]);
    expect(rows.join("\n")).not.toContain("tests/working-orb.test.ts");
  });
});

describe.each(fixtures)("the real receipt of #%i", (issue, receipt) => {
  it("as plain text and as Markdown", () => {
    expect(renderReceipt(receipt)).toMatchSnapshot("plain");
    expect(renderReceiptMessage(receipt)).toMatchSnapshot("markdown");
  });

  it.each([40, 80, 120])("as a card %i columns wide, the same words in both themes", (width) => {
    for (const expanded of [false, true]) {
      const text = plain(card(receipt, width, expanded));
      expect(text).toMatchSnapshot(`${expanded ? "expanded" : "collapsed"} ${width}`);
      expect(plain(card(receipt, width, expanded, themes.light))).toBe(text);
      // A reason wraps; it is never cut.
      expect(text).not.toContain("…");
    }
  });

  it("in each theme's colors", () => {
    for (const [name, theme] of Object.entries(themes)) {
      expect(JSON.stringify(card(receipt, 80, false, theme), null, 1)).toMatchSnapshot(`${name} collapsed 80`);
    }
  });

  it("keeps every fact the receipt records reachable in its details", () => {
    const facts = [
      receipt.engine, receipt.base?.slice(0, 12) ?? "", receipt.model ?? "",
      ...receipt.tests.map(({ command }) => command),
      ...receipt.unverified,
      ...typeof receipt.weakened === "string" ? [] : receipt.weakened.map(({ path }) => path),
      ...receipt.exercises.flatMap(({ path, reason }) => [path, reason]),
      ...(receipt.children ?? []).flatMap(({ description, model }) => [description, model ?? ""]),
      ...(receipt.clarifications ?? []).flatMap(({ questions, answers }) => questions.flatMap(({ question, options }, k) =>
        [question, ...(answers[k]?.selected ?? []).map((selected) => options[selected]?.label ?? ""), answers[k]?.text ?? ""])),
      ...receipt.openCases?.status === "listed" ? [receipt.openCases.model, ...receipt.openCases.cases.flatMap(({ input, outcomes }) =>
        [input, ...outcomes.map((outcome) => outcome.replace(/\.$/u, ""))])] : [],
    ].filter((fact) => fact !== "");
    const expanded = flat(plain(card(receipt, 120, true)));
    const text = flat(renderReceipt(receipt));
    for (const fact of facts) {
      expect(expanded).toContain(flat(fact));
      expect(text).toContain(flat(fact));
    }
  });

  it("leaks no Markdown escape into plain text or the card, and keeps the details object as the session wrote it", () => {
    expect(renderReceipt(receipt)).not.toMatch(markdownEscape);
    for (const expanded of [false, true]) expect(plain(card(receipt, 80, expanded))).not.toMatch(markdownEscape);
    const entry = receiptEntry("tui", receipt);
    expect(entry.type === "custom_message" ? entry.details : undefined).toBe(receipt);
    const read = entryReceipt(JSON.parse(JSON.stringify(entry)) as never);
    expect(isReceipt(read)).toBe(true);
    expect(read).toEqual(receipt);
  });

  it("counts flags and limits as the receipt's findings do, and never a model's opinion or a subagent", () => {
    const summary = receiptSummary(receipt);
    const { openCases: _cases, children: _children, clarifications: _answers, ...evidence } = receipt;
    const withoutOpinions = receiptSummary(evidence);
    expect(summary.counts).toEqual(withoutOpinions.counts);
    expect(summary.methods).toEqual(withoutOpinions.methods);
    expect([...summary.flags, ...summary.limits]).toEqual([...withoutOpinions.flags, ...withoutOpinions.limits]);
  });
});

it("groups #575's note that the open-case lister lacked the issue's contents with the opinions, never as a finding", () => {
  const receipt = real(575);
  const summary = receiptSummary(receipt);
  expect(summary.opinions.map(({ title }) => title)).toEqual(["1 open case for you to settle, listed by openai/gpt-6-sol"]);
  expect([...summary.flags, ...summary.limits].map(({ title }) => title).join("\n")).not.toMatch(/open case|not supplied/iu);
  const text = renderReceipt(receipt);
  const opinions = text.indexOf("Model opinions · not evidence, not counted");
  expect(opinions).toBeGreaterThan(text.indexOf("○ No proof covers 3 changed files"));
  expect(text.indexOf("◇ 1 open case for you to settle")).toBeGreaterThan(opinions);
  // ClaimCheck's opinion and a listing that did not happen sit in the same group.
  const unlisted = receiptSummary({ ...receipt, openCases: { status: "not_listed", reason: "openai/gpt-6-sol could not read issue #575's contents" } });
  expect(unlisted.opinions).toEqual([{ glyph: "◇", title: "Open cases not listed", note: "openai/gpt-6-sol could not read issue #575's contents",
    items: [] }]);
  expect(unlisted.counts).toEqual(summary.counts);
});

it("lists a subagent as context, never as evidence of the parent's change", () => {
  const receipt = real(577);
  expect(receiptSummary(receipt).context).toBe("2 subagents");
  const text = renderReceipt(receipt);
  expect(text).toContain("Subagents (each one's receipt covers its own branch, not this change)");
  expect(text.slice(0, text.indexOf("Details"))).not.toContain("review session folder fix");
});

it("lists the floor's refusals apart from the evidence, never as a verdict, and never what they named (#622)", () => {
  const receipt = real(577);
  const refused: Receipt = { ...receipt, floorRefusals: [
    { tool: "powershell", subject: "Get-Content C:/private/.env", reason: "Tesota never allows this: it names a secret: an .env file, SSH's keys or Tesota's credentials." },
    { tool: "write", subject: "../cleanup.cjs", reason: "Tesota never allows this: it is outside the session's folder." }],
    children: (receipt.children ?? []).map((child, index) => index === 0 ? { ...child, floorRefusals: 1 } : child) };
  const before = receiptSummary(receipt);
  const after = receiptSummary(refused);
  expect(after.counts).toBe(before.counts);
  expect(after.methods).toEqual(before.methods);
  expect(after.context).toBe("2 subagents · 2 calls the floor refused");
  // The Markdown escapes its punctuation; the words are the same.
  for (const text of [renderReceipt(refused), renderReceiptMessage(refused).replaceAll("\\", "")]) {
    expect(text).toContain("Refused by Tesota's floor (these calls didn't run; that says nothing of what ran instead)");
    expect(text).toMatch(/powershell: it names a secret/u);
    expect(text).toMatch(/1 call the floor refused/u);
    expect(text).not.toContain("private");
    expect(text).not.toContain("cleanup.cjs");
  }
});

describe("receipts beyond the four", () => {
  const stopped: Receipt = { ...emptyReceipt, stopped: "the operator stopped the run while Tesota verified it" };
  const outside: Receipt = { ...emptyReceipt, repository: false, changed: [] };
  const units: Receipt = { ...emptyReceipt, units: [
    { ...real(584), folder: "api" },
    { ...emptyReceipt, folder: "notes", repository: false },
  ] };
  const cases = [["stopped", stopped], ["outside Git", outside], ["multi-unit", units]] as const;

  it.each(cases)("%s, as plain text, Markdown and a card", (_name, receipt) => {
    expect(renderReceipt(receipt)).toMatchSnapshot("plain");
    expect(renderReceiptMessage(receipt)).toMatchSnapshot("markdown");
    for (const width of [40, 80, 120]) {
      for (const expanded of [false, true]) expect(plain(card(receipt, width, expanded))).toMatchSnapshot(`${expanded ? "expanded" : "collapsed"} ${width}`);
    }
    expect(renderReceipt(receipt)).not.toMatch(markdownEscape);
  });

  it("says a stopped run verified nothing, and claims no method", () => {
    const summary = receiptSummary(stopped);
    expect(summary.counts).toBe("1 review flag · no verification limits");
    expect(summary.methods.map(({ glyph, text }) => `${glyph} ${text}`)).toEqual(["○ none recorded", "○ none recorded", "○ none recorded"]);
    expect(summary.flags).toEqual([{ glyph: "!", title: "Not verified · this request's changes",
      note: "the operator stopped the run while Tesota verified it", items: ["this request's changes"] }]);
  });

  it("names each repository's paths by its folder, and a folder in no repository as not verified", () => {
    const summary = receiptSummary(units);
    expect(summary.methods[0]).toEqual({ glyph: "✓", method: "Tested", text: "cd api && bun run check · 5:58" });
    expect(summary.flags.map(({ title }) => title)).toEqual(["Review test edits · 2 heuristic flags", "Not verified · notes"]);
    expect(summary.limits.find(({ title }) => title === "No proof covers 3 changed files")?.items)
      .toEqual(["api/NOTICE", "api/src/tesota.ts", "api/src/welcome-header.ts"]);
  });

  it("calls a passing model model-checked, never proved, and a trusted proof partial", () => {
    const model = { path: "models/Stock.tla", language: "tla", problems: [], run: "passed", states: 13, faults: [], link: "no_replay",
      staleness: "current", stale: [], writtenWithCode: false, verdict: "proved",
      header: { covers: [{ path: "src/stock.ts", names: [] }], invariants: ["NeverNegative"], atomic: [], omits: [], faults: [] },
      evidence: { verifier: "tlc", claim: "", limits: "", outcome: "passed", output: "", durationMs: 12_000, files: [], contentHash: "h" },
    } as unknown as NonNullable<Receipt["models"]>[number];
    const proof = { path: "src/range.ts", verdict: "proved", evidence: { verifier: "lemmascript", claim: "", limits: "", outcome: "passed",
      output: "Dafny program verifier finished with 2 verified, 0 errors", durationMs: 2_118, files: ["src/range.ts"], contentHash: "h" } } as const;
    const summary = receiptSummary({ ...emptyReceipt, models: [model], proofs: [proof],
      weakened: [{ path: "src/range.ts", kind: "added_assume", annotation: "//@ extern", function: "lower" }] });
    expect(summary.methods.find(({ method }) => method === "Models")).toEqual({ glyph: "✓", method: "Models",
      text: "models/Stock.tla · model-checked, not linked to the code · 0:12" });
    expect(summary.methods.find(({ method }) => method === "Proved")).toEqual({ glyph: "◐", method: "Proved",
      text: "src/range.ts · trusting 1 unproved part · 0:02" });
    expect(JSON.stringify(summary.methods)).not.toMatch(/Models[^}]*proved/u);
    // A model that holds less than outright never reads ✓: an unrun fault, one written with the code, one possibly stale.
    const unrun = { path: "models/Fault.tla", verdict: "unrun", output: "TLC ran past its limit", durationMs: 1 };
    for (const weaker of [{ faults: [unrun] }, { writtenWithCode: true }, { staleness: "possibly_stale", stale: ["src/stock.ts"] }]) {
      const row = receiptSummary({ ...emptyReceipt, models: [{ ...model, ...weaker } as typeof model] }).methods
        .find(({ method }) => method === "Models");
      expect(row?.glyph).toBe("◐");
    }
  });

  it("a model failure kept when generation ends is failed, not already sent back", () => {
    const model = { path: "models/Stock.tla", language: "tla", problems: [], run: "violation", states: 2,
      faults: [], link: "no_replay", staleness: "current", stale: [], writtenWithCode: false, verdict: "send_back",
      counterexample: { violation: "NeverNegative", steps: [] },
      header: { covers: [{ path: "src/stock.ts", names: [] }], invariants: ["NeverNegative"], atomic: [], omits: [], faults: [] },
      evidence: { verifier: "tlc", claim: "", limits: "", outcome: "failed", output: "NeverNegative", durationMs: 1, files: [], contentHash: "h" },
    } as unknown as NonNullable<Receipt["models"]>[number];
    const receipt = { ...emptyReceipt, unresolvedQuestion: "Which option should I use?", models: [model] };
    expect(receiptStanding(receipt)).toBe("failed");
    expect(renderReceipt(receipt)).not.toContain("already sent back");
    expect(renderReceipt(receipt)).toContain("generation ended before repair");
  });

  it("never counts ClaimCheck's judgment, or the cases a model listed, as a flag or a limit", () => {
    const contract = { path: "src/range.ts", name: "inRange", lines: [], mutation: { rejected: 1, survived: [], equivalent: 0, inconclusive: 0 },
      judgment: { verdict: "not_justified", explanation: "It allows any result." } } as const;
    const evidence: Receipt = { ...emptyReceipt, contracts: [contract] };
    const judged = receiptSummary({ ...evidence, claimcheck: { status: "judged", restatedBy: "m", comparedBy: "m" },
      openCases: { status: "listed", model: "m", cases: [{ input: "inRange(-1)", outcomes: ["0", "-1"] }] } });
    const bare = receiptSummary(evidence);
    expect(judged.counts).toBe(bare.counts);
    expect([...judged.flags, ...judged.limits]).toEqual([...bare.flags, ...bare.limits]);
    expect(judged.opinions.map(({ glyph }) => glyph)).toEqual(["◇", "◇"]);
  });

  it("names a test that noticed the change only by what was observed", () => {
    const summary = receiptSummary({ ...emptyReceipt, exercises: [
      { path: "tests/a.test.ts", provenance: "added", sensitivity: "fails_then_passes", reason: "fails on the base, passes with the change" },
      { path: "tests/b.test.ts", provenance: "changed", sensitivity: "unknown", reason: "no project's commands run it" }] });
    expect(summary.methods.find(({ method }) => method === "Exercised"))
      .toEqual({ glyph: "◐", method: "Exercised", text: "1 of 2 test files failed on the base and passed with the change" });
    expect(JSON.stringify(summary)).not.toMatch(/\b(correct|verified)\b/u);
  });

  it("as a pull request's Markdown, bound to its commit, with the receipt fenced so nothing in it renders", () => {
    const receipt = real(584);
    const markdown = receiptMarkdown(receipt, { commit: "6734e933830ece530d8323f40242be7800229863", owner: "operator",
      sessionId: "session-584", stale: [], changedAfter: [] });
    expect(markdown).toMatchSnapshot();
    const fenced = markdown.slice(markdown.indexOf("```text") + 8, markdown.lastIndexOf("```"));
    expect(fenced.trimEnd()).toBe(renderReceipt(receipt));
    expect(fenced).not.toMatch(markdownEscape);
  });
});
