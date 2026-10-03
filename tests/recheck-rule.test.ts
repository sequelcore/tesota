import { expect, it } from "vitest";
import { recheckOf } from "../src/verification/recheck-rule.js";

it("keeps every finding present after a correction that changed nothing, whatever the verdict (#250)", () => {
  for (const verdict of ["resolved", "unresolved", "undetermined", "none"] as const) expect(recheckOf(false, verdict)).toBe("present");
});

it("resolves a finding only on the validator's verdict, and leaves one without a verdict not re-checked", () => {
  expect(recheckOf(true, "resolved")).toBe("resolved");
  expect(recheckOf(true, "unresolved")).toBe("present");
  expect(recheckOf(true, "undetermined")).toBe("unchecked");
  expect(recheckOf(true, "none")).toBe("unchecked");
});
