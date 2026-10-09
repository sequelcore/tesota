import { expect, it } from "vitest";
import { equivalentMutant, mutantFinding } from "../src/verification/mutation-rule.js";

it("counts a mutant that proves as surviving, one that fails as rejected, and any other end as undecided", () => {
  expect(mutantFinding("passed")).toBe("survived");
  expect(mutantFinding("failed")).toBe("rejected");
  for (const outcome of ["vacuous", "not_started", "timed_out", "cancelled"] as const) expect(mutantFinding(outcome)).toBe("inconclusive");
});

it("drops a surviving mutant as equivalent only when its equivalence proof passed", () => {
  expect(equivalentMutant("passed")).toBe(true);
  for (const outcome of ["failed", "vacuous", "not_started", "timed_out", "cancelled"] as const) expect(equivalentMutant(outcome)).toBe(false);
});
