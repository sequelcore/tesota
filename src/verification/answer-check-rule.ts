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
