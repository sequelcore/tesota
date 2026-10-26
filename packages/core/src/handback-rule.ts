/**
 * Whether a step on Claude Code goes on in the query waiting on its calls
 * (#546): only on the same model, prompt and tools (`same`), when the reply
 * the engine kept made exactly the calls the query waits on (`pending`
 * against `made`, in order), and each of those calls has its result in the
 * engine's history (`answered`, by position in `pending`). Anything else
 * starts a new query from the engine's history.
 */
//@ requires answered.length === pending.length
//@ ensures \result <==> same && pending.length > 0 && pending.length === made.length && forall(k: nat, k < pending.length ==> (pending[k] === made[k] && answered[k]))
export function goesOn(same: boolean, pending: readonly string[], made: readonly string[], answered: readonly boolean[]): boolean {
  if (!same || pending.length === 0 || pending.length !== made.length) return false;
  let k = 0;
  while (k < pending.length) {
    //@ invariant 0 <= k && k <= pending.length
    //@ invariant forall(j: nat, j < k ==> (pending[j] === made[j] && answered[j]))
    if (pending[k] !== made[k] || !answered[k]) return false;
    k = k + 1;
  }
  return true;
}
