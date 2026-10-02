/**
 * Decision 034's rule for the answer check's first pass. The full check of a
 * turn that changed no files is skipped only when the first pass decided, and
 * decided that nothing in the turn is checkable; a first pass that failed,
 * timed out or never decided runs the full check, so a broken or slow first
 * pass can never let a claimed but missing change through.
 */
//@ ensures \result <==> !(decided && !checkable)
export function runsAnswerCheck(decided: boolean, checkable: boolean): boolean {
  if (!decided) return true;
  return checkable;
}

export type TriageOutcome = "checked" | "skipped" | "undecided";

/**
 * What the first pass's verdict says in the conversation, which the operator
 * always sees: the answer goes to the full check, the full check is skipped,
 * or the first pass could not decide and the full check runs. It says
 * "skipped" exactly when the full check does not run, so the line never
 * claims a check that did not happen, nor hides one that was skipped.
 */
//@ ensures (\result === "skipped") <==> !runsAnswerCheck(decided, checkable)
//@ ensures !decided ==> \result === "undecided"
//@ ensures decided && checkable ==> \result === "checked"
export function triageOutcome(decided: boolean, checkable: boolean): TriageOutcome {
  if (!decided) return "undecided";
  return checkable ? "checked" : "skipped";
}

/**
 * The first pass's two questions as one decision: a turn is checkable when
 * its requests ask for more than conversation, whatever the reply says, or
 * when its reply states something checkable; it is skipped only when neither
 * holds, so the agent's wording alone can never skip a request.
 */
//@ ensures \result <==> (requestsCheckable || replyCheckable)
export function turnCheckable(requestsCheckable: boolean, replyCheckable: boolean): boolean {
  if (requestsCheckable) return true;
  return replyCheckable;
}
