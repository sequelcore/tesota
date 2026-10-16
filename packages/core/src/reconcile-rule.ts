/** What recovery adds for a call: nothing, "outcome unknown", or "not run". */
export const noRepair = 0;
export const outcomeUnknown = 1;
export const notRun = 2;

/**
 * What recovery adds for each call of a session's replies (#437). Call `i`
 * has a result the session saw (`seen[i]`), had its intent recorded before
 * it ran (`intended[i]`), or was already repaired by an earlier recovery
 * (`repaired[i]`). A call with a result or a repair gets nothing, so no
 * result is replaced and recovery run again adds nothing. Every other call
 * gets exactly one repair: "outcome unknown" when it may have run, since
 * its intent was recorded, and "not run" when it never started. No repair
 * claims the call succeeded, and none runs it again.
 */
//@ requires seen.length === intended.length && intended.length === repaired.length
//@ ensures \result.length === seen.length
//@ ensures forall(i: nat, i < seen.length ==> ((seen[i] || repaired[i]) ==> \result[i] === 0))
//@ ensures forall(i: nat, i < seen.length ==> ((!seen[i] && !repaired[i] && intended[i]) ==> \result[i] === 1))
//@ ensures forall(i: nat, i < seen.length ==> ((!seen[i] && !repaired[i] && !intended[i]) ==> \result[i] === 2))
export function repairs(seen: readonly boolean[], intended: readonly boolean[], repaired: readonly boolean[]): number[] {
  const found: number[] = [];
  let i = 0;
  while (i < seen.length) {
    //@ invariant 0 <= i && i <= seen.length && found.length === i
    //@ invariant forall(k: nat, k < i ==> ((seen[k] || repaired[k]) ==> found[k] === 0))
    //@ invariant forall(k: nat, k < i ==> ((!seen[k] && !repaired[k] && intended[k]) ==> found[k] === 1))
    //@ invariant forall(k: nat, k < i ==> ((!seen[k] && !repaired[k] && !intended[k]) ==> found[k] === 2))
    if (seen[i] || repaired[i]) found.push(0);
    else if (intended[i]) found.push(1);
    else found.push(2);
    i = i + 1;
  }
  return found;
}
