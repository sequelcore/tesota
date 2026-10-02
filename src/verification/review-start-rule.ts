/**
 * Issue #249's rule for where a candidate in the source begins: at the first
 * undecided turn the last review of changes did not cover whole, so a turn
 * stopped before its review, or the part of one a stopped correction left,
 * is reviewed with the turn after it. A review that ended at a turn's end
 * covered that turn, so the candidate begins at the next one. A review that
 * ended inside a turn, as one does when the correction it sent was stopped,
 * or at the latest turn's end, with nothing new since, began where its own
 * candidate did. With no review known, the candidate begins at the first
 * undecided turn. `reviewedEnd` and `reviewedStart` are the latest turns
 * whose end and whose start match the last review's tree and base, or -1.
 */
//@ requires turns >= 1
//@ requires reviewedEnd >= -1 && reviewedEnd < turns
//@ requires reviewedStart >= -1 && reviewedStart < turns
//@ ensures \result >= 0 && \result < turns
//@ ensures reviewedEnd >= 0 && reviewedEnd < turns - 1 ==> \result === reviewedEnd + 1
//@ ensures (reviewedEnd === -1 || reviewedEnd === turns - 1) && reviewedStart >= 0 ==> \result === reviewedStart
//@ ensures (reviewedEnd === -1 || reviewedEnd === turns - 1) && reviewedStart === -1 ==> \result === 0
export function candidateStart(turns: number, reviewedEnd: number, reviewedStart: number): number {
  if (reviewedEnd >= 0 && reviewedEnd < turns - 1) return reviewedEnd + 1;
  return reviewedStart >= 0 ? reviewedStart : 0;
}
