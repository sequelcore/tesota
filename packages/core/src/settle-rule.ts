import type { RunOutcome } from "./contract.ts";

export type AfterExtensions = "continue" | "verify" | "finalize";
export type AfterVerifier = "continue" | "completed" | "incomplete" | "aborted" | "error";

/** Automatic continuations per run; operator input and tool turns do not count. */
export const continuationLimit = 32;

/**
 * What follows ordinary settle handlers (#439): a completed loop continues
 * when a handler asks and the budget allows, or reaches verification when
 * none asks. Cancellation, a loop failure, a throw or an exhausted budget
 * only finalizes. Requests to continue accumulate across handlers.
 */
//@ requires continuations >= 0 && limit >= 0
//@ ensures \result === "continue" <==> run === "completed" && !cancelled && !threw && continued && continuations < limit
//@ ensures \result === "verify" <==> run === "completed" && !cancelled && !threw && !continued
//@ ensures \result === "finalize" <==> cancelled || run !== "completed" || threw || (continued && continuations >= limit)
export function afterExtensions(run: RunOutcome, cancelled: boolean, threw: boolean, continued: boolean, continuations: number, limit: number): AfterExtensions {
  if (cancelled || run !== "completed" || threw) return "finalize";
  if (!continued) return "verify";
  return continuations < limit ? "continue" : "finalize";
}

/**
 * What follows the verifier's settle handler (#439): cancellation wins,
 * and a loop error survives only if no settle handler threw. A completed
 * loop can continue or finish only after a registered verifier ran without
 * a throw. Its continuation uses the automatic budget; unseen operator
 * input continues without that budget when the verifier did not ask.
 * Every other case is incomplete, including a verifier that only finalized.
 */
//@ requires continuations >= 0 && limit >= 0
//@ ensures \result === "aborted" <==> cancelled || run === "aborted"
//@ ensures \result === "error" <==> !cancelled && run === "error" && !threw
//@ ensures \result === "continue" <==> !cancelled && run === "completed" && verifying && !threw && registered && ((continued && continuations < limit) || (!continued && pending))
//@ ensures \result === "completed" <==> !cancelled && run === "completed" && verifying && !threw && registered && !continued && !pending
//@ ensures \result === "incomplete" <==> !cancelled && run !== "aborted" && ((run === "error" && threw) || (run === "completed" && (!verifying || threw || !registered || (continued && continuations >= limit))))
//@ ensures \result === "completed" ==> verifying && registered && !threw && !cancelled
//@ ensures \result === "continue" ==> run === "completed" && !cancelled
export function afterVerifier(run: RunOutcome, verifying: boolean, cancelled: boolean, threw: boolean, registered: boolean, continued: boolean, pending: boolean, continuations: number, limit: number): AfterVerifier {
  if (cancelled || run === "aborted") return "aborted";
  if (run === "error" && !threw) return "error";
  if (run !== "completed" || !verifying || threw || !registered) return "incomplete";
  if (continued) return continuations < limit ? "continue" : "incomplete";
  return pending ? "continue" : "completed";
}
