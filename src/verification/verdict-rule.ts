import type { ModelRun } from "./model-rule.js";
import type { ProofOutcome } from "./proof-outcome-rule.js";

/**
 * What one finding of a receipt asks of the operator: a decision before
 * accepting the change (`decide`), such as a proof or command that still
 * fails, a weak contract, a change that may weaken the evidence or a test
 * that passes without the change; a gap to know about (`gap`), such as lines
 * no proof covers; evidence that holds (`holds`); or a model's opinion
 * (`opinion`), which is a candidate and never evidence (#375).
 */
export type Standing = "decide" | "gap" | "holds" | "opinion";

/**
 * How many findings need the operator: only those the checks established,
 * so a model's opinion never counts, however it reads. The receipt is clean
 * when none does.
 */
//@ ensures 0 <= \result && \result <= standings.length
//@ ensures \result === 0 <==> !exists(k: nat, k < standings.length && standings[k] === "decide")
export function decisions(standings: readonly Standing[]): number {
  let count = 0;
  let k = 0;
  while (k < standings.length) {
    //@ invariant 0 <= k && k <= standings.length
    //@ invariant 0 <= count && count <= k
    //@ invariant count === 0 <==> !exists(j: nat, j < k && standings[j] === "decide")
    if (standings[k] === "decide") count = count + 1;
    k = k + 1;
  }
  return count;
}

/**
 * Whether a summary of one check's findings must say how many of them hold,
 * as in "Contract strong (1 of 4)": some finding of that check needs the
 * operator or is a gap, so its label alone would read as if every one held
 * (#399). A model's opinion is never evidence either way.
 */
//@ ensures \result <==> exists(k: nat, k < standings.length && (standings[k] === "decide" || standings[k] === "gap"))
export function partlyHolds(standings: readonly Standing[]): boolean {
  let k = 0;
  while (k < standings.length) {
    //@ invariant 0 <= k && k <= standings.length
    //@ invariant !exists(j: nat, j < k && (standings[j] === "decide" || standings[j] === "gap"))
    if (standings[k] === "decide" || standings[k] === "gap") return true;
    k = k + 1;
  }
  return false;
}

/**
 * The color of a receipt's verdict, in the conversation and in the footer
 * alike: red when a check failed among what needs the operator, amber when
 * something needs them or is a gap, green only when neither, so a receipt
 * with gaps never reads as wholly verified.
 */
//@ requires decisions >= 0 && gaps >= 0
//@ ensures \result === "error" <==> (decisions > 0 && failed)
//@ ensures \result === "success" <==> (decisions === 0 && gaps === 0)
//@ ensures \result === "error" || \result === "warning" || \result === "success"
export function verdictTone(decisions: number, failed: boolean, gaps: number): "error" | "warning" | "success" {
  if (decisions > 0) return failed ? "error" : "warning";
  return gaps > 0 ? "warning" : "success";
}

/**
 * How a method's row of the receipt sums up its `runs` (#591), of which
 * `held` held outright, `partly` held with less than they claim, such as a
 * proof trusting what the change added, and `failed` failed: `holds` only
 * when every run held outright, so no row reads as a universal success
 * unless it is one; `partly` when some held and not all outright; `fails`
 * when none held and one failed; `none` when no run held or failed.
 */
//@ requires held >= 0 && partly >= 0 && failed >= 0 && held + partly + failed <= runs
//@ ensures \result === "holds" <==> (runs > 0 && held === runs)
//@ ensures \result === "partly" <==> (held + partly > 0 && held < runs)
//@ ensures \result === "fails" <==> (held + partly === 0 && failed > 0)
//@ ensures \result === "none" <==> held + partly + failed === 0
export function methodStanding(held: number, partly: number, failed: number, runs: number): "holds" | "partly" | "fails" | "none" {
  if (runs > 0 && held === runs) return "holds";
  if (held + partly > 0) return "partly";
  return failed > 0 ? "fails" : "none";
}

/**
 * How one check of a receipt ended, for the standing (`runStanding`) and the
 * findings alike: `failed` only when it ran and showed the change wrong;
 * `passed` when it held on current content; otherwise a `gap`.
 *
 * A failing test or a proof that doesn't hold (`outcome` `failed`) fails. A
 * design model fails only on an observed violation: a counterexample,
 * liveness or assertion failure (`run` `violated`), a deadlock (`deadlocked`),
 * a failed assumption (`assumption_failed`), or a planted
 * fault its check didn't catch (`faultPasses`), which shows the model can't
 * tell the fault from the code. Everything else is a gap: evidence the
 * settled content no longer holds (`stale`); a check that couldn't run, ran
 * past its limit or was stopped; one that checked nothing (a proof Dafny
 * verified nothing of, a model with no reachable state); and a model TLC or
 * Quint couldn't read, including one whose header Tesota refused before TLC
 * started, or with only broken faults or none. `run` is a model's own run,
 * and is not read for a proof or a command.
 */
//@ ensures \result === "failed" <==> !stale && ((kind === "model" && (run === "violated" || run === "deadlocked" || run === "assumption_failed" || (run === "passed" && faultPasses))) || (kind !== "model" && outcome === "failed"))
//@ ensures \result === "passed" <==> !stale && outcome === "passed" && (kind !== "model" || (run === "passed" && !faultPasses))
//@ ensures \result === "passed" || \result === "failed" || \result === "gap"
//@ ensures stale ==> \result === "gap"
//@ ensures kind !== "model" && (outcome === "vacuous" || outcome === "not_started" || outcome === "timed_out" || outcome === "cancelled") ==> \result === "gap"
//@ ensures kind === "model" && (run === "malformed" || run === "vacuous" || run === "timed_out" || run === "cancelled" || run === "not_started") ==> \result === "gap"
export function checkEnd(kind: "proof" | "command" | "model", stale: boolean, outcome: ProofOutcome, run: ModelRun,
  faultPasses: boolean): "passed" | "failed" | "gap" {
  if (stale) return "gap";
  if (kind === "model") {
    if (run === "violated" || run === "deadlocked" || run === "assumption_failed" || (run === "passed" && faultPasses)) return "failed";
    return outcome === "passed" && run === "passed" ? "passed" : "gap";
  }
  if (outcome === "failed") return "failed";
  return outcome === "passed" ? "passed" : "gap";
}

/**
 * The process result an exported receipt states (`tesota receipt --json`),
 * from the values the agentic process evidence proposal defines for
 * `predicate.result`: `CANCELLED` ("stopped before completion") when the
 * run stopped before Tesota verified it; otherwise `COMPLETED` ("finished
 * successfully") only when the run stands `verified` or `unchanged`;
 * `FAILED` ("ended unsuccessfully") when a check ran and showed the change
 * wrong; and `none` for `incomplete` and `unverified`, which no value states
 * truthfully and which the export refuses, so it never states a success it
 * didn't observe.
 */
//@ requires standing === "verified" || standing === "incomplete" || standing === "failed" || standing === "unverified" || standing === "unchanged"
//@ ensures \result === "CANCELLED" <==> stopped
//@ ensures \result === "COMPLETED" <==> (!stopped && (standing === "verified" || standing === "unchanged"))
//@ ensures \result === "FAILED" <==> (!stopped && standing === "failed")
//@ ensures \result === "none" <==> (!stopped && (standing === "incomplete" || standing === "unverified"))
export function statementResult(stopped: boolean, standing: "verified" | "incomplete" | "failed" | "unverified" | "unchanged"):
  "CANCELLED" | "COMPLETED" | "FAILED" | "none" {
  if (stopped) return "CANCELLED";
  if (standing === "verified" || standing === "unchanged") return "COMPLETED";
  if (standing === "failed") return "FAILED";
  return "none";
}

/**
 * Whether one changed path is covered (#668), in the standing and the
 * receipt's summary alike: it proved, or it was tested and exercised, as
 * `runStanding` reads each of them from the receipt.
 */
//@ ensures \result <==> (proved || (tested && exercised))
export function pathCovered(proved: boolean, tested: boolean, exercised: boolean): boolean {
  return proved || (tested && exercised);
}

/**
 * Where a run's verification stands (#668), one meaning on every surface:
 * `failed` when it stopped or something needs the operator (`decisions`) and
 * a check failed, `incomplete` when either holds without a failed check.
 * A check failed only when it ran and showed the change wrong: a failing
 * test, a proof that doesn't hold, a model that breaks a rule, alike for
 * proofs, commands and models (`checkEnd`). One that could
 * not run, ran past its limit, was stopped or whose evidence is stale is a
 * gap (`gaps`), never `failed`;
 * otherwise `unchanged` when nothing changed, so there is nothing to claim;
 * `unverified` when something changed and no piece of evidence (a test,
 * proof or model check that ran) passed; `incomplete` when one did but a gap
 * remains or a changed path is not covered; `verified` only when none of
 * these holds.
 *
 * One entry per changed path: `proved[k]` when the receipt does not list it
 * as unproved (it proved, or is a test or comments-only file, which its
 * `unverified` leaves out); `tested[k]` when its unit ran at least one
 * command and every one passed; `exercised[k]` read from its unit's
 * exercises: its unit lists exactly that one path as unproved, records at
 * least one exercise, and every exercise is `fails_then_passes`, so a test
 * noticed the change, and nothing else unproved could be what it noticed.
 * A path is covered (`pathCovered`) when it proved, or was tested and exercised. `gaps`
 * counts the receipt's other gaps, besides those unproved paths.
 */
//@ requires passed >= 0 && decisions >= 0 && gaps >= 0
//@ requires tested.length === proved.length && exercised.length === proved.length
//@ ensures \result === "verified" <==> (!stopped && decisions === 0 && changed && passed > 0 && gaps === 0 && forall(k: nat, k < proved.length ==> (proved[k] || (tested[k] && exercised[k]))))
//@ ensures \result === "failed" <==> ((stopped || decisions > 0) && failed)
//@ ensures \result === "unchanged" <==> (!stopped && decisions === 0 && !changed)
//@ ensures \result === "unverified" <==> (!stopped && decisions === 0 && changed && passed === 0)
//@ ensures \result === "incomplete" <==> (((stopped || decisions > 0) && !failed) || (!stopped && decisions === 0 && changed && passed > 0 && (gaps > 0 || exists(k: nat, k < proved.length && !proved[k] && !(tested[k] && exercised[k])))))
export function runStanding(changed: boolean, stopped: boolean, decisions: number, failed: boolean, passed: number, gaps: number,
  proved: readonly boolean[], tested: readonly boolean[], exercised: readonly boolean[]): "verified" | "incomplete" | "failed" | "unverified" | "unchanged" {
  if (stopped || decisions > 0) return failed ? "failed" : "incomplete";
  if (!changed) return "unchanged";
  if (passed === 0) return "unverified";
  if (gaps > 0) return "incomplete";
  let k = 0;
  while (k < proved.length) {
    //@ invariant 0 <= k && k <= proved.length
    //@ invariant forall(j: nat, j < k ==> (proved[j] || (tested[j] && exercised[j])))
    if (!pathCovered(proved[k] === true, tested[k] === true, exercised[k] === true)) return "incomplete";
    k = k + 1;
  }
  return "verified";
}
