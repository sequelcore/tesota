/**
 * Which route's reading a route shows in `tesota usage` (#235). Routes signed
 * in to one account share one plan's limits, so the account is read once,
 * through the first route on it, and every route on it shows that reading:
 * their meters cannot disagree. A route whose account is unknown, written as
 * an empty string, is read by itself.
 */
//@ requires 0 <= route && route < accounts.length
//@ ensures 0 <= \result && \result <= route
//@ ensures accounts[route] === "" ==> \result === route
//@ ensures accounts[route] !== "" ==> accounts[\result] === accounts[route]
//@ ensures accounts[route] !== "" ==> forall(j: nat, j < \result ==> accounts[j] !== accounts[route])
export function usageReader(accounts: readonly string[], route: number): number {
  if (accounts[route] === "") return route;
  for (let i = 0; i < route; i += 1) {
    //@ invariant 0 <= i && i <= route
    //@ invariant forall(j: nat, j < i ==> accounts[j] !== accounts[route])
    if (accounts[i] === accounts[route]) return i;
  }
  return route;
}
