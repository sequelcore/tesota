import type { Finding, Obligation, ReviewReport } from "./review.js";
import { obligationOutcome } from "./verification/obligation-outcome.js";
import { checkAction, findingAction, obligationAction, roundStarts, severityAction, type ReviewAction } from "./verification/review-action-rule.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * Who acts on a finding (decision 041): what goes back to the agent and where the review shows it. A low-severity
 * finding for the agent goes back only with a round that starts for another reason (`roundIsStarting`), else to the
 * operator (#254).
 */
export function actionOfFinding(finding: Finding, roundIsStarting = true): ReviewAction {
  return severityAction(findingAction(finding.origin, finding.disposition, finding.standing ?? "untested",
    finding.duplicateOf !== undefined), finding.severity === "low", roundIsStarting);
}

/** Whether these checks and reviews start a correction round: low-severity findings alone do not (#254). */
export function reviewRoundStarts(checks: readonly CheckResult[], reviews: readonly ReviewReport[]): boolean {
  const completed = reviews.flatMap((report) => report.status === "completed" ? [report] : []);
  return roundStarts(checks.some((check) => actionOfCheck(check) === "agent"),
    completed.some((report) => (report.obligations ?? []).some((item) => actionOfObligation(item) === "agent")),
    completed.some((report) => report.findings.some((finding) => finding.severity !== "low" && actionOfFinding(finding) === "agent")));
}

/** Who acts on a check's result (decision 041). */
export function actionOfCheck(check: CheckResult): ReviewAction {
  return checkAction(check.verifier, check.outcome, check.base?.origin ?? "absent");
}

/** Who acts on a request or plan step the review judged (decision 041). */
export function actionOfObligation(obligation: Obligation): ReviewAction {
  return obligationAction(obligationOutcome(obligation.status, obligation.standing ?? "untested"), obligation.disposition ?? "fixable");
}
