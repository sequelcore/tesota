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
