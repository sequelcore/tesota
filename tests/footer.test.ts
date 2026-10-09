import { join, sep } from "node:path";
import type { ContextUsage, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import { EvidenceFooter, evidenceParts, evidenceText, homeRelative } from "../src/footer.js";
import { GateProgress, type GateStatus } from "../src/gate.js";
import type { Receipt } from "../src/receipt.js";
import { footerLayout, readiness } from "../src/verification/footer-rule.js";
import { loadThemes, themeIn } from "./pi-themes.js";
import { emptyReceipt } from "./receipts.js";

let theme: Theme;
beforeAll(async () => { theme = themeIn(await loadThemes(), "tesota-dark"); }, 30_000);

function evidence(outcome: Evidence["outcome"]): Evidence {
  return { verifier: "lemmascript", claim: "", limits: "", outcome, output: "", durationMs: 1, files: [], contentHash: "h" };
}

const proved = { path: "src/clamp.ts", verdict: "proved", evidence: evidence("passed") } as const;
const passing = { command: "bun test", evidence: evidence("passed"), verdict: "proved" } as const;
const strong = { path: "src/clamp.ts", name: "clamp", lines: [],
  mutation: { rejected: 6, survived: [], equivalent: 0, inconclusive: 0 } };

function words(status: GateStatus, level: "full" | "short" | "glyphs" = "full"): string {
  return evidenceText(evidenceParts(status), level);
}

it("says what Tesota can verify before any request", () => {
  expect(words({ step: "ready", readiness: readiness(true, true) })).toBe("● ready · proofs and tests");
  expect(words({ step: "ready", readiness: readiness(false, true) })).toBe("● ready · tests only");
  expect(words({ step: "ready", readiness: readiness(true, false) })).toBe("● ready · proofs only");
  expect(words({ step: "ready", readiness: readiness(false, false) })).toBe("● ready · nothing to check with");
  // With nothing to check with, the whole row is in gold.
  expect(evidenceParts({ step: "ready", readiness: "nothing" }).map(({ color }) => color)).toEqual(["warning", "warning"]);
});

it("names the gate's step and what its round found so far", () => {
  expect(words({ step: "proving", tally: { proved: 0, notProved: 0 } })).toBe("◐ proving…");
  expect(words({ step: "testing", tally: { proved: 2, notProved: 0 } })).toBe("◐ testing… · 2 proved");
  expect(words({ step: "measuring", tally: { proved: 1, notProved: 0, tests: "pass" } }))
    .toBe("◐ measuring contracts… · 1 proved · tests pass");
  expect(words({ step: "sent_back", tally: { proved: 1, notProved: 1, tests: "fail", weak: 2 } }))
    .toBe("↺ sent back · 1 proved · 1 not proved · tests fail · 2 weak contracts");
  expect(words({ step: "sent_back", tally: { proved: 1, notProved: 0, tests: "pass", weak: 1 } }, "glyphs"))
    .toBe("↺ · ✓1 · tests ✓ · weak 1");
});

it("sums up the receipt, leading with whether anything in it needs the operator", () => {
  const clean: Receipt = { ...emptyReceipt, proofs: [proved], tests: [passing], contracts: [strong],
    uncovered: [{ path: "src/parse.ts", lines: [[12, 14]] }] };
  expect(words({ step: "settled", receipt: clean })).toBe("✓ receipt · 1 proved · tests pass · contracts strong · 3 lines not proved");
  expect(words({ step: "settled", receipt: clean }, "short")).toBe("✓ receipt · 1 proved · tests ✓ · 3 lines unproved");
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

it("drops the model first, then shortens the evidence, and drops the context % last", () => {
  // Widths: evidence 40, 30 or 10; context 6; path 40; model 15.
  expect(footerLayout(100, 40, 30, 10, 6, 40, 15)).toEqual({ level: "full", context: true, model: true });
  expect(footerLayout(56, 40, 30, 10, 6, 40, 15)).toEqual({ level: "full", context: true, model: false });
  expect(footerLayout(47, 40, 30, 10, 6, 40, 15)).toEqual({ level: "short", context: true, model: false });
  expect(footerLayout(20, 40, 30, 10, 6, 40, 15)).toEqual({ level: "glyphs", context: true, model: false });
  expect(footerLayout(17, 40, 30, 10, 6, 40, 15)).toEqual({ level: "glyphs", context: false, model: false });
});

it("writes the folder from home as Pi's footer does", () => {
  expect(homeRelative(join("/home", "ana", "work"), join("/home", "ana"))).toBe(`~${sep}work`);
  expect(homeRelative(join("/home", "ana"), join("/home", "ana"))).toBe("~");
  expect(homeRelative(join("/home", "anabel"), join("/home", "ana"))).toBe(join("/home", "anabel"));
  expect(homeRelative(join("/srv", "work"), "")).toBe(join("/srv", "work"));
});

function data(statuses: Record<string, string> = {}): ReadonlyFooterDataProvider & { branchChanged: () => void } {
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

it("shows the evidence over the folder, with the context % and the model at the far right", () => {
  const progress = new GateProgress();
  progress.ready("proofs_and_tests");
  const { rows } = footer(progress);
  const wide = rows(120);
  expect(wide[0]).toBe("");
  expect(wide[1]).toMatch(/^ ● ready · proofs and tests +ctx 5%$/u);
  expect(wide[2]?.startsWith(` ${join("/srv", "parse-range")} (feat/range) `)).toBe(true);
  expect(wide[2]?.endsWith(" gpt-5.5 medium")).toBe(true);
  expect(visibleWidth(wide[2] ?? "")).toBe(119);
  expect(wide).toHaveLength(3);
  for (const width of [200, 120, 80, 60, 30, 12]) for (const row of footer(progress).view.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  // No "Tesota" in the footer: the header carries the name.
  expect(rows(120).join("\n")).not.toContain("Tesota");
});

it("follows the gate as it publishes, and stops when disposed", () => {
  const progress = new GateProgress();
  const { view, renders, rows } = footer(progress);
  progress.publish({ step: "proving", tally: { proved: 1, notProved: 0 } });
  expect(renders()).toBe(1);
  expect(rows(120)[1]).toMatch(/^ ◐ proving… · 1 proved +ctx 5%$/u);
  view.dispose();
  progress.reset();
  expect(renders()).toBe(1);
});

it("narrows at 80 and 30 columns in the order the rule sets", () => {
  const progress = new GateProgress();
  progress.publish({ step: "settled", receipt: { ...emptyReceipt, proofs: [proved], tests: [passing], contracts: [strong],
    uncovered: [{ path: "src/parse.ts", lines: [[12, 14]] }] } });
  const { rows } = footer(progress);
  expect(rows(80)[1]).toMatch(/^ ✓ receipt · 1 proved · tests ✓ · 3 lines unproved +ctx 5%$/u);
  expect(rows(80)[2]).not.toContain("gpt-5.5");
  expect(rows(40)[1]).toMatch(/^ ✓ · ✓1 · tests ✓ · ⚠3 +ctx 5%$/u);
  // Too narrow for even the glyphs beside it, the context % goes, and the evidence is cut.
  expect(rows(25)[1]).toBe(" ✓ · ✓1 · tests ✓ · ⚠3");
});

it("keeps other extensions' statuses on a third row, and colors a full context window", () => {
  const progress = new GateProgress();
  const { rows } = footer(progress, { tesota: "Tesota", zeta: "Z on", alpha: "A\non" });
  expect(rows(120)[3]).toBe(" A on Z on");
  const full = footer(progress, {}, { tokens: 260_000, contextWindow: 272_000, percent: 95.6 }).view.render(120)[1] ?? "";
  expect(full).toContain(theme.fg("error", "ctx 96%"));
});
