import type { ProofOutcome } from "./proof-outcome-rule.js";

/**
 * What the gate does with one changed file's proof when a run is about to
 * settle: a `failed` or `vacuous` proof goes back to the agent, which can fix
 * the code or the proof, unless `repeated` says it is the same failure the
 * gate last sent back for that file since the operator's input: a correction
 * that made no progress, which the gate reports instead of sending back
 * again. A proof that could not run, ran past its limit or was stopped is the
 * operator's to resolve, never the agent's.
 */
export type GateVerdict = "proved" | "send_back" | "no_progress" | "operator";

//@ ensures \result === "proved" <==> outcome === "passed"
//@ ensures \result === "send_back" <==> (outcome === "failed" || outcome === "vacuous") && !repeated
//@ ensures \result === "no_progress" <==> (outcome === "failed" || outcome === "vacuous") && repeated
//@ ensures \result === "operator" <==> (outcome === "not_started" || outcome === "timed_out" || outcome === "cancelled")
export function gateVerdict(outcome: ProofOutcome, repeated: boolean): GateVerdict {
  if (outcome === "passed") return "proved";
  if (outcome === "failed" || outcome === "vacuous") return repeated ? "no_progress" : "send_back";
  return "operator";
}

/**
 * Whether the run continues: while some file goes back to the agent
 * (`gateVerdict`). Every other file waits for that continuation, so a run
 * settles only when no file has a failure the agent has not yet answered.
 */
//@ ensures \result <==> exists(k: nat, k < verdicts.length && verdicts[k] === "send_back")
export function keepsWorking(verdicts: readonly GateVerdict[]): boolean {
  let k = 0;
  while (k < verdicts.length) {
    //@ invariant 0 <= k && k <= verdicts.length
    //@ invariant forall(j: nat, j < k ==> verdicts[j] !== "send_back")
    if (verdicts[k] === "send_back") return true;
    k = k + 1;
  }
  return false;
}
