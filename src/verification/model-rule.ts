import type { ProofOutcome } from "./proof-outcome-rule.js";

/**
 * How one TLC run of a model ended: every reachable state checked and none
 * broke a property (`passed`); TLC found no state to check (`vacuous`); a
 * reachable state broke a declared invariant or property or failed an
 * assertion (`violated`); a run only deadlocked (`deadlocked`); an assumption
 * failed (`assumption_failed`); TLC could not read or
 * evaluate the model or its configuration (`malformed`), which the model's
 * author must fix; or it ran past its limit, was stopped, or could not run,
 * Java and TLC included.
 */
export type ModelRun = "assumption_failed" | "deadlocked" | "passed" | "vacuous" | "violated" | "malformed" | "timed_out" | "cancelled" | "not_started";

/**
 * A TLC run from how its process ended: `started` says Java and TLC ran at
 * all, `exitCode` is TLC's and `states` the distinct states it reported.
 * TLC's exit status (`tlc2.output.EC.ExitStatus`) is 0 for success, 10 to 14
 * for an assumption failure, deadlock, safety, liveness or assertion respectively, 150
 * and 151 for a specification or configuration it cannot parse, and 75 for
 * an error evaluating the model; any other is TLC's own failure, such as a
 * missing file or memory, so nothing was checked. A false assumption (10)
 * fails the main run but is not a declared property rejecting a fault.
 */
//@ requires states >= 0
//@ ensures cancelled ==> \result === "cancelled"
//@ ensures !cancelled && timedOut ==> \result === "timed_out"
//@ ensures \result === "passed" <==> !cancelled && !timedOut && started && exitCode === 0 && states > 0
//@ ensures \result === "vacuous" <==> !cancelled && !timedOut && started && exitCode === 0 && states === 0
//@ ensures \result === "violated" <==> !cancelled && !timedOut && started && exitCode >= 12 && exitCode <= 14
//@ ensures \result === "deadlocked" <==> !cancelled && !timedOut && started && exitCode === 11
//@ ensures \result === "assumption_failed" <==> !cancelled && !timedOut && started && exitCode === 10
//@ ensures \result === "malformed" <==> !cancelled && !timedOut && started && (exitCode === 75 || exitCode === 150 || exitCode === 151)
export function tlcRun(cancelled: boolean, timedOut: boolean, started: boolean, exitCode: number, states: number): ModelRun {
  if (cancelled) return "cancelled";
  if (timedOut) return "timed_out";
  if (!started) return "not_started";
  if (exitCode === 0) return states > 0 ? "passed" : "vacuous";
  if (exitCode === 11) return "deadlocked";
  if (exitCode >= 12 && exitCode <= 14) return "violated";
  if (exitCode === 10) return "assumption_failed";
  if (exitCode === 75 || exitCode === 150 || exitCode === 151) return "malformed";
  return "not_started";
}

/** TLC -continue can exit zero after reports; declared violations take precedence over a deadlock. */
//@ ensures (run === "passed" || run === "deadlocked") && violated ==> \result === "violated"
//@ ensures run === "passed" && !violated && deadlocked ==> \result === "deadlocked"
//@ ensures !((run === "passed" || run === "deadlocked") && violated) && !(run === "passed" && deadlocked) ==> \result === run
export function reportedTlcRun(run: ModelRun, violated: boolean, deadlocked: boolean): ModelRun {
  if ((run === "passed" || run === "deadlocked") && violated) return "violated";
  return run === "passed" && deadlocked ? "deadlocked" : run;
}

/**
 * A run as evidence states its outcome: a violation and a model TLC cannot
 * read, and a deadlock, all fail, so either goes back to the agent (`gateVerdict`); the rest
 * keep their names.
 */
//@ ensures \result === "failed" <==> (run === "violated" || run === "deadlocked" || run === "assumption_failed" || run === "malformed")
//@ ensures \result === "passed" <==> run === "passed"
//@ ensures \result === "vacuous" <==> run === "vacuous"
//@ ensures \result === "not_started" <==> run === "not_started"
export function runOutcome(run: ModelRun): ProofOutcome {
  if (run === "violated" || run === "deadlocked" || run === "assumption_failed" || run === "malformed") return "failed";
  if (run === "passed") return "passed";
  if (run === "vacuous") return "vacuous";
  if (run === "timed_out") return "timed_out";
  if (run === "cancelled") return "cancelled";
  return "not_started";
}

/**
 * What a planted fault's run shows: a fault is a variant of the model that
 * must break a property, so it is `caught` only by a violation; one that
 * passes shows the model cannot tell the fault from the code (`passes`); one
 * TLC cannot read, or with no state, shows nothing either way and must be
 * fixed (`broken`); a deadlock or unfinished run is `unrun`. After a deadlock
 * retry, errors and empty explorations also leave the fault `unrun`.
 */
export type FaultVerdict = "caught" | "passes" | "broken" | "unrun";

//@ ensures \result === "caught" <==> run === "violated"
//@ ensures \result === "passes" <==> run === "passed"
//@ ensures \result === "broken" <==> !retried && (run === "assumption_failed" || run === "malformed" || run === "vacuous")
//@ ensures \result === "unrun" <==> (run === "deadlocked" || run === "timed_out" || run === "cancelled" || run === "not_started" || (retried && (run === "assumption_failed" || run === "malformed" || run === "vacuous")))
export function faultVerdict(run: ModelRun, retried: boolean): FaultVerdict {
  if (run === "violated") return "caught";
  if (run === "passed") return "passes";
  if (!retried && (run === "assumption_failed" || run === "malformed" || run === "vacuous")) return "broken";
  return "unrun";
}

/**
 * How a model's check ends, for the gate (`gateVerdict`): as its own run
 * when that did not pass; when it passed, `vacuous` with no planted fault,
 * since nothing shows it can fail; `failed` when a fault passes or is broken,
 * since the model is too weak to trust or its fault must be fixed; `passed`
 * otherwise, a fault that did not finish leaving the pass standing with that
 * gap reported.
 */
//@ ensures main !== "passed" ==> \result === runOutcome(main)
//@ ensures main === "passed" && faults.length === 0 ==> \result === "vacuous"
//@ ensures main === "passed" && faults.length > 0 && exists(k: nat, k < faults.length && (faults[k] === "passes" || faults[k] === "broken")) ==> \result === "failed"
//@ ensures \result === "passed" <==> main === "passed" && faults.length > 0 && forall(k: nat, k < faults.length ==> (faults[k] === "caught" || faults[k] === "unrun"))
export function modelOutcome(main: ModelRun, faults: readonly FaultVerdict[]): ProofOutcome {
  if (main !== "passed") return runOutcome(main);
  if (faults.length === 0) return "vacuous";
  let k = 0;
  while (k < faults.length) {
    //@ invariant 0 <= k && k <= faults.length
    //@ invariant forall(j: nat, j < k ==> (faults[j] === "caught" || faults[j] === "unrun"))
    if (faults[k] === "passes" || faults[k] === "broken") return "failed";
    k = k + 1;
  }
  return "passed";
}

/**
 * Whether the gate runs TLC on a model as a run settles: only when the
 * request changed the model, one of its faults or a file it covers
 * (`touched`), and neither an earlier check in the request nor a pass in the
 * session read exactly this content (`checkedAsIs`), so an unchanged model
 * is never checked twice.
 */
//@ ensures \result <==> touched && !checkedAsIs
export function checksModel(touched: boolean, checkedAsIs: boolean): boolean {
  return touched && !checkedAsIs;
}

/**
 * Whether a model may no longer describe its code. A model the request wrote
 * with its code (`withCode`, from `writtenWithCode`) whose check passed
 * against the code as the request leaves it (`outcome`) is `current`, measured against that
 * end state rather than its confirmed commit. Otherwise: `unknown` when the
 * commit it was last confirmed against is not in the repository;
 * `possibly_stale` when some covered file differs from that commit
 * (`changed`); `current` otherwise. A hint, never a guarantee: a change
 * outside the covered files can still break what the model assumes.
 */
export type Staleness = "current" | "possibly_stale" | "unknown";

//@ ensures withCode && outcome === "passed" ==> \result === "current"
//@ ensures !(withCode && outcome === "passed") && !confirmedFound ==> \result === "unknown"
//@ ensures \result === "possibly_stale" <==> !(withCode && outcome === "passed") && confirmedFound && exists(k: nat, k < changed.length && changed[k])
//@ ensures \result === "current" <==> (withCode && outcome === "passed") || (confirmedFound && forall(k: nat, k < changed.length ==> !changed[k]))
export function staleness(withCode: boolean, outcome: ProofOutcome, confirmedFound: boolean, changed: readonly boolean[]): Staleness {
  if (withCode && outcome === "passed") return "current";
  if (!confirmedFound) return "unknown";
  let k = 0;
  while (k < changed.length) {
    //@ invariant 0 <= k && k <= changed.length
    //@ invariant forall(j: nat, j < k ==> !changed[j])
    if (changed[k]) return "possibly_stale";
    k = k + 1;
  }
  return "current";
}

/**
 * Whether one request wrote the model and changed the code it covers: a
 * model written with its code can mirror it, and pass for the same reason
 * the code does, so its evidence counts as weaker.
 */
//@ ensures \result <==> modelChanged && coveredChanged
export function writtenWithCode(modelChanged: boolean, coveredChanged: boolean): boolean {
  return modelChanged && coveredChanged;
}
