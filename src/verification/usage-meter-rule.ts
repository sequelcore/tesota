/**
 * Decision 051's meter rules. A meter shows the share of a window or credit
 * that is left, in whole percent, and draws it as a bar of segments, as
 * Codex's `/status` does.
 */

/** The share left of a window whose provider reports the whole percent used; a report outside 0 to 100 is held to it. */
//@ ensures used <= 0 ==> \result === 100
//@ ensures used >= 100 ==> \result === 0
//@ ensures 0 < used && used < 100 ==> \result === 100 - used
export function remainingPercent(used: number): number {
  if (used <= 0) return 100;
  if (used >= 100) return 0;
  return 100 - used;
}

/**
 * The whole percent left of a credit limit, both amounts in cents. It rounds
 * down, so a credit shows as left in full only when all of it is.
 */
//@ requires limit > 0
//@ ensures 0 <= \result && \result <= 100
//@ ensures remaining >= limit ==> \result === 100
//@ ensures remaining <= 0 ==> \result === 0
//@ ensures 0 < remaining && remaining < limit ==> \result * limit <= remaining * 100 && remaining * 100 < (\result + 1) * limit
export function creditPercent(remaining: number, limit: number): number {
  if (remaining >= limit) return 100;
  if (remaining <= 0) return 0;
  return Math.floor(remaining * 100 / limit);
}

/**
 * How many of a bar's segments a percent left fills: the nearest count, but
 * a bar is empty only when nothing is left and full only when nothing is
 * used, so 1% left never reads as exhausted and 99% never as untouched.
 */
//@ requires segments >= 2
//@ ensures 0 <= \result && \result <= segments
//@ ensures \result === 0 <==> percent <= 0
//@ ensures \result === segments <==> percent >= 100
export function filledSegments(percent: number, segments: number): number {
  if (percent <= 0) return 0;
  if (percent >= 100) return segments;
  const nearest = Math.floor((percent * segments + 50) / 100);
  if (nearest < 1) return 1;
  if (nearest > segments - 1) return segments - 1;
  return nearest;
}
