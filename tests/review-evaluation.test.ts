import { expect, it } from "vitest";
import type { Finding, ReviewReport } from "../src/review.js";
import { EVALUATION_CASES, scoreCase } from "../src/review-evaluation.js";

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
  expect(scoreCase(boundary, reports, "raw")).toEqual({ name: "boundary", found: 1, seeded: 1, falsePositives: 1, unsettled: 0, refuted: 0, duplicates: 0, shown: 4 });
  expect(scoreCase(boundary, reports, "refuted")).toEqual({ name: "boundary", found: 1, seeded: 1, falsePositives: 1, unsettled: 0, refuted: 1, duplicates: 0, shown: 3 });
});

it("scores a refuted or unsettled finding on a control as removed, not as a false positive", () => {
  const reports = [report([finding({ path: "src/total.js", statement: "Zero", reason: "?", standing: "refuted" }),
    finding({ path: "src/total.js", statement: "Maybe", reason: "?", standing: "unsettled" })])];
  expect(scoreCase(control, reports, "raw")).toMatchObject({ falsePositives: 2 });
  expect(scoreCase(control, reports, "refuted")).toMatchObject({ falsePositives: 0, unsettled: 1, refuted: 1 });
});
