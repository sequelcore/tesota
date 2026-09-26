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
