import { expect, it } from "vitest";
import { proofOutcome } from "../src/verification/proof-outcome-rule.js";

it("passes a proof only when Dafny verified something, and tells a vacuous proof from one that could not run", () => {
  expect(proofOutcome(false, false, true, true, 0, 3)).toBe("passed");
  expect(proofOutcome(false, false, true, true, 0, 0)).toBe("vacuous");
  expect(proofOutcome(false, false, true, true, 1, 2)).toBe("failed");
  expect(proofOutcome(false, false, true, false, -1, 0)).toBe("failed");
  expect(proofOutcome(false, false, false, false, -1, 0)).toBe("not_started");
  expect(proofOutcome(false, true, true, true, 0, 3)).toBe("timed_out");
  expect(proofOutcome(true, true, true, true, 0, 3)).toBe("cancelled");
});
