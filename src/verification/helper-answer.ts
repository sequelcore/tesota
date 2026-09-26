export type HelperTurnStatus = "completed" | "failed" | "cancelled" | "unsettled";

/**
 * Decision 019's rule for a helper's reply: the agent receives it as an
 * answer only when the helper finished within its time limit and said
 * something. An unfinished or empty reply is never presented as an answer.
 */
//@ ensures \result === (!timedOut && status === "completed" && answerLength > 0)
export function isHelperAnswer(timedOut: boolean, status: HelperTurnStatus, answerLength: number): boolean {
  if (timedOut || status !== "completed") return false;
  return answerLength > 0;
}

/** Decision 019's per-turn allowance: another helper may start only while fewer than the limit have started. */
//@ ensures started < 0 || limit <= 0 ==> \result === false
//@ ensures started >= 0 && limit > 0 ==> \result === (started < limit)
export function canStartHelper(started: number, limit: number): boolean {
  if (started < 0 || limit <= 0) return false;
  return started < limit;
}
