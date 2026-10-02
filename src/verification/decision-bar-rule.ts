/**
 * How much the decision bar says for a width, from the columns each layout
 * needs: 0, the count with its files and the full hint; 1, with the short
 * hint; 2, with no hint; 3, the count alone. The fullest layout that fits is
 * chosen, its actions always whole, so a line is never cut mid-word; with no
 * room for any, the count alone, which the terminal then truncates.
 */
//@ requires full >= short && short >= bare && bare >= 0
//@ ensures \result >= 0 && \result <= 3
//@ ensures full <= width ==> \result === 0
//@ ensures full > width && short <= width ==> \result === 1
//@ ensures short > width && bare <= width ==> \result === 2
//@ ensures bare > width ==> \result === 3
export function decisionLevel(width: number, full: number, short: number, bare: number): number {
  if (full <= width) return 0;
  if (short <= width) return 1;
  if (bare <= width) return 2;
  return 3;
}
