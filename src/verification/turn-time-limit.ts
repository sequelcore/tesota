export type EngineTurnStatus = "completed" | "failed" | "cancelled" | "unsettled";
export type LimitedTurnStatus = EngineTurnStatus | "timed_out";

/**
 * Decision 022's rule for a request run under a time limit: it timed out only
 * when the limit, and not the caller, stopped it, and the engine then
 * reported it stopped. A completed, failed or unsettled request keeps its
 * outcome, so a time-out never hides a result or an engine that could not
 * stop; a request the caller stopped stays cancelled.
 */
//@ ensures status === "completed" ==> \result === "completed"
//@ ensures status === "failed" ==> \result === "failed"
//@ ensures status === "unsettled" ==> \result === "unsettled"
//@ ensures status === "cancelled" && limitReached && !callerStopped ==> \result === "timed_out"
//@ ensures status === "cancelled" && (!limitReached || callerStopped) ==> \result === "cancelled"
export function limitedTurnStatus(status: EngineTurnStatus, limitReached: boolean, callerStopped: boolean): LimitedTurnStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "unsettled") return "unsettled";
  if (limitReached && !callerStopped) return "timed_out";
  return "cancelled";
}
