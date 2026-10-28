import type { ProofOutcome } from "./proof-outcome-rule.js";

/**
 * A started tool may change files unless it is a trusted built-in reader or
 * question, or it starts in a read-only session, which changes nothing: its
 * gate never verifies edits it didn't make, such as a parent's in the folder
 * it shares (#585). `prove` regenerates the proof's files, so it makes the
 * request eligible too.
 */
//@ ensures \result <==> (!nativeQuestion && !readOnly && toolName !== "read" && toolName !== "grep" && toolName !== "find" && toolName !== "ls")
export function toolMayChangeFiles(toolName: string, nativeQuestion: boolean, readOnly: boolean): boolean {
  return !nativeQuestion && !readOnly && toolName !== "read" && toolName !== "grep" && toolName !== "find" && toolName !== "ls";
}

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
 * What the gate does with one of the project's commands (#726): a failure
 * the base already had (`checkOrigin`) is the operator's, never sent back to
 * the agent; any other is judged as a proof is (`gateVerdict`).
 */
//@ ensures \result === "proved" <==> outcome === "passed"
//@ ensures \result === "send_back" <==> !(preexisting && outcome === "failed") && (outcome === "failed" || outcome === "vacuous") && !exists(k: nat, k < sent.length && sent[k] === failure)
//@ ensures \result === "no_progress" <==> !(preexisting && outcome === "failed") && (outcome === "failed" || outcome === "vacuous") && exists(k: nat, k < sent.length && sent[k] === failure)
//@ ensures \result === "operator" <==> (preexisting && outcome === "failed") || outcome === "not_started" || outcome === "timed_out" || outcome === "cancelled"
export function commandVerdict(outcome: ProofOutcome, failure: string, sent: readonly string[], preexisting: boolean): GateVerdict {
  if (preexisting && outcome === "failed") return "operator";
  return gateVerdict(outcome, failure, sent);
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
