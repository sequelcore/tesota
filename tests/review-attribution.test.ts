import { expect, it } from "vitest";
import type { ReviewReport } from "../src/review.js";
import { activityBy, attributed, verifiedBy } from "../src/review-attribution.js";
import { runsAnswerCheck, triageOutcome } from "../src/verification/answer-check-rule.js";

/** Who did what in a review is recorded with each report and shown where each role acts. */
const finding = { severity: "high" as const, disposition: "fixable" as const, origin: "introduced" as const, path: "src/a.ts", statement: "s", reason: "r" };
const untested: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "", findings: [finding] };
const tested: ReviewReport = { ...untested, findings: [{ ...finding, standing: "confirmed" }] };

it("names each report's model, and the refuter only on reports whose findings it tested", () => {
  const [first, second, third] = attributed([untested, tested,
    { reviewer: "ClaimCheck", tree: "t", status: "incomplete", reason: "timed out" }], { reviewer: "codex:sol", refuter: "claude:opus" });
  expect(first).toMatchObject({ model: "codex:sol" });
  expect(first).not.toHaveProperty("refuter");
  expect(second).toMatchObject({ model: "codex:sol", refuter: "claude:opus" });
  expect(third).toMatchObject({ model: "codex:sol", status: "incomplete" });
  // A report that already names its model, as the fix validator's, keeps it.
  expect(attributed([{ ...untested, model: "codex:validator" }], { reviewer: "codex:sol" })[0]).toMatchObject({ model: "codex:validator" });
});

it("words a step with its role and model, and the line naming who verified a review", () => {
  expect(activityBy("Reviewing", "reviewer", "codex:sol")).toBe("Reviewing · reviewer codex:sol");
  expect(activityBy("Reviewing", "reviewer", undefined)).toBe("Reviewing");
  const reports = attributed([tested, untested], { reviewer: "codex:sol", refuter: "claude:opus" });
  expect(verifiedBy(reports)).toBe("Reviewed by codex:sol; findings tested by claude:opus.");
  expect(verifiedBy(attributed([untested], { reviewer: "codex:sol" }))).toBe("Reviewed by codex:sol.");
  // A report recorded before reviews named their models shows nothing rather than a guess.
  expect(verifiedBy([untested])).toBeUndefined();
});

it("says skipped exactly when the full check does not run, as the proved rule says", () => {
  for (const decided of [true, false]) {
    for (const checkable of [true, false]) {
      expect(triageOutcome(decided, checkable) === "skipped").toBe(!runsAnswerCheck(decided, checkable));
    }
  }
  expect(triageOutcome(false, false)).toBe("undecided");
  expect(triageOutcome(true, true)).toBe("checked");
});
