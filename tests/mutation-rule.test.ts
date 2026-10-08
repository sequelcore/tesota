import { expect, it } from "vitest";
import { mutantFinding } from "../src/verification/mutation-rule.js";

it("counts a mutant that proves as surviving, one that fails as rejected, and any other end as undecided", () => {
  expect(mutantFinding("passed")).toBe("survived");
  expect(mutantFinding("failed")).toBe("rejected");
  for (const outcome of ["vacuous", "not_started", "timed_out", "cancelled"] as const) expect(mutantFinding(outcome)).toBe("inconclusive");
});
