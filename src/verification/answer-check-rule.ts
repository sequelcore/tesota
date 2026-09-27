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
