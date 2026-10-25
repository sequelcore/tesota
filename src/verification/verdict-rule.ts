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
 * a check failed, `incomplete` when either holds without a failed check;
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
