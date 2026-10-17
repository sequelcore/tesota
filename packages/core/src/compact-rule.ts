/**
 * Whether the conversation must be compacted before the next request (#451):
 * once its tokens pass the context window less the reserve the reply needs.
 * A model with no known window is never compacted ahead; an overflow the
 * provider reports compacts it then.
 */
//@ ensures \result <==> (window > 0 && tokens > window - reserve)
export function shouldCompact(tokens: number, window: number, reserve: number): boolean {
  return window > 0 && tokens > window - reserve;
}

/**
 * Where the verbatim tail starts (#451): walking back from the newest message,
 * the first place a turn may start once the messages after it hold at least
 * `keep` tokens, so a tool call is never split from its result. The messages
 * before it are summarized; 0 when no such place leaves anything to summarize.
 */
//@ requires sizes.length === starts.length
//@ ensures 0 <= \result && \result <= sizes.length
//@ ensures \result > 0 ==> \result < sizes.length && starts[\result]
export function cutPoint(sizes: readonly number[], starts: readonly boolean[], keep: number): number {
  let kept = 0;
  let k = sizes.length;
  while (k > 0) {
    //@ invariant 0 <= k && k <= sizes.length
    k = k - 1;
    kept = kept + sizes[k]!;
    if (k > 0 && kept >= keep && starts[k]) return k;
  }
  return 0;
}
