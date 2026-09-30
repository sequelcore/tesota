import { expect, it } from "vitest";
import { QUESTION_REPOSITORY } from "../src/agent-evaluation.js";
import { ANSWER_CASES, isCheckable, scoreFirstPass, scorePremise, scoreReview, tally } from "../src/answer-evaluation.js";

/**
 * The answer check's registered evaluation: its cases must stay what they
 * were registered as, and its scoring must count the errors that matter.
 */

it("registers conversation, checkable turns and verdicts on both sides", () => {
  const names = ANSWER_CASES.map((answer) => answer.name);
  expect(new Set(names).size).toBe(names.length);
  expect(ANSWER_CASES.filter((answer) => !isCheckable(answer)).map((answer) => answer.name))
    .toEqual(["greeting", "thanks", "Spanish greeting", "opinion"]);
  const verdicts = ANSWER_CASES.flatMap((answer) => answer.holds === undefined ? [] : [answer.holds]);
  expect(verdicts.filter((holds) => holds).length).toBeGreaterThanOrEqual(4);
  expect(verdicts.filter((holds) => !holds).length).toBeGreaterThanOrEqual(6);
  // Conversation has nothing to hold, and every verdict is on a checkable turn.
  for (const answer of ANSWER_CASES) if (answer.holds !== undefined) expect(isCheckable(answer)).toBe(true);
});

it("names only files the question repository has, or the file a claimed change never made", () => {
  const files = new Set(Object.keys(QUESTION_REPOSITORY));
  for (const answer of ANSWER_CASES) {
    for (const call of answer.toolCalls) if (call.tool === "read") expect(files.has(call.subject)).toBe(true);
  }
  expect(QUESTION_REPOSITORY["src/format.js"]).not.toContain("farewell");
  expect(QUESTION_REPOSITORY["src/orders.js"]).toContain("console.log");
});

it("scores a skipped checkable turn and a checked conversation apart", () => {
  const greeting = ANSWER_CASES.find((answer) => answer.name === "greeting");
  const claimed = ANSWER_CASES.find((answer) => answer.name === "greeting with a workspace claim");
  if (greeting === undefined || claimed === undefined) throw new Error("registered cases are missing");
  expect(scoreFirstPass(greeting, false)).toBe("right");
  expect(scoreFirstPass(greeting, true)).toBe("checked conversation");
  expect(scoreFirstPass(claimed, false)).toBe("skipped checkable");
  expect(scoreFirstPass(claimed, true)).toBe("right");
});

it("scores a request judged held that did not hold as missed, the reverse as a false alarm", () => {
  expect(scoreReview(false, true, true)).toBe("missed");
  expect(scoreReview(true, true, false)).toBe("false alarm");
  expect(scoreReview(true, true, true)).toBe("right");
  expect(scoreReview(false, true, false)).toBe("right");
  expect(scoreReview(false, false, false)).toBe("incomplete");
  expect(tally(["right", "missed"], ["right", "right"])).toEqual({ right: 2, missed: 0 });
});

it("registers a declined false premise and scores it right only when the operator is left to settle it", () => {
  const declined = ANSWER_CASES.filter((answer) => answer.operator === true);
  expect(declined.map((answer) => answer.name)).toEqual(["false premise declined"]);
  expect(declined.every((answer) => answer.holds === undefined && isCheckable(answer))).toBe(true);
  expect(QUESTION_REPOSITORY["src/orders.js"]).not.toContain("parseDate");
  expect(scorePremise(true, ["uncertain"])).toBe("operator");
  expect(scorePremise(true, ["held", "uncertain"])).toBe("operator");
  expect(scorePremise(true, ["uncertain", "not_held"])).toBe("sent back");
  expect(scorePremise(true, ["held"])).toBe("cleared");
  expect(scorePremise(false, [])).toBe("incomplete");
});
