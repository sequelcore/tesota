/**
 * Decision 030's rule for a native sandbox's workspace drive left mapped by a
 * session that ended without cleaning up, such as one whose terminal was
 * closed. Another drive is removed only when a Tesota lease names it and the
 * process that holds the lease is no longer running: a drive without a lease
 * may be the operator's own or an older Tesota's, and a running owner may
 * still be using it, so neither is touched.
 */
//@ ensures \result <==> (leased && !ownerRunning)
export function releasesDrive(leased: boolean, ownerRunning: boolean): boolean {
  if (!leased) return false;
  return !ownerRunning;
}
