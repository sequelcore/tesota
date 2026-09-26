export type ExplorerTurnStatus = "completed" | "failed" | "cancelled" | "unsettled" | "timed_out";

/**
 * Decision 019's rule for an explorer's reply: the agent receives it as an
 * answer only when the explorer finished within its time limit and said
 * something. An unfinished or empty reply is never presented as an answer;
 * a request that ran past its limit ends `timed_out`, never `completed`
 * (`limitedTurnStatus`).
 */
//@ ensures \result === (status === "completed" && answerLength > 0)
export function isExplorerAnswer(status: ExplorerTurnStatus, answerLength: number): boolean {
  if (status !== "completed") return false;
  return answerLength > 0;
}

/** Decision 019's per-turn allowance: another explorer may start only while fewer than the limit have started. */
//@ ensures started < 0 || limit <= 0 ==> \result === false
//@ ensures started >= 0 && limit > 0 ==> \result === (started < limit)
export function canStartExplorer(started: number, limit: number): boolean {
  if (started < 0 || limit <= 0) return false;
  return started < limit;
}
