import { expect, it } from "vitest";
import { checkAction, findingAction, obligationAction, roundStarts, severityAction, type ActionCheckOrigin, type ActionOutcome,
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

it("sends only confirmed missing work the agent can do back, and the rest to the operator", () => {
  expect(obligationAction("not_held", "fixable")).toBe("agent");
  // Missing work the agent cannot do, as a check failing on the base for a missing program, is the operator's (#224).
  expect(obligationAction("not_held", "operator")).toBe("operator");
  expect(obligationAction("uncertain", "fixable")).toBe("operator");
  expect(obligationAction("held", "operator")).toBe("context");
});

it("starts a round for a failed check, an unmet obligation or a significant finding, never for low findings alone", () => {
  expect(roundStarts(false, false, false)).toBe(false);
  expect(roundStarts(true, false, false)).toBe(true);
  expect(roundStarts(false, true, false)).toBe(true);
  expect(roundStarts(false, false, true)).toBe(true);
});

it("sends a low finding meant for the agent to the operator unless a round starts anyway, and changes nothing else", () => {
  expect(severityAction("agent", true, false)).toBe("operator");
  expect(severityAction("agent", true, true)).toBe("agent");
  expect(severityAction("agent", false, false)).toBe("agent");
  for (const action of ["operator", "context"] as const) {
    expect(severityAction(action, true, false)).toBe(action);
  }
});
