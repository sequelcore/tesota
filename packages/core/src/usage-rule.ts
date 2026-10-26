/**
 * The usage panel's rules. A meter shows the share of a limit window that
 * is left, in whole hundredths of a percent (10000 is the whole window), so
 * a provider's fraction decides the meter before anything is rounded for
 * print; it is drawn as segments; accounts that are one underlying account
 * are read once.
 */

/** The share left, in hundredths of a percent, of a window used this much; a report outside the window is held to it. */
//@ ensures used <= 0 ==> \result === 10000
//@ ensures used >= 10000 ==> \result === 0
//@ ensures 0 < used && used < 10000 ==> \result === 10000 - used
export function remainingHundredths(used: number): number {
  if (used <= 0) return 10000;
  if (used >= 10000) return 0;
  return 10000 - used;
}

/**
 * How many of a bar's segments a share left fills: the nearest count, but
 * a bar is empty only when nothing is left and full only when nothing is
 * used, so 0.4% left never reads as exhausted and 99.6% never as untouched.
 */
//@ requires segments >= 2
//@ ensures 0 <= \result && \result <= segments
//@ ensures \result === 0 <==> left <= 0
//@ ensures \result === segments <==> left >= 10000
//@ ensures 0 < left && left < 10000 ==> 1 <= \result && \result <= segments - 1
//@ ensures 0 < left && left < 10000 ==> \result === 1 || \result * 10000 <= left * segments + 5000
//@ ensures 0 < left && left < 10000 ==> \result === segments - 1 || left * segments + 5000 < (\result + 1) * 10000
export function filledSegments(left: number, segments: number): number {
  if (left <= 0) return 0;
  if (left >= 10000) return segments;
  const nearest = Math.floor((left * segments + 5000) / 10000);
  if (nearest < 1) return 1;
  if (nearest > segments - 1) return segments - 1;
  return nearest;
}

/**
 * The whole percent printed beside a meter: the nearest, but 0% only when
 * nothing is left and 100% only when nothing is used, so the number never
 * says otherwise than the bar and its color.
 */
//@ ensures 0 <= \result && \result <= 100
//@ ensures \result === 0 <==> left <= 0
//@ ensures \result === 100 <==> left >= 10000
//@ ensures 0 < left && left < 10000 ==> \result === 1 || \result * 100 <= left + 50
//@ ensures 0 < left && left < 10000 ==> \result === 99 || left + 50 < (\result + 1) * 100
export function shownPercent(left: number): number {
  if (left <= 0) return 0;
  if (left >= 10000) return 100;
  const nearest = Math.floor((left + 50) / 100);
  if (nearest < 1) return 1;
  if (nearest > 99) return 99;
  return nearest;
}

export type MeterTone = "ok" | "low" | "out";

/** How a meter is colored: out when nothing is left, low at a quarter or less, so an account running short stands out. */
//@ ensures \result === "out" <==> left <= 0
//@ ensures \result === "low" <==> (0 < left && left <= 2500)
//@ ensures \result === "ok" <==> left > 2500
export function meterTone(left: number): MeterTone {
  if (left <= 0) return "out";
  return left <= 2500 ? "low" : "ok";
}

/**
 * Which account's reading an account shows. Accounts that are one
 * underlying account share one plan's limits, so it is read once, through
 * the first account on it, and the others point to that reading: their
 * meters cannot disagree. An account whose identity is unknown, written as
 * an empty string, is read by itself.
 */
//@ requires 0 <= account && account < identities.length
//@ ensures 0 <= \result && \result <= account
//@ ensures identities[account] === "" ==> \result === account
//@ ensures identities[account] !== "" ==> identities[\result] === identities[account]
//@ ensures identities[account] !== "" ==> forall(j: nat, j < \result ==> identities[j] !== identities[account])
//@ ensures identities[account] !== "" && \result < account ==> exists(j: nat, j < account && identities[j] === identities[account])
//@ ensures identities[account] !== "" && \result === account ==> forall(j: nat, j < account ==> identities[j] !== identities[account])
export function usageReader(identities: readonly string[], account: number): number {
  if (identities[account] === "") return account;
  for (let i = 0; i < account; i += 1) {
    //@ invariant 0 <= i && i <= account
    //@ invariant forall(j: nat, j < i ==> identities[j] !== identities[account])
    if (identities[i] === identities[account]) return i;
  }
  return account;
}
