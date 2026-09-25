import { expect, it } from "vitest";
import { correctionFor, correctionPrompt } from "../src/correction.js";
import { hostProvider } from "../src/host-environment.js";
import type { ReviewReport } from "../src/review.js";
import type { CheckResult } from "../src/workspace-checks.js";

const tree = "t".repeat(40);
function check(outcome: CheckResult["outcome"], command = "bun run check"): CheckResult {
  return { verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree, environment: "host", guarantees: hostProvider.guarantees, outcome,
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
    failedChecks: [check("failed")], findings: [review.findings[0]] });
  expect(correctionFor([check("timed_out")], [])).toEqual({ failedChecks: [check("timed_out")], findings: [] });
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

it("never sends back a problem the candidate did not introduce", () => {
  const old: ReviewReport = { ...review, findings: [{ ...review.findings[0]!, origin: "preexisting" }] };
  expect(correctionFor([check("passed")], [old])).toBeUndefined();
});

it("asks for no correction when only the operator can settle what is left", () => {
  const operatorOnly: ReviewReport = { ...review, findings: [review.findings[1]!] };
  const incomplete: ReviewReport = { reviewer: "Tesota reviewer", tree, status: "incomplete", reason: "stopped" };
  expect(correctionFor([check("passed"), check("changed_files", "format"), check("unconfirmed", "e2e")],
    [operatorOnly, incomplete])).toBeUndefined();
});

it("repeats the user's requests unchanged and gives each problem with its evidence", () => {
  const prompt = correctionPrompt(["Give orders over $100 a 10% discount"],
    { failedChecks: [check("failed")], findings: [review.findings[0]!] });
  expect(prompt).toContain("(not written by the user)");
  expect(prompt).toContain("The user's requests, unchanged:\n1. Give orders over $100 a 10% discount\n");
  expect(prompt).toContain("- The check `bun run check` failed (exit 1).\n  Last output:\n    FAIL price.test.ts\n    expected 90");
  expect(prompt).toContain("- [high] src/price.ts:3: Exactly $100 is discounted\n  Why: The request says over $100");
  expect(prompt).toContain("Do not weaken, skip or delete tests or checks to make them pass.");
  expect(prompt).not.toContain("Rounding");
});
