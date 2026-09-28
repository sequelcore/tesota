export type CheckOutcome = "passed" | "failed" | "timed_out" | "cancelled" | "not_started" | "unconfirmed" | "changed_files";
export type CheckOrigin = "introduced" | "preexisting" | "unknown";

/**
 * Decision 039's origin rule for a failing check command. A command is run
 * again on the candidate's base, in the same environment, only when it failed
 * or timed out on the candidate: the candidate introduced the failure only
 * when the base passes, and the failure was already there only when the base
 * ends the same way. Anything else, such as a base run that could not start,
 * was stopped or changed files, leaves the cause unknown. Only an introduced
 * failure goes back to the working agent.
 */
//@ ensures !(candidate === "failed" || candidate === "timed_out") ==> \result === "unknown"
//@ ensures (candidate === "failed" || candidate === "timed_out") && base === "passed" ==> \result === "introduced"
//@ ensures (candidate === "failed" || candidate === "timed_out") && base === candidate ==> \result === "preexisting"
//@ ensures \result === "introduced" ==> base === "passed"
//@ ensures \result === "preexisting" ==> base === candidate && candidate !== "passed"
export function checkOrigin(candidate: CheckOutcome, base: CheckOutcome): CheckOrigin {
  if (candidate !== "failed" && candidate !== "timed_out") return "unknown";
  if (base === "passed") return "introduced";
  if (base === candidate) return "preexisting";
  return "unknown";
}
