/**
 * The characters the skill catalog may take in the system prompt (#457): two
 * percent of the context window at four characters per token, as Codex
 * budgets its own, or 8,000 characters when the window is not known.
 */
//@ requires window >= 0
//@ ensures window === 0 ==> \result === 8000
//@ ensures window > 0 ==> 100 * \result <= window * 8 && window * 8 < 100 * (\result + 1)
export function catalogBudget(window: number): number {
  if (window === 0) return 8000;
  return Math.floor(window * 8 / 100);
}

/**
 * How much of a file of `size` characters the prompt keeps (#457), when files
 * before it already took `used` of a `cap`: all of it while it fits, what is
 * left when it does not, and nothing once the cap is full.
 */
//@ requires used >= 0 && size >= 0 && cap >= 0 && used <= cap
//@ ensures 0 <= \result && \result <= size
//@ ensures used + \result <= cap
//@ ensures used + size <= cap ==> \result === size
//@ ensures used + size > cap ==> \result === cap - used
export function kept(used: number, size: number, cap: number): number {
  if (used + size <= cap) return size;
  return cap - used;
}
