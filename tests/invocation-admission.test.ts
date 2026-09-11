import { describe, expect, it } from "vitest";
import { canAdmitInvocation } from "../src/verification/invocation-admission.js";

describe("invocation admission", () => {
  it("allows a valid invocation below the configured limit", () => {
    expect(canAdmitInvocation("inference", 0, 1)).toBe("allow");
    expect(canAdmitInvocation("verification", 1, 2)).toBe("allow");
  });

  it("denies exhausted or malformed budgets", () => {
    expect(canAdmitInvocation("inference", 1, 1)).toBe("deny");
    expect(canAdmitInvocation("verification", -1, 2)).toBe("deny");
    expect(canAdmitInvocation("inference", 0, 0)).toBe("deny");
    expect(canAdmitInvocation("inference", 0.5, 2)).toBe("allow");
  });
});
