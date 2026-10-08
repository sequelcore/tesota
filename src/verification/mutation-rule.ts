import type { ProofOutcome } from "./proof-outcome-rule.js";

/**
 * What one mutant's proof says about the contract it was proved under: a
 * mutant whose proof fails is behavior the contract rules out (`rejected`);
 * one that proves is behavior it does not rule out (`survived`), which makes
 * the contract too weak to trust. A proof that verified nothing, could not
 * run, ran past its limit or was stopped decides neither.
 */
export type MutantFinding = "rejected" | "survived" | "inconclusive";

//@ ensures \result === "rejected" <==> outcome === "failed"
//@ ensures \result === "survived" <==> outcome === "passed"
//@ ensures \result === "inconclusive" <==> outcome !== "failed" && outcome !== "passed"
export function mutantFinding(outcome: ProofOutcome): MutantFinding {
  if (outcome === "failed") return "rejected";
  return outcome === "passed" ? "survived" : "inconclusive";
}
