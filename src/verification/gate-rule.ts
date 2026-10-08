import type { ProofOutcome } from "./proof-outcome-rule.js";

/**
 * What the gate does with one changed file's proof when a run is about to
 * settle: a `failed` or `vacuous` proof goes back to the agent, which can fix
 * the code or the proof, unless its `failure` is one the gate already sent
 * back for that file in this request (`sent`): a correction that made no
 * progress, even one that alternates between failures, which the gate
 * reports instead of sending back again. A proof that could not run, ran past
 * its limit or was stopped is the operator's to resolve, never the agent's.
 */
export type GateVerdict = "proved" | "send_back" | "no_progress" | "operator";

//@ ensures \result === "proved" <==> outcome === "passed"
//@ ensures \result === "send_back" <==> (outcome === "failed" || outcome === "vacuous") && !exists(k: nat, k < sent.length && sent[k] === failure)
//@ ensures \result === "no_progress" <==> (outcome === "failed" || outcome === "vacuous") && exists(k: nat, k < sent.length && sent[k] === failure)
//@ ensures \result === "operator" <==> (outcome === "not_started" || outcome === "timed_out" || outcome === "cancelled")
export function gateVerdict(outcome: ProofOutcome, failure: string, sent: readonly string[]): GateVerdict {
  if (outcome === "passed") return "proved";
  if (outcome !== "failed" && outcome !== "vacuous") return "operator";
  let k = 0;
  while (k < sent.length) {
    //@ invariant 0 <= k && k <= sent.length
    //@ invariant forall(j: nat, j < k ==> sent[j] !== failure)
    if (sent[k] === failure) return "no_progress";
    k = k + 1;
  }
  return "send_back";
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
