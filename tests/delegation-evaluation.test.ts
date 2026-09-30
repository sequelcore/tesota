import { expect, it } from "vitest";
import { DELEGATION_CASES, scoreAnswer } from "../src/delegation-evaluation.js";

it("has questions that each need several facts", () => {
  expect(DELEGATION_CASES.length).toBeGreaterThanOrEqual(6);
  for (const testCase of DELEGATION_CASES) expect(testCase.facts.length).toBeGreaterThanOrEqual(4);
});

it("counts each fact once, by any of its phrasings, ignoring case", () => {
  const [correction] = DELEGATION_CASES;
  if (correction === undefined) throw new Error("missing case");
  expect(scoreAnswer(correction, "In src/correction.ts: Fixable, INTRODUCED and confirmed findings go back."))
    .toEqual({ name: "correction", stated: 4, facts: 5 });
  expect(scoreAnswer(correction, "I could not find it.")).toEqual({ name: "correction", stated: 0, facts: 5 });
});
