import type { SessionOutcome } from "../../../src/contract.ts";

/**
 * The earlier requests a new request is judged with (#627), given how each
 * earlier run ended, oldest first: those after the last run that completed,
 * which only a verification that settled lets a run do. A run that was
 * stopped, ended by an error or a limit, or interrupted never had its changes
 * verified, so the request that follows continues it; a completed run was
 * judged already, and every request after it starts fresh. Returns the index
 * of the first such request; `ends.length` when there is none.
 */
//@ ensures 0 <= \result && \result <= ends.length
//@ ensures forall(j: nat, \result <= j && j < ends.length ==> ends[j] !== "completed")
//@ ensures \result === 0 || ends[\result - 1] === "completed"
export function uncompletedFrom(ends: readonly SessionOutcome[]): number {
  let from = ends.length;
  while (from > 0 && ends[from - 1] !== "completed") {
    //@ invariant 0 <= from && from <= ends.length
    //@ invariant forall(j: nat, from <= j && j < ends.length ==> ends[j] !== "completed")
    from = from - 1;
  }
  return from;
}
