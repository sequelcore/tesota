import { expect, it } from "vitest";
import { checkAction, findingAction, obligationAction, type ActionCheckOrigin, type ActionOutcome,
  type ActionStanding } from "../src/verification/review-action-rule.js";

it("sends only introduced, confirmed, fixable findings to the agent", () => {
  for (const standing of ["confirmed", "refuted", "unsettled", "untested"] satisfies ActionStanding[]) {
    expect(findingAction("introduced", "fixable", standing, false))
      .toBe(standing === "confirmed" ? "agent" : standing === "refuted" ? "context" : "operator");
  }
  expect(findingAction("introduced", "fixable", "confirmed", true)).toBe("context");
  expect(findingAction("preexisting", "fixable", "confirmed", false)).toBe("context");
  expect(findingAction("unknown", "fixable", "confirmed", false)).toBe("operator");
  expect(findingAction("introduced", "operator", "confirmed", false)).toBe("operator");
});

it("keeps failed base checks and checks without an established cause out of correction", () => {
  for (const outcome of ["failed", "timed_out"] satisfies ActionOutcome[]) {
    for (const origin of ["introduced", "preexisting", "unknown", "absent"] satisfies ActionCheckOrigin[]) {
      expect(checkAction("command", outcome, origin))
        .toBe(origin === "introduced" ? "agent" : origin === "preexisting" ? "context" : "operator");
    }
    expect(checkAction("oxlint", outcome, "absent")).toBe("agent");
    expect(checkAction("lemmascript", outcome, "absent")).toBe("agent");
  }
  expect(checkAction("command", "passed", "absent")).toBe("context");
  for (const outcome of ["cancelled", "not_started", "unconfirmed", "changed_files"] satisfies ActionOutcome[]) {
    expect(checkAction("command", outcome, "absent")).toBe("operator");
  }
});

it("sends only confirmed missing work back", () => {
  expect(obligationAction("not_held")).toBe("agent");
  expect(obligationAction("uncertain")).toBe("operator");
  expect(obligationAction("held")).toBe("context");
});
