import type { Finding, Obligation } from "./review.js";
import { obligationOutcome } from "./verification/obligation-outcome.js";
import { checkAction, findingAction, obligationAction, type ReviewAction } from "./verification/review-action-rule.js";
import type { CheckResult } from "./workspace-checks.js";

/** Who acts on a finding (decision 041): what goes back to the agent and where the review shows it. */
export function actionOfFinding(finding: Finding): ReviewAction {
  return findingAction(finding.origin, finding.disposition, finding.standing ?? "untested", finding.duplicateOf !== undefined);
}

/** Who acts on a check's result (decision 041). */
export function actionOfCheck(check: CheckResult): ReviewAction {
  return checkAction(check.verifier, check.outcome, check.base?.origin ?? "absent");
}

/** Who acts on a request or plan step the review judged (decision 041). */
export function actionOfObligation(obligation: Obligation): ReviewAction {
  return obligationAction(obligationOutcome(obligation.status, obligation.standing ?? "untested"), obligation.disposition ?? "fixable");
}
