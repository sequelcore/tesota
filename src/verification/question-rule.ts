/**
 * A shortcut answers only when it is one character and names an offered
 * option. Otherwise it leaves the question waiting. Keys are normalized to
 * lower case by the terminal; the first offered match wins.
 */
//@ ensures -1 <= \result && \result < keys.length
//@ ensures data.length !== 1 ==> \result === -1
//@ ensures \result >= 0 ==> data.length === 1 && keys[\result] === data
//@ ensures \result >= 0 ==> forall(i: nat, i < \result ==> keys[i] !== data)
//@ ensures data.length === 1 && \result === -1 ==> forall(i: nat, i < keys.length ==> keys[i] !== data)
export function questionShortcut(keys: readonly string[], data: string): number {
  if (data.length !== 1) return -1;
  for (let i = 0; i < keys.length; i += 1) {
    //@ invariant 0 <= i && i <= keys.length
    //@ invariant forall(j: nat, j < i ==> keys[j] !== data)
    if (keys[i] === data) return i;
  }
  return -1;
}
