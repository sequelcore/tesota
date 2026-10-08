/**
 * Which changed lines a proof covers: a line is proof-covered only when it
 * lies in a function whose contract proved on this tree, and the candidate
 * did not narrow that contract. Function `k` spans lines `starts[k]` to `ends[k]`, both included;
 * `proved[k]` says its file proved, and `narrowed[k]` that the candidate
 * narrowed its contract, which the caller decides. Anything else, a caller or
 * unannotated code included, is left to review.
 */
//@ requires starts.length === ends.length && starts.length === proved.length && starts.length === narrowed.length
//@ ensures \result <==> exists(k: nat, k < starts.length && starts[k] <= line && line <= ends[k] && proved[k] && !narrowed[k])
export function proofCovered(line: number, starts: readonly number[], ends: readonly number[], proved: readonly boolean[],
  narrowed: readonly boolean[]): boolean {
  let k = 0;
  while (k < starts.length) {
    //@ invariant 0 <= k && k <= starts.length
    //@ invariant forall(j: nat, j < k ==> !(starts[j] <= line && line <= ends[j] && proved[j] && !narrowed[j]))
    if ((starts[k] as number) <= line && line <= (ends[k] as number) && proved[k] && !narrowed[k]) return true;
    k = k + 1;
  }
  return false;
}
