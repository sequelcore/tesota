/**
 * Which earlier requests a new request is judged with (#627), oldest first:
 * those after the last request whose changes were verified, as recorded by
 * a final successful settlement with a receipt, not merely a completed
 * answer. A stopped receipt is an
 * inventory, not verification. Returns the first included index, or the
 * length when the last request's changes were verified.
 */
//@ ensures 0 <= \result && \result <= verified.length
//@ ensures forall(j: nat, \result <= j && j < verified.length ==> !verified[j])
//@ ensures \result === 0 || verified[\result - 1]
export function unverifiedFrom(verified: readonly boolean[]): number {
  let from = verified.length;
  while (from > 0 && !verified[from - 1]) {
    //@ invariant 0 <= from && from <= verified.length
    //@ invariant forall(j: nat, from <= j && j < verified.length ==> !verified[j])
    from = from - 1;
  }
  return from;
}

/** A complete judge input plus its model's output allowance must fit the context capacity. */
//@ ensures \result <==> tokens >= 0 && output >= 0 && capacity > 0 && tokens + output <= capacity
export function fitsContext(tokens: number, output: number, capacity: number): boolean {
  return tokens >= 0 && output >= 0 && capacity > 0 && tokens + output <= capacity;
}