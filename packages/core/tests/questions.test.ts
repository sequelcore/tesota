import { expect, test } from "bun:test";
import type { ClarificationAnswer, ClarificationQuestion } from "../../../src/clarification.ts";
import { askQuestions, blockingProseQuestion } from "../src/questions.ts";
import { validateAnswers, validateQuestions } from "../src/questions-schema.ts";

test.each([
  "Done. Let me know if you want anything else.",
  "All 12 tests pass. Which tests failed? None.",
  "Listo. Confirma el resultado en la receta.",
  "Listo. Avísame si quieres algo más.",
])("a finished report is not a blocking decision: %s", (text) => {
  expect(blockingProseQuestion(text)).toBeUndefined();
});

test.each([
  "Do you want me to re-run it then, or do you have another sign-in or an API key to use?",
  "Done. ¿Quieres que lo intente otra vez?", "Which option should I use?", "Please choose an account.",
])("a final direct decision still blocks: %s", (text) => {
  expect(blockingProseQuestion(text)).toBe(text);
});

const questions: readonly ClarificationQuestion[] = [{ question: "Which?", options: [
  { label: "A", description: "first" }, { label: "B", description: "second" },
], recommended: 1 }];

test("a batch accepts an explicit answer with text, but never a recommendation as an answer", () => {
  expect(validateQuestions(questions)).toBeUndefined();
  expect(validateAnswers(questions, [{ selected: [], text: "compare them" }])).toBeUndefined();
  expect(validateAnswers(questions, [{ selected: [] }])).toContain("Select an option");
  expect(validateAnswers(questions, [{ selected: [0, 1] }])).toContain("one selection");
});

test("submission commits before the scoped responder resolves, then releases once", async () => {
  let submit: ((answers: readonly ClarificationAnswer[]) => string | undefined) | undefined;
  let released = 0;
  const committed: ClarificationAnswer[][] = [];
  const waiting = askQuestions(questions, (_questions, received) => {
    submit = received;
    return () => { released += 1; };
  }, new AbortController().signal, (answers) => { committed.push([...answers]); });
  await Promise.resolve();
  expect(submit?.([{ selected: [1], text: "keep this exact" }])).toBeUndefined();
  await expect(waiting).resolves.toEqual({ status: "answered", answers: [{ selected: [1], text: "keep this exact" }] });
  expect(committed).toEqual([[{ selected: [1], text: "keep this exact" }]]);
  expect(released).toBe(1);
});

test("an absent responder returns unavailable without waiting", async () => {
  await expect(askQuestions(questions, undefined, new AbortController().signal, () => { throw new Error("not called"); }))
    .resolves.toEqual({ status: "unavailable", reason: "No operator question responder is available." });
});

test("submission snapshots the answer so later draft edits cannot change what the model receives", async () => {
  const answer = { selected: [0], text: "Original words." };
  const draft = [answer];
  const committed: unknown[] = [];
  const outcome = await askQuestions(questions, (_batch, submit) => {
    submit(draft);
    answer.text = "Edited after submission.";
    return () => undefined;
  }, new AbortController().signal, (answers) => { committed.push(answers); });
  expect(outcome).toEqual({ status: "answered", answers: [{ selected: [0], text: "Original words." }] });
  expect(committed).toEqual([[{ selected: [0], text: "Original words." }]]);
});

test("invalid shapes, sizes and selections cannot become submitted answers", () => {
  expect(validateQuestions(undefined)).toBeDefined();
  expect(validateQuestions([])).toBeDefined();
  expect(validateQuestions([questions[0], questions[0], questions[0], questions[0]])).toBeDefined();
  expect(validateQuestions([{ ...questions[0], question: "x".repeat(16 * 1024) }])).toBeDefined();
  expect(validateQuestions([{ ...questions[0], recommended: 2 }])).toBeDefined();
  expect(validateAnswers(questions, [{ selected: [0, 0] }])).toBeDefined();
  expect(validateAnswers(questions, [{ selected: [1.5] }])).toBeDefined();
  expect(validateAnswers(questions, [{ selected: [0], text: "x".repeat(16 * 1024) }])).toBeDefined();
  expect(validateAnswers(questions, [{ selected: [0], text: 1 }])).toBeDefined();
  expect(validateAnswers([{ ...questions[0], multiple: true, question: "Which?", options: questions[0]?.options ?? [] }],
    [{ selected: [0, 1], text: "Both." }])).toBeUndefined();
});
