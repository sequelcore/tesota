export type ExplorerTurnStatus = "completed" | "failed" | "cancelled" | "unsettled";

/**
 * Decision 019's rule for an explorer's reply: the agent receives it as an
 * answer only when the explorer finished within its time limit and said
 * something. An unfinished or empty reply is never presented as an answer.
 */
//@ ensures \result === (!timedOut && status === "completed" && answerLength > 0)
export function isExplorerAnswer(timedOut: boolean, status: ExplorerTurnStatus, answerLength: number): boolean {
  if (timedOut || status !== "completed") return false;
  return answerLength > 0;
}

/** Decision 019's per-turn allowance: another explorer may start only while fewer than the limit have started. */
//@ ensures started < 0 || limit <= 0 ==> \result === false
//@ ensures started >= 0 && limit > 0 ==> \result === (started < limit)
export function canStartExplorer(started: number, limit: number): boolean {
  if (started < 0 || limit <= 0) return false;
  return started < limit;
}
