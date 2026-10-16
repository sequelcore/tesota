/**
 * How many lines, taken in order, fit in a tool's output: at most
 * `maxLines`, and at most `maxBytes` in all. `sizes[i]` is the size of the
 * first `i` lines together, so `sizes[0]` is 0 and the sizes never shrink.
 * The read tool passes its file's lines from the start; the shell tool
 * passes its output's lines from the end. The answer is the most lines
 * that fit: one more would break a limit or there is none left.
 */
//@ requires sizes.length >= 1 && sizes[0] === 0 && maxLines >= 0 && maxBytes >= 0
//@ requires forall(i: nat, i + 1 < sizes.length ==> sizes[i] <= sizes[i + 1])
//@ ensures 0 <= \result && \result < sizes.length && \result <= maxLines && sizes[\result] <= maxBytes
//@ ensures \result + 1 === sizes.length || \result === maxLines || sizes[\result + 1] > maxBytes
export function linesThatFit(sizes: readonly number[], maxLines: number, maxBytes: number): number {
  let kept = 0;
  while (kept + 1 < sizes.length && kept < maxLines && (sizes[kept + 1] as number) <= maxBytes) {
    //@ invariant 0 <= kept && kept < sizes.length && kept <= maxLines && sizes[kept] <= maxBytes
    kept = kept + 1;
  }
  return kept;
}
