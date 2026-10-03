import { expect, it } from "vitest";
import { correctionFor, correctionPrompt } from "../src/correction.js";
import { hostProvider } from "../src/host-environment.js";
import type { Finding, ReviewReport } from "../src/review.js";
import type { CheckResult } from "../src/workspace-checks.js";

const tree = "t".repeat(40);
/** A check; a failing command's base passed, so the failure comes with the candidate, unless `base` says otherwise. */
function check(outcome: CheckResult["outcome"], command = "bun run check",
  base: NonNullable<CheckResult["base"]> = { outcome: "passed", exitCode: 0, origin: "introduced" }): CheckResult {
  const failing = outcome === "failed" || outcome === "timed_out";
  return { ...failing ? { base } : {}, verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree, environment: "host", guarantees: hostProvider.guarantees, outcome,
    exitCode: outcome === "failed" ? 1 : outcome === "passed" ? 0 : null, durationMs: 1,
    output: outcome === "failed" ? "FAIL price.test.ts\nexpected 90" : "" };
}
const review: ReviewReport = { reviewer: "Tesota reviewer", tree, status: "completed", summary: "Two problems.", findings: [
  { severity: "high", disposition: "fixable", origin: "introduced" as const, standing: "confirmed", path: "src/price.ts", line: 3,
    statement: "Exactly $100 is discounted",
    reason: "The request says over $100" },
  { severity: "medium", disposition: "operator", origin: "introduced" as const, statement: "Rounding is unspecified", reason: "Cents or dollars?" },
] };

it("sends back failed checks and fixable findings, and keeps the operator's calls with the operator", () => {
  expect(correctionFor([check("failed"), check("passed", "lint"), check("not_started", "e2e")], [review])).toEqual({
    failedChecks: [check("failed")], findings: [review.findings[0]], obligations: [] });
  expect(correctionFor([check("timed_out")], [])).toEqual({ failedChecks: [check("timed_out")], findings: [], obligations: [] });
});

it("keeps with the operator a check failure the base shares or that could not be compared with it", () => {
  expect(correctionFor([check("failed", "bun run check", { outcome: "failed", exitCode: 1, origin: "preexisting" })], [])).toBeUndefined();
  expect(correctionFor([check("timed_out", "bun run check", { outcome: "not_started", exitCode: null, origin: "unknown" })], []))
    .toBeUndefined();
  const { base: _base, ...uncompared } = check("failed");
  expect(correctionFor([uncompared], [])).toBeUndefined();
  // Oxlint and LemmaScript judge only the candidate's changed files, so their failures always come with it.
  const lint: CheckResult = { ...uncompared, verifier: "oxlint", command: "Tesota's Oxlint profile" };
  expect(correctionFor([lint], [])?.failedChecks).toEqual([lint]);
});

it("sends back a check the base fails too when some of its tests fail only with the changes, naming them", () => {
  const introducedTests = Array.from({ length: 12 }, (_, index) => `tests/price.test.ts > case ${String(index).padStart(2, "0")}`);
  const failing = check("failed", "bun run check", { outcome: "failed", exitCode: 1, origin: "introduced", introducedTests });
  const round = correctionFor([failing], []);
  expect(round?.failedChecks).toEqual([failing]);
  if (round === undefined) throw new Error("Nothing sent back");
  const prompt = correctionPrompt(["Fix pricing"], round);
  expect(prompt).toContain("It also fails without your changes; these tests fail only with them: " +
    "tests/price.test.ts > case 00; tests/price.test.ts > case 01;");
  expect(prompt).toContain("tests/price.test.ts > case 09; and 2 more");
  expect(prompt).not.toContain("case 10");
});

it("sends back only findings that survived refutation", () => {
  for (const standing of ["refuted", "unsettled", undefined] as const) {
    const { standing: _confirmed, ...untested } = review.findings[0]!;
    const finding = standing === undefined ? untested : { ...untested, standing };
    expect(correctionFor([check("passed")], [{ ...review, findings: [finding] }])).toBeUndefined();
  }
});

it("sends a problem back once, however many reviewers reported it", () => {
  const repeated: ReviewReport = { ...review, findings: [review.findings[0]!, { ...review.findings[0]!, duplicateOf: "Tesota reviewer: A" }] };
  expect(correctionFor([check("passed")], [repeated])?.findings).toHaveLength(1);
});

it("never sends back a problem the candidate did not introduce, or one whose cause is unknown", () => {
  const old: ReviewReport = { ...review, findings: [{ ...review.findings[0]!, origin: "preexisting" }] };
  expect(correctionFor([check("passed")], [old])).toBeUndefined();
  const unclear: ReviewReport = { ...review, findings: [{ ...review.findings[0]!, origin: "unknown" }] };
  expect(correctionFor([check("passed")], [unclear])).toBeUndefined();
});

const low: Finding = { severity: "low", disposition: "fixable", origin: "introduced", standing: "confirmed", path: "src/price.ts",
  line: 5, statement: "A comment is stale", reason: "It describes the old rule" };
const medium: Finding = { ...low, severity: "medium", statement: "Cents are dropped" };

it("starts no round for a review whose only items for the agent are low-severity findings (#254)", () => {
  expect(correctionFor([check("passed")], [{ ...review, findings: [low] }])).toBeUndefined();
});

it("sends a low finding back with a medium one", () => {
  expect(correctionFor([check("passed")], [{ ...review, findings: [low, medium] }])?.findings).toEqual([low, medium]);
});

it("sends a low finding back with a failed check", () => {
  expect(correctionFor([check("failed")], [{ ...review, findings: [low] }])).toEqual({
    failedChecks: [check("failed")], findings: [low], obligations: [] });
});

it("asks for no correction when only the operator can settle what is left", () => {
  const operatorOnly: ReviewReport = { ...review, findings: [review.findings[1]!] };
  const incomplete: ReviewReport = { reviewer: "Tesota reviewer", tree, status: "incomplete", reason: "stopped" };
  expect(correctionFor([check("passed"), check("changed_files", "format"), check("unconfirmed", "e2e")],
    [operatorOnly, incomplete])).toBeUndefined();
});

it("repeats the user's requests unchanged and gives each problem with its evidence", () => {
  const prompt = correctionPrompt(["Give orders over $100 a 10% discount"],
    { failedChecks: [check("failed")], findings: [review.findings[0]!], obligations: [] });
  expect(prompt).toContain("(not written by the user)");
  expect(prompt).toContain("The user's requests, unchanged:\n1. Give orders over $100 a 10% discount\n");
  expect(prompt).toContain("- The check `bun run check` failed (exit 1).\n  Last output:\n    FAIL price.test.ts\n    expected 90");
  expect(prompt).toContain("- [high] src/price.ts:3: Exactly $100 is discounted\n  Why: The request says over $100");
  expect(prompt).toContain("Do not weaken, skip or delete tests or checks to make them pass.");
  expect(prompt).not.toContain("Rounding");
});
