export type ProofOutcome = "passed" | "failed" | "vacuous" | "timed_out" | "cancelled" | "not_started";

/**
 * How one LemmaScript proof of a file ended: `lsc regen`, which merges the
 * changed source into the `.dfy`, then `lsc check`, which proves it. `started`
 * says both could run at all, Dafny included; `checkExit` is `lsc check`'s
 * exit code and `verified` the obligations Dafny reported verified. It passes
 * only when nothing stopped it, regen succeeded, check exited cleanly and
 * Dafny verified at least one obligation. A clean exit with 0 verified, as
 * when a contract is attached to no function, is `vacuous`: it proved
 * nothing, and unlike `not_started` the file, not the computer, is the cause.
 */
//@ requires verified >= 0
//@ ensures \result === "passed" <==> !cancelled && !timedOut && started && regenerated && checkExit === 0 && verified > 0
//@ ensures \result === "vacuous" <==> !cancelled && !timedOut && started && regenerated && checkExit === 0 && verified === 0
//@ ensures \result === "not_started" <==> !cancelled && !timedOut && !started
//@ ensures cancelled ==> \result === "cancelled"
//@ ensures !cancelled && timedOut ==> \result === "timed_out"
//@ ensures \result === "failed" ==> started && (!regenerated || checkExit !== 0)
export function proofOutcome(cancelled: boolean, timedOut: boolean, started: boolean, regenerated: boolean,
  checkExit: number, verified: number): ProofOutcome {
  if (cancelled) return "cancelled";
  if (timedOut) return "timed_out";
  if (!started) return "not_started";
  if (!regenerated || checkExit !== 0) return "failed";
  return verified > 0 ? "passed" : "vacuous";
}
