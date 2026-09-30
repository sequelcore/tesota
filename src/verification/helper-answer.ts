export type HelperTurnStatus = "completed" | "failed" | "cancelled" | "unsettled" | "timed_out";

/**
 * The rule for a helper session's reply: an explorer's (decision 019), the
 * page reader's (024) or the advisor's (027). The agent receives it as an
 * answer only when the helper finished within its time limit and said
 * something. An unfinished or empty reply is never presented as an answer;
 * a request that ran past its limit ends `timed_out`, never `completed`
 * (`limitedTurnStatus`).
 */
//@ ensures \result === (status === "completed" && answerLength > 0)
export function isHelperAnswer(status: HelperTurnStatus, answerLength: number): boolean {
  if (status !== "completed") return false;
  return answerLength > 0;
}

/**
 * The per-turn allowance for helpers the agent starts, explorers and advisor
 * consults: another may start only while fewer than the limit have started.
 */
//@ ensures started < 0 || limit <= 0 ==> \result === false
//@ ensures started >= 0 && limit > 0 ==> \result === (started < limit)
export function canStartHelper(started: number, limit: number): boolean {
  if (started < 0 || limit <= 0) return false;
  return started < limit;
}
