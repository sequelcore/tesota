/**
 * What one finding of a receipt asks of the operator: a decision before
 * accepting the change (`decide`), such as a proof or command that still
 * fails, a weak contract, a change that may weaken the evidence or a test
 * that passes without the change; a gap to know about (`gap`), such as lines
 * no proof covers; evidence that holds (`holds`); or a model's opinion
 * (`opinion`), which is a candidate and never evidence (#375).
 */
export type Standing = "decide" | "gap" | "holds" | "opinion";

/**
 * How many findings need the operator: only those the checks established,
 * so a model's opinion never counts, however it reads. The receipt is clean
 * when none does.
 */
//@ ensures 0 <= \result && \result <= standings.length
//@ ensures \result === 0 <==> !exists(k: nat, k < standings.length && standings[k] === "decide")
export function decisions(standings: readonly Standing[]): number {
  let count = 0;
  let k = 0;
  while (k < standings.length) {
    //@ invariant 0 <= k && k <= standings.length
    //@ invariant 0 <= count && count <= k
    //@ invariant count === 0 <==> !exists(j: nat, j < k && standings[j] === "decide")
    if (standings[k] === "decide") count = count + 1;
    k = k + 1;
  }
  return count;
}
