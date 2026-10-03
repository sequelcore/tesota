/**
 * Who acts on one item of a review (decision 041): the working agent, which
 * Tesota sends it back to; the operator, whose decision it needs; or no one,
 * when it is context. What goes back to the agent and how the review shows
 * each item both come from these rules, so the two never disagree.
 */
export type ReviewAction = "agent" | "operator" | "context";

export type ActionOrigin = "introduced" | "preexisting" | "unknown";
export type ActionDisposition = "fixable" | "operator";
/** How a finding stood against the second check; `untested` before it ran. */
export type ActionStanding = "confirmed" | "refuted" | "unsettled" | "untested";

/**
 * A finding goes to the agent only when this change caused it, the agent can
 * fix it and the second check confirmed it; a repeat, a finding the second
 * check ruled out and a problem that was already there are context; anything
 * else, such as an unconfirmed finding, an unclear cause or a trade-off, needs
 * the operator.
 */
//@ ensures \result === "agent" <==> !duplicate && standing === "confirmed" && origin === "introduced" && disposition === "fixable"
//@ ensures \result === "context" <==> duplicate || standing === "refuted" || origin === "preexisting"
export function findingAction(origin: ActionOrigin, disposition: ActionDisposition, standing: ActionStanding,
  duplicate: boolean): ReviewAction {
  if (duplicate || standing === "refuted" || origin === "preexisting") return "context";
  if (standing === "confirmed" && origin === "introduced" && disposition === "fixable") return "agent";
  return "operator";
}

export type ActionVerifier = "command" | "oxlint" | "lemmascript";
export type ActionOutcome = "passed" | "failed" | "timed_out" | "cancelled" | "not_started" | "unconfirmed" | "changed_files";
/** A failed command's origin from its run on the base (decisions 039 and 040); `absent` when it has none. */
export type ActionCheckOrigin = "introduced" | "preexisting" | "unknown" | "absent";

/**
 * A failed or timed-out check goes to the agent when the change caused it: a
 * command when its origin is introduced, and Oxlint and LemmaScript, which
 * judge only the changed files, always. A command that fails the same way
 * without the changes is context; one whose cause is unknown, and a check
 * that could not run or changed files, needs the operator.
 */
//@ ensures outcome === "passed" ==> \result === "context"
//@ ensures \result === "agent" <==> (outcome === "failed" || outcome === "timed_out") && (verifier !== "command" || origin === "introduced")
//@ ensures \result === "context" <==> outcome === "passed" || ((outcome === "failed" || outcome === "timed_out") && verifier === "command" && origin === "preexisting")
export function checkAction(verifier: ActionVerifier, outcome: ActionOutcome, origin: ActionCheckOrigin): ReviewAction {
  if (outcome === "passed") return "context";
  if (outcome !== "failed" && outcome !== "timed_out") return "operator";
  if (verifier !== "command" || origin === "introduced") return "agent";
  if (origin === "preexisting") return "context";
  return "operator";
}

/**
 * Whether a correction round starts: a failed check the change caused, an obligation that did not hold, or a
 * finding of medium severity or higher that is for the agent. Findings of low severity alone never start one (#254).
 */
//@ ensures \result === (failedCheck || unmetObligation || significantFinding)
export function roundStarts(failedCheck: boolean, unmetObligation: boolean, significantFinding: boolean): boolean {
  return failedCheck || unmetObligation || significantFinding;
}

/**
 * Who acts on a finding once its severity counts (#254): a low-severity finding that `findingAction` sends to the
 * agent goes only with a round that starts for another reason, and otherwise to the operator, who can send it back.
 * Severity changes nothing else.
 */
//@ ensures \result === "agent" <==> action === "agent" && (!low || roundIsStarting)
//@ ensures \result === "operator" <==> action === "operator" || (action === "agent" && low && !roundIsStarting)
//@ ensures \result === "context" <==> action === "context"
export function severityAction(action: ReviewAction, low: boolean, roundIsStarting: boolean): ReviewAction {
  return action === "agent" && low && !roundIsStarting ? "operator" : action;
}

export type ActionObligation = "held" | "not_held" | "uncertain";

export type ObligationDisposition = "fixable" | "operator";

/**
 * A request or plan step the second check confirmed is not done goes to the agent only when the agent can satisfy
 * it within the request; one it cannot, as when a check fails on the base for a reason outside the change, and an
 * unclear one need the operator (#224).
 */
//@ ensures \result === "agent" <==> (outcome === "not_held" && disposition === "fixable")
//@ ensures \result === "operator" <==> (outcome === "uncertain" || outcome === "not_held" && disposition === "operator")
//@ ensures \result === "context" <==> outcome === "held"
export function obligationAction(outcome: ActionObligation, disposition: ObligationDisposition): ReviewAction {
  if (outcome === "not_held") return disposition === "fixable" ? "agent" : "operator";
  if (outcome === "uncertain") return "operator";
  return "context";
}
