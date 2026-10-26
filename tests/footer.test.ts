import { join, sep } from "node:path";
import type { ContextUsage, FooterData, Theme } from "../src/contract.js";
import { shellTheme } from "../src/theme.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it, vi } from "vitest";
import type { Evidence } from "../src/evidence.js";
import { EvidenceFooter, evidenceParts, evidenceText, homeRelative } from "../src/footer.js";
import { GateProgress, type GateStatus } from "../src/gate.js";
import type { Receipt } from "../src/receipt.js";
import { footerLayout, readiness } from "../src/verification/footer-rule.js";
import { emptyReceipt } from "./receipts.js";

let theme: Theme;
beforeAll(async () => { theme = shellTheme("dark", "truecolor"); });

function evidence(outcome: Evidence["outcome"]): Evidence {
  return { verifier: "lemmascript", claim: "", limits: "", outcome, output: "", durationMs: 1, files: [], contentHash: "h" };
}

const proved = { path: "src/clamp.ts", verdict: "proved", evidence: evidence("passed") } as const;
const passing = { command: "bun test", evidence: evidence("passed"), verdict: "proved" } as const;
const strong = { path: "src/clamp.ts", name: "clamp", lines: [],
  mutation: { rejected: 6, survived: [], equivalent: 0, inconclusive: 0 } };

function words(status: GateStatus, level: "full" | "short" | "glyphs" = "full"): string {
  return evidenceText(evidenceParts(status, 0), level);
}

it("says what Tesota can verify before any request", () => {
  expect(words({ step: "ready", readiness: readiness(true, true) })).toBe("● ready · proofs and tests");
  expect(words({ step: "ready", readiness: readiness(false, true) })).toBe("● ready · tests only");
  expect(words({ step: "ready", readiness: readiness(true, false) })).toBe("● ready · proofs only");
  expect(words({ step: "ready", readiness: readiness(false, false) })).toBe("● ready · nothing to check with");
  // With nothing to check with, the whole row is in gold.
  expect(evidenceParts({ step: "ready", readiness: "nothing" }).map(({ color }) => color)).toEqual(["warning", "warning"]);
});

it("says the gate waits, not that it is ready, while the agent works", () => {
  expect(words({ step: "waiting", readiness: "tests_only" })).toBe("◌ waiting for the agent · tests only");
  expect(words({ step: "waiting", readiness: "proofs_and_tests" }, "short")).toBe("◌ waiting · proofs, tests");
  expect(words({ step: "waiting", readiness: "tests_only" }, "glyphs")).toBe("◌ · tests");
  expect(evidenceParts({ step: "waiting", readiness: "tests_only" })[0]?.color).toBe("muted");
});

it("says the run waits for you while the shell asks you a question, and does not list that again at the right", () => {
  const waiting = { step: "waiting", readiness: "tests_only" } as const;
  expect(evidenceText(evidenceParts(waiting, 0, true), "full")).toBe("◌ waiting for you · tests only");
  expect(evidenceParts(waiting, 0, true)[0]?.color).toBe("accent");
  // Outside a run a question, such as /model's, changes nothing: the gate is ready.
  expect(evidenceText(evidenceParts({ step: "ready", readiness: "tests_only" }, 0, true), "full")).toBe("● ready · tests only");
  const progress = new GateProgress();
  progress.waiting();
  const row = footer(progress, { question: "waiting for you", permissions: "ask" }).rows(120)[1] ?? "";
  expect(row.startsWith(" ◌ waiting for you · nothing to check with")).toBe(true);
  expect(row.endsWith(" · ask")).toBe(true);
  expect(row.match(/waiting for you/gu)).toHaveLength(1);
});

it("names the gate's step and what its round found so far", () => {
  expect(words({ step: "proving", path: "src/clamp.ts", startedAt: 0, tally: { proved: 0, notProved: 0 } }))
    .toBe("◐ proving · 0s");
  expect(words({ step: "testing", startedAt: 0, tally: { proved: 2, notProved: 0 } })).toBe("◐ testing… · 0s · 2 proved");
  expect(words({ step: "measuring", startedAt: 0, tally: { proved: 1, notProved: 0, tests: "pass" } }))
    .toBe("◐ measuring contracts… · 0s · 1 proved · tests pass");
  expect(words({ step: "sent_back", tally: { proved: 1, notProved: 1, tests: "fail", weak: 2 } }))
    .toBe("↺ sent back · 1 proved · 1 not proved · tests fail · 2 weak contracts");
  expect(words({ step: "sent_back", tally: { proved: 1, notProved: 0, tests: "pass", weak: 1 } }, "glyphs"))
    .toBe("↺ · ✓1 · tests ✓ · weak 1");
});

it("sums up the receipt, leading with whether anything in it needs the operator", () => {
  const clean: Receipt = { ...emptyReceipt, proofs: [proved], tests: [passing], contracts: [strong],
    uncovered: [{ path: "src/parse.ts", lines: [[12, 14]] }] };
  expect(words({ step: "settled", receipt: clean })).toBe("○ receipt · 1 proved · tests pass · contracts strong · 3 lines not proved");
  expect(words({ step: "settled", receipt: clean }, "short")).toBe("○ receipt · 1 proved · tests ✓ · 3 lines unproved");
  const weak: Receipt = { ...clean, contracts: [{ ...strong,
    mutation: { ...strong.mutation, survived: [{ line: 4, operator: "comparison", before: ">", after: ">=" }] } }],
    weakened: [{ kind: "edited_test", path: "tests/clamp.test.ts" }], unverified: ["notes.md"], tests: [] };
  expect(words({ step: "settled", receipt: weak }))
    .toBe("! receipt · 1 proved · 1 weak contract · 3 lines not verified · 1 file not verified · 1 may weaken the evidence");
  expect(words({ step: "settled", receipt: weak }, "short"))
    .toBe("! receipt · 1 proved · 1 weak · 3 lines unproved · 1 file unproved · 1 may weaken");
  expect(words({ step: "settled", receipt: { ...emptyReceipt, repository: false } })).toBe("! receipt · not verified, no Git repository");
  expect(words({ step: "settled", receipt: { ...clean, weakened: "too_large", uncovered: [] } }))
    .toBe("! receipt · 1 proved · tests pass · contracts strong · weakening not checked");
});

it("counts a proof that doesn't hold apart from one that checked nothing or couldn't run", () => {
  const failing = { ...proved, verdict: "send_back", evidence: evidence("failed") } as const;
  const settledWith = (proof: Receipt["proofs"][number], level: "full" | "glyphs" = "full"): string =>
    words({ step: "settled", receipt: { ...emptyReceipt, proofs: [proof] } }, level);
  expect(settledWith(failing)).toContain("1 not proved");
  expect(settledWith(failing, "glyphs")).toContain("✗1");
  // Dafny verified nothing, the proof didn't start, or its content changed: a gap, never red.
  for (const gap of [{ ...proved, verdict: "send_back", evidence: evidence("vacuous") }, { ...proved, verdict: "no_progress", evidence: evidence("vacuous") },
    { ...proved, verdict: "operator", evidence: evidence("not_started") },
    { ...proved, verdict: "operator", evidence: { ...evidence("passed"), invalidated: "content_changed" } }] as const) {
    expect(settledWith(gap), gap.evidence.outcome).not.toContain("not proved");
    expect(settledWith(gap, "glyphs"), gap.evidence.outcome).not.toContain("✗");
    expect(settledWith(gap), gap.evidence.outcome).toContain("1 not checked");
  }
});
it("says tests fail only for a command that ran and failed, and counts one that didn't run or is stale as not checked", () => {
  const settledWith = (command: Receipt["tests"][number], level: "full" | "glyphs" = "full"): string =>
    words({ step: "settled", receipt: { ...emptyReceipt, tests: [command] } }, level);
  const failing = { ...passing, verdict: "send_back", evidence: evidence("failed") } as const;
  expect(settledWith(failing)).toContain("tests fail");
  expect(settledWith(failing, "glyphs")).toContain("tests ✗");
  for (const gap of [{ ...passing, verdict: "operator", evidence: evidence("not_started") }, { ...passing, verdict: "operator", evidence: evidence("timed_out") },
    { ...passing, verdict: "operator", evidence: { ...evidence("passed"), invalidated: "content_changed" } }] as const) {
    expect(settledWith(gap), gap.evidence.outcome).not.toContain("tests fail");
    expect(settledWith(gap, "glyphs"), gap.evidence.outcome).not.toContain("✗");
    expect(settledWith(gap), gap.evidence.outcome).toContain("1 not checked");
  }
  // A failure beside a gap still reads as failing.
  expect(words({ step: "settled", receipt: { ...emptyReceipt, tests: [failing, { ...passing, verdict: "operator", evidence: evidence("not_started") }] } }))
    .toContain("tests fail");
});
it("names the model being checked, then sums up the models: checked, still failing, and possibly stale", () => {
  expect(words({ step: "checking", path: "models/Stock.tla", startedAt: 0, tally: { proved: 0, notProved: 0, tests: "pass" } }))
    .toBe("◐ checking models… · 0s · tests pass");
  const model: NonNullable<Receipt["models"]>[number] = { path: "models/Stock.tla", language: "tla", problems: [], run: "passed", states: 13,
    header: { covers: [{ path: "src/stock.mjs", names: [] }], invariants: ["NeverOversold"], atomic: ["each await"], omits: ["failures"], faults: [] },
    evidence: { ...evidence("passed"), verifier: "tlc" }, faults: [], staleness: "possibly_stale", stale: ["src/stock.mjs"],
    writtenWithCode: false, link: "no_replay", verdict: "proved" };
  // Still failing: TLC ran and found a counterexample, as a model whose check went back records it.
  const violated: typeof model = { ...model, run: "violated", evidence: { ...evidence("failed"), verifier: "tlc" }, staleness: "current" };
  expect(words({ step: "settled", receipt: { ...emptyReceipt, models: [model] } })).toBe("○ receipt · 1 model checked · 1 model possibly stale");
  expect(words({ step: "settled", receipt: { ...emptyReceipt, models: [{ ...violated, verdict: "no_progress" }] } }))
    .toBe("! receipt · 1 model fails");
  expect(words({ step: "settled", receipt: { ...emptyReceipt, unresolvedQuestion: "Which option?",
    models: [{ ...violated, verdict: "send_back" }] } })).toContain("1 model fails");
  // A model TLC could not read went back to the agent, but nothing ran: a gap, never a failure.
  const malformed: typeof model = { ...model, run: "malformed", states: 0, evidence: { ...evidence("failed"), verifier: "tlc" }, staleness: "current" };
  for (const verdict of ["send_back", "no_progress"] as const) {
    const shown = words({ step: "settled", receipt: { ...emptyReceipt, models: [{ ...malformed, verdict }] } });
    expect(shown).not.toContain("model fails");
    expect(shown).toContain("1 not checked");
  }
  expect(words({ step: "settled", receipt: { ...emptyReceipt, models: [{ ...model, verdict: "operator", staleness: "current" }] } }))
    .toBe("○ receipt · 1 not checked");
});

it("never counts a stopped run as verified, even in a repository", () => {
  const receipt: Receipt = { ...emptyReceipt, stopped: "quota exhausted" };
  expect(words({ step: "settled", receipt })).toBe("! receipt · not verified, run ended before verification");
  expect(words({ step: "settled", receipt }, "short")).toBe("! receipt · not verified");
  expect(words({ step: "settled", receipt }, "glyphs")).toBe("! · not verified");
  expect(evidenceParts({ step: "settled", receipt }).map(({ color }) => color)).toEqual(["warning", "warning"]);
});

it("tells a proof that holds only given what the change trusts without proof from one proved outright (#399)", () => {
  const checked = { ...proved, evidence: { ...proved.evidence, files: ["src/clamp.ts", "src/clamp.dfy"] } };
  const extern = (name: string) => ({ path: "src/clamp.ts", kind: "added_assume", annotation: "//@ extern", function: name }) as const;
  const assumed: Receipt = { ...emptyReceipt, proofs: [checked, { ...checked, path: "src/parse.ts", evidence: { ...checked.evidence,
    files: ["src/parse.ts", "src/parse.dfy"] } }], tests: [passing],
    // An assumption in the .dfy LemmaScript keeps elsewhere counts for its proof as well.
    weakened: [extern("lower"), extern("upper"), { path: "src/clamp.dfy", kind: "added_assume", annotation: "assume false;" }] };
  expect(words({ step: "settled", receipt: assumed }))
    .toBe("! receipt · 1 proved · 1 proved on trust · tests pass · 3 may weaken the evidence");
  expect(words({ step: "settled", receipt: assumed }, "short")).toBe("! receipt · 1 proved · 1 on trust · tests ✓ · 3 may weaken");
  expect(words({ step: "settled", receipt: assumed }, "glyphs")).toBe("! · ✓1 · trust 1 · tests ✓ · weakens 3");
});

it("counts what the checks established and never a model's opinion, as the receipt in the conversation does", () => {
  const judged: Receipt = { ...emptyReceipt, proofs: [proved], tests: [passing],
    contracts: [{ ...strong, judgment: { verdict: "not_justified", explanation: "It allows a negative result." } }],
    claimcheck: { status: "judged", restatedBy: "openai/gpt-5.5", comparedBy: "openai/gpt-5.5" } };
  expect(words({ step: "settled", receipt: judged })).toBe("✓ receipt · 1 proved · tests pass · contracts strong");
  const misses: Receipt = { ...judged, exercises: [{ path: "tests/clamp.test.ts", provenance: "added", sensitivity: "passes_on_base",
    reason: "it passes without the change too" }] };
  expect(words({ step: "settled", receipt: misses })).toBe("! receipt · 1 proved · tests pass · contracts strong · 1 test passes without the change");
  expect(words({ step: "settled", receipt: misses }, "short")).toBe("! receipt · 1 proved · tests ✓ · 1 test passes on base");
  expect(words({ step: "settled", receipt: misses }, "glyphs")).toBe("! · ✓1 · tests ✓ · base 1");
  // Strength needs a change the proof caught: two changes that behave the same as the code show nothing.
  const unmeasured: Receipt = { ...judged, contracts: [{ ...strong, mutation: { ...strong.mutation, rejected: 0, equivalent: 2 } }] };
  expect(words({ step: "settled", receipt: unmeasured })).toBe("○ receipt · 1 proved · tests pass · 1 not checked");
});

it("says there was nothing to verify when the change was comments alone, and only when nothing else is listed", () => {
  const comments: Receipt = { ...emptyReceipt, commentsOnly: true };
  // Nothing verified a change of comments alone, so it is not checked as verified (#668).
  expect(words({ step: "settled", receipt: comments })).toBe("○ receipt · nothing to verify, comments only");
  expect(words({ step: "settled", receipt: comments }, "short")).toBe("○ receipt · nothing to verify");
  expect(words({ step: "settled", receipt: comments }, "glyphs")).toBe("○ · no code");
  expect(words({ step: "settled", receipt: { ...comments, proofs: [proved] } })).toBe("✓ receipt · 1 proved");
  expect(words({ step: "settled", receipt: emptyReceipt })).toBe("○ receipt · nothing to verify, nothing changed");
});

it("drops the folder first, then the model, then shortens the evidence, and drops the context % last, never the statuses", () => {
  // Widths: evidence 40, 30 or 10; context 6; folder 40; model 15; statuses 11 ("full access"); " · " between the right's items.
  expect(footerLayout(130, 40, 30, 10, 6, 40, 15, 11)).toEqual({ level: "full", context: true, model: true, place: true });
  expect(footerLayout(100, 40, 30, 10, 6, 40, 15, 11)).toEqual({ level: "full", context: true, model: true, place: false });
  expect(footerLayout(70, 40, 30, 10, 6, 40, 15, 11)).toEqual({ level: "full", context: true, model: false, place: false });
  expect(footerLayout(55, 40, 30, 10, 6, 40, 15, 11)).toEqual({ level: "short", context: true, model: false, place: false });
  expect(footerLayout(40, 40, 30, 10, 6, 40, 15, 11)).toEqual({ level: "glyphs", context: true, model: false, place: false });
  expect(footerLayout(25, 40, 30, 10, 6, 40, 15, 11)).toEqual({ level: "glyphs", context: false, model: false, place: false });
  // Without statuses, nothing is kept for them.
  expect(footerLayout(116, 40, 30, 10, 6, 40, 15, 0)).toEqual({ level: "full", context: true, model: true, place: true });
});

it("writes the folder from home as Pi's footer does", () => {
  expect(homeRelative(join("/home", "ana", "work"), join("/home", "ana"))).toBe(`~${sep}work`);
  expect(homeRelative(join("/home", "ana"), join("/home", "ana"))).toBe("~");
  expect(homeRelative(join("/home", "anabel"), join("/home", "ana"))).toBe(join("/home", "anabel"));
  expect(homeRelative(join("/srv", "work"), "")).toBe(join("/srv", "work"));
});

function data(statuses: Record<string, string> = {}): FooterData & { branchChanged: () => void } {
  let listener = (): void => undefined;
  return { getGitBranch: () => "feat/range", getExtensionStatuses: () => new Map(Object.entries(statuses)),
    getAvailableProviderCount: () => 1, onBranchChange: (callback) => { listener = callback; return () => undefined; },
    branchChanged: () => { listener(); } };
}

function footer(progress: GateProgress, statuses: Record<string, string> = {}, usage?: ContextUsage) {
  let renders = 0;
  const view = new EvidenceFooter(theme, data(statuses), progress, { cwd: join("/srv", "parse-range"),
    model: () => "gpt-5.5 medium", context: () => usage ?? { tokens: 13_000, contextWindow: 272_000, percent: 4.8 } },
  () => { renders++; });
  return { view, renders: () => renders, rows: (width: number) => view.render(width).map(stripTerminalSequences) };
}

it("shows the proving step and elapsed time, not the file the status line names (#590), even when the verifier produces no output", () => {
  vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
  const progress = new GateProgress();
  const { view, rows, renders } = footer(progress);
  try {
    progress.publish({ step: "proving", path: "src/lib/rules.ts", startedAt: 0, tally: { proved: 0, notProved: 0 } });
    expect(rows(120)[1]).toMatch(/^ ◐ proving · 0s +\S.* · ctx 5%$/u);
    vi.advanceTimersByTime(59_000);
    expect(rows(120)[1]).toMatch(/^ ◐ proving · 59s +\S.* · ctx 5%$/u);
    vi.advanceTimersByTime(1_000);
    expect(rows(120)[1]).toMatch(/^ ◐ proving · 1m 00s +\S.* · ctx 5%$/u);
    vi.advanceTimersByTime(40_000);
    expect(rows(120)[1]).toMatch(/^ ◐ proving · 1m 40s +\S.* · ctx 5%$/u);
    expect(renders()).toBe(101);
  } finally {
    view.dispose();
    vi.useRealTimers();
  }
});

it("times each operation from the gate's start, keeps tally updates continuous, and stops outside verification", () => {
  vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval", "Date"] });
  const progress = new GateProgress();
  progress.publish({ step: "testing", startedAt: 0, tally: { proved: 1, notProved: 0 } });
  const { view, rows, renders } = footer(progress);
  try {
    vi.advanceTimersByTime(65_000);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    expect(rows(120)[1]).toContain("◐ testing… · 1m 05s");
    progress.publish({ step: "testing", startedAt: 0, tally: { proved: 2, notProved: 0 } });
    expect(rows(120)[1]).toContain("◐ testing… · 1m 05s · 2 proved");
    progress.publish({ step: "proving", path: "src/first.ts", startedAt: performance.now(), tally: { proved: 2, notProved: 0 } });
    vi.advanceTimersByTime(3_000);
    expect(rows(120)[1]).toContain("◐ proving · 3s");
    progress.publish({ step: "proving", path: "src/second.ts", startedAt: performance.now(), tally: { proved: 3, notProved: 0 } });
    expect(rows(120)[1]).toContain("◐ proving · 0s");
    progress.publish({ step: "measuring", startedAt: performance.now(), tally: { proved: 3, notProved: 0 } });
    vi.advanceTimersByTime(61_000);
    expect(rows(120)[1]).toContain("◐ measuring contracts… · 1m 01s");
    for (const status of [
      { step: "sent_back", tally: { proved: 3, notProved: 0, weak: 1 } },
      { step: "settled", receipt: emptyReceipt },
      { step: "ready", readiness: "tests_only" },
    ] as const) {
      progress.publish(status);
      const count = renders();
      vi.advanceTimersByTime(2_000);
      expect(renders()).toBe(count);
      expect(rows(120)[1]).not.toMatch(/\d+s/u);
    }
    progress.publish({ step: "testing", startedAt: performance.now(), tally: { proved: 0, notProved: 0 } });
    const count = renders();
    view.dispose();
    vi.advanceTimersByTime(2_000);
    expect(renders()).toBe(count);
  } finally {
    view.dispose();
    vi.useRealTimers();
  }
});

it("keeps the step and its time at a width that fits, and drops time before the step name, whatever the file (#590)", () => {
  vi.useFakeTimers({ toFake: ["performance", "setInterval", "clearInterval"] });
  const progress = new GateProgress();
  progress.publish({ step: "proving", path: `api/${"very-long-folder/".repeat(12)}rules.ts`, startedAt: 0,
    tally: { proved: 0, notProved: 0 } });
  const { view, rows } = footer(progress);
  try {
    vi.advanceTimersByTime(100_000);
    expect(rows(80)[1]).toContain("◐ proving · 1m 40s");
    expect(rows(30)[1]).toMatch(/^ ◐ proving · 1m 40s +ctx 5%$/u);
    expect(rows(22)[1]).toMatch(/^ ◐ proving +ctx 5%$/u);
    for (const width of [120, 80, 60, 40, 30, 20, 12, 2, 1]) {
      for (const row of rows(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  } finally {
    view.dispose();
    vi.useRealTimers();
  }
});

it("shows the evidence in one row, with the folder, the model and the context % at the far right", () => {
  const progress = new GateProgress();
  progress.ready("proofs_and_tests");
  const { rows } = footer(progress);
  const wide = rows(120);
  expect(wide[0]).toBe("");
  expect(wide[1]?.startsWith(" ● ready · proofs and tests ")).toBe(true);
  expect(wide[1]?.endsWith(` ${join("/srv", "parse-range")} (feat/range) · gpt-5.5 medium · ctx 5%`)).toBe(true);
  expect(visibleWidth(wide[1] ?? "")).toBe(119);
  expect(wide).toHaveLength(2);
  for (const width of [200, 120, 80, 60, 30, 12]) for (const row of footer(progress).view.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  // No "Tesota" in the footer: the header carries the name.
  expect(rows(120).join("\n")).not.toContain("Tesota");
});

it("follows the gate as it publishes, and stops when disposed", () => {
  const progress = new GateProgress();
  const { view, renders, rows } = footer(progress);
  progress.publish({ step: "proving", path: "src/clamp.ts", startedAt: performance.now(), tally: { proved: 1, notProved: 0 } });
  expect(renders()).toBe(1);
  expect(rows(120)[1]).toMatch(/^ ◐ proving · 0s · 1 proved +\S.* · ctx 5%$/u);
  view.dispose();
  progress.reset();
  expect(renders()).toBe(1);
});

it("narrows at 80 and 30 columns in the order the rule sets", () => {
  const progress = new GateProgress();
  progress.publish({ step: "settled", receipt: { ...emptyReceipt, proofs: [proved], tests: [passing], contracts: [strong],
    uncovered: [{ path: "src/parse.ts", lines: [[12, 14]] }] } });
  const { rows } = footer(progress);
  expect(rows(80)[1]).toMatch(/^ ○ receipt · 1 proved · tests ✓ · 3 lines unproved +ctx 5%$/u);
  expect(rows(80)[1]).not.toContain("gpt-5.5");
  expect(rows(80)[1]).not.toContain("parse-range");
  expect(rows(40)[1]).toMatch(/^ ○ · ✓1 · tests ✓ · ○3 +ctx 5%$/u);
  // Too narrow for even the glyphs beside it, the context % goes, and the evidence is cut.
  expect(rows(25)[1]).toBe(" ○ · ✓1 · tests ✓ · ○3");
});

it("ends the row with the other extensions' statuses at every width, and colors a full context window", () => {
  const progress = new GateProgress();
  const { rows } = footer(progress, { tesota: "Tesota", zeta: "Z on", alpha: "A\non" });
  expect(rows(120)[1]?.endsWith("ctx 5% · A on · Z on")).toBe(true);
  expect(rows(120)).toHaveLength(2);
  // The permission mode is one of them: narrowing drops the folder, the model and the context %, never the mode.
  const mode = footer(progress, { permissions: "full access" }).rows;
  for (const width of [120, 60, 40, 30]) expect(mode(width)[1]).toContain("full access");
  const full = footer(progress, {}, { tokens: 260_000, contextWindow: 272_000, percent: 95.6 }).view.render(120)[1] ?? "";
  expect(full).toContain(theme.fg("error", "ctx 96%"));
});

it("sums up a folder of repositories as one receipt, with the folders in none", () => {
  const units: Receipt = { ...emptyReceipt, units: [{ ...emptyReceipt, folder: "api", proofs: [proved], tests: [passing] },
    { ...emptyReceipt, folder: "notes", repository: false }] };
  expect(words({ step: "settled", receipt: units })).toBe("! receipt · 1 proved · tests pass · 1 folder not verified, no Git");
});

it("sums up a folder Tesota snapshotted as a receipt like a repository's, and one it could not as not verified", () => {
  const snapshotted: Receipt = { ...emptyReceipt, repository: false, snapshot: true, proofs: [proved], tests: [passing] };
  expect(words({ step: "settled", receipt: snapshotted })).toBe("✓ receipt · 1 proved · tests pass");
  expect(words({ step: "settled", receipt: { ...emptyReceipt, repository: false, reason: "it holds too much" } }))
    .toBe("! receipt · not verified, no Git repository");
});
