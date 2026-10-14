/**
 * Whether a line holds only a comment, as a grammar reads its file: the file
 * parsed without error (`parsed`), and the line has a non-blank character
 * and each of its non-blank characters lies inside a comment. `blank[i]` and
 * `inComment[i]` describe the line's i-th character. A file that did not
 * parse has no comment-only line, so a change to it counts as code.
 */
//@ requires blank.length === inComment.length
//@ ensures \result <==> (parsed && exists(i: nat, i < blank.length && !blank[i]) && forall(i: nat, i < blank.length && !blank[i] ==> inComment[i]))
export function commentOnly(parsed: boolean, blank: readonly boolean[], inComment: readonly boolean[]): boolean {
  if (!parsed) return false;
  let written = false;
  let k = 0;
  while (k < blank.length) {
    //@ invariant 0 <= k && k <= blank.length
    //@ invariant written <==> exists(i: nat, i < k && !blank[i])
    //@ invariant forall(i: nat, i < k && !blank[i] ==> inComment[i])
    if (!blank[k]) {
      if (!inComment[k]) return false;
      written = true;
    }
    k = k + 1;
  }
  return written;
}
