import type { ClarificationQuestion } from "../../../src/clarification.ts";
import { Check } from "typebox/value";
import { answerAccepted, optionCountAccepted, questionCountAccepted } from "./questions-rule.ts";
import { Type, type TArray, type TBoolean, type TInteger, type TObject, type TOptional, type TString } from "typebox";

type OptionShape = TObject<{ label: TString; description: TString }>;
type QuestionShape = TObject<{ question: TString; options: TArray<OptionShape>; multiple: TOptional<TBoolean>; recommended: TOptional<TInteger> }>;
type AnswerShape = TObject<{ selected: TArray<TInteger>; text: TOptional<TString> }>;

/** The same input shape at the model boundary and when reading a retained answer. */
export const questionsSchema: TArray<QuestionShape> = Type.Array(Type.Object({
  question: Type.String({ description: "The decision the operator should make." }),
  options: Type.Array(Type.Object({ label: Type.String(), description: Type.String() }, { additionalProperties: false })),
  multiple: Type.Optional(Type.Boolean()),
  recommended: Type.Optional(Type.Integer()),
}, { additionalProperties: false }));

/** A response's shape; selection rules are checked against the actual offered batch. */
export const answersSchema: TArray<AnswerShape> = Type.Array(Type.Object({
  selected: Type.Array(Type.Integer()),
  text: Type.Optional(Type.String()),
}, { additionalProperties: false }));

export const questionParameters: TObject<{ questions: TArray<QuestionShape> }> = Type.Object({ questions: questionsSchema }, { additionalProperties: false });

export const questionPayloadLimit: number = 16 * 1024;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const blank = (text: string | undefined): boolean => text === undefined || text.trim() === "";

/** An error message when the immutable batch cannot be offered to the operator. */
export function validateQuestions(questions: unknown): string | undefined {
  if (!Check(questionsSchema, questions)) return "The question batch has an invalid shape.";
  if (!questionCountAccepted(questions.length)) return "Ask between one and three questions.";
  if (bytes(questions) > questionPayloadLimit) return "The question batch is larger than 16 KiB.";
  for (const question of questions) {
    if (question.question.trim() === "") return "Each question needs text.";
    if (!optionCountAccepted(question.options.length)) return "Each question needs between two and four options.";
    if (new Set(question.options.map((option) => option.label)).size !== question.options.length) return "Question options must have distinct labels.";
    if (question.options.some((option) => option.label.trim() === "" || option.description.trim() === "")) return "Each option needs a label and description.";
    if (question.recommended !== undefined && (!Number.isInteger(question.recommended) || question.recommended < 0
      || question.recommended >= question.options.length)) return "A recommended option must be in its question.";
  }
  return undefined;
}

/** An error message when a submitted answer no longer matches its immutable batch. */
export function validateAnswers(questions: readonly ClarificationQuestion[], answers: unknown): string | undefined {
  if (!Check(answersSchema, answers)) return "The answers have an invalid shape.";
  if (answers.length !== questions.length) return "Answer every question before submitting.";
  if (bytes(answers) > questionPayloadLimit) return "The answers are larger than 16 KiB.";
  for (const [index, answer] of answers.entries()) {
    const question = questions[index];
    if (question === undefined) return "Answer every question before submitting.";
    if (answer.selected.some((selected) => !Number.isInteger(selected) || selected < 0 || selected >= question.options.length)) {
      return "A selected option is not in its question.";
    }
    if (new Set(answer.selected).size !== answer.selected.length) return "Select each option only once.";
    if (!question.multiple && answer.selected.length > 1) return "This question accepts one selection.";
    if (!answerAccepted(question.multiple === true, answer.selected.length, !blank(answer.text))) {
      return "Select an option or add text for every question.";
    }
  }
  return undefined;
}
