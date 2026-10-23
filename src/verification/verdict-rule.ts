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
