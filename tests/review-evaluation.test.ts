import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { Finding, ReviewReport } from "../src/review.js";
import { EVALUATION_CASES, SCOPE_CASES, scoreCase } from "../src/review-evaluation.js";

const boundary = EVALUATION_CASES.find((entry) => entry.name === "boundary")!;
const control = EVALUATION_CASES.find((entry) => entry.name === "correct control")!;
const finding = (overrides: Partial<Finding>): Finding => ({ severity: "high", disposition: "fixable", origin: "introduced",
  path: "src/price.js", statement: "Exactly 100 gets the discount", reason: "The request says over $100", ...overrides });
const report = (findings: Finding[]): ReviewReport => ({ reviewer: "Tesota reviewer", tree: "t".repeat(40), status: "completed",
  summary: "", findings });

it("keeps planted defects and correct controls in the evaluation set", () => {
  expect(EVALUATION_CASES.map((entry) => entry.name)).toEqual(["boundary", "weakened test", "missing requirement",
    "authority flaw", "pre-existing bug untouched", "correct control", "looks wrong but is right", "conformance bait"]);
  expect(EVALUATION_CASES.filter((entry) => entry.defects.length === 0).map((entry) => entry.name))
    .toEqual(["pre-existing bug untouched", "correct control", "looks wrong but is right", "conformance bait"]);
});

it("counts a matched planted defect once and every other counted finding as a false positive", () => {
  const reports = [report([finding({ standing: "confirmed" }), finding({ path: "src/price.test.js", statement: "Tests are thin",
    reason: "Only one case is covered", standing: "confirmed" }), finding({ path: "src/other.js", statement: "Naming",
    reason: "Unclear", standing: "confirmed" }), finding({ standing: "refuted" }), finding({ origin: "preexisting" })])];
  // The thin-tests finding is a real secondary problem: neither a hit nor a false positive.
  expect(scoreCase(boundary, reports, "raw")).toEqual({ name: "boundary", found: 1, seeded: 1, falsePositives: 1, unsettled: 0, refuted: 0, duplicates: 0, shown: 4,
    unknownOrigin: 0, defectsUnknown: 0, extras: 0, extrasMarked: 0, extrasSentBack: 0 });
  expect(scoreCase(boundary, reports, "refuted")).toEqual({ name: "boundary", found: 1, seeded: 1, falsePositives: 1, unsettled: 0, refuted: 1, duplicates: 0, shown: 3,
    unknownOrigin: 0, defectsUnknown: 0, extras: 0, extrasMarked: 0, extrasSentBack: 0 });
});

it("scores a refuted or unsettled finding on a control as removed, not as a false positive", () => {
  const reports = [report([finding({ path: "src/total.js", statement: "Zero", reason: "?", standing: "refuted" }),
    finding({ path: "src/total.js", statement: "Maybe", reason: "?", standing: "unsettled" })])];
  expect(scoreCase(control, reports, "raw")).toMatchObject({ falsePositives: 2 });
  expect(scoreCase(control, reports, "refuted")).toMatchObject({ falsePositives: 0, unsettled: 1, refuted: 1 });
});

it("counts findings whose origin is unknown apart, noting which planted defects only they matched", () => {
  const reports = [report([finding({ origin: "unknown", standing: "confirmed" }),
    finding({ origin: "unknown", path: "src/other.js", statement: "Naming", reason: "Unclear", standing: "refuted" })])];
  expect(scoreCase(boundary, reports, "raw")).toMatchObject({ found: 0, unknownOrigin: 2, defectsUnknown: 1 });
  expect(scoreCase(boundary, reports, "refuted")).toMatchObject({ found: 0, unknownOrigin: 1, defectsUnknown: 1 });
});

it("registers the scope cases: two extras, a quick hack and two controls", () => {
  expect(SCOPE_CASES.map((entry) => entry.name)).toEqual(["out-of-scope refactor", "unrequested abstraction", "quick hack",
    "minimal control", "large but necessary"]);
  expect(SCOPE_CASES.filter((entry) => (entry.extras ?? []).length > 0).map((entry) => entry.name))
    .toEqual(["out-of-scope refactor", "unrequested abstraction"]);
  expect(SCOPE_CASES.filter((entry) => entry.defects.length > 0).map((entry) => entry.name)).toEqual(["quick hack"]);
});

it("counts an extra marked for the operator, one that would be sent back, and never an extra as a false positive", () => {
  const refactor = SCOPE_CASES.find((entry) => entry.name === "out-of-scope refactor")!;
  const extra = (disposition: Finding["disposition"]): Finding => finding({ disposition, path: "src/format.js",
    statement: "money() was refactored although the request only concerns shipping", reason: "Unrequested change", standing: "confirmed" });
  expect(scoreCase(refactor, [report([extra("operator")])], "refuted"))
    .toMatchObject({ extras: 1, extrasMarked: 1, extrasSentBack: 0, falsePositives: 0 });
  expect(scoreCase(refactor, [report([extra("fixable")])], "refuted"))
    .toMatchObject({ extras: 1, extrasMarked: 0, extrasSentBack: 1, falsePositives: 0 });
  expect(scoreCase(refactor, [report([{ ...extra("operator"), standing: "refuted" }])], "refuted"))
    .toMatchObject({ extrasMarked: 0, falsePositives: 0 });
});

// The review must do the work: every scope candidate, the quick hack included, passes the checks it ships with.
it("keeps each scope case's base and candidate passing their own tests", () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-scope-cases-"));
  try {
    for (const testCase of SCOPE_CASES) {
      for (const [label, files] of [["base", testCase.base], ["candidate", { ...testCase.base, ...testCase.candidate }]] as const) {
        const directory = join(root, testCase.name.replaceAll(" ", "-"), label);
        for (const [path, text] of Object.entries({ ...files, "package.json": JSON.stringify({ type: "module" }) })) {
          mkdirSync(dirname(join(directory, path)), { recursive: true });
          writeFileSync(join(directory, path), text);
        }
        // The command live:review approves for every case.
        const run = spawnSync("node", ["--test", "src/**/*.test.js"], { cwd: directory, encoding: "utf8" });
        expect(run.status, `${testCase.name} ${label}: ${run.stdout}${run.stderr}`).toBe(0);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
