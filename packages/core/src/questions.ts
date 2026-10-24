import type { ClarificationAnswer, ClarificationQuestion } from "../../../src/clarification.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { validateAnswers, validateQuestions } from "./questions-schema.ts";

/** Last sentence of the last prose paragraph's direct request, excluding optional offers,
 * quoted examples, headings and fenced/inline code.
 * Deliberately a lexical heuristic: implicit decisions and other languages can be missed.
 */
export function blockingProseQuestion(text: string): string | undefined {
  const prose = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*(?:\n|$)|(?![\s\S]))/gmu, "\n\n")
    .replace(/^[ \t]*(?:>|#{1,6}\s| {4}|\t).*$/gmu, "")
    .replace(/`[^`\n]*`|"[^"\n]*"|“[^”]*”|‘[^’]*’|«[^»]*»/gu, "");
  const last = prose.trim().split(/\n\s*\n/u).at(-1)?.trim();
  if (!last) return undefined;
  const sentence = last.match(/[^.!?]+[.!?]*$/u)?.[0]?.trim();
  if (!sentence) return undefined;
  const direct = /^(?:(?:do you (?:want|have|prefer|need)|would you|can you|could you|should I|may I|which|what (?:is|are|should|do)|how (?:should|can) I)\b[^?]*\?|¿\p{L}[^?]*\?|(?:please (?:choose|select|provide|confirm)|let me know (?:which|whether)|dime (?:cuál|qué|si)|avísame (?:cuál|qué)|elige)(?=\s).+)[.!?]*$/iu;
  return direct.test(sentence) ? last : undefined;
}

export type QuestionOutcome =
  | { readonly status: "answered"; readonly answers: readonly ClarificationAnswer[] }
  | { readonly status: "cancelled"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

/** Returns a local validation error, or undefined after synchronously saving the answer. */
export type QuestionSubmit = (answers: readonly ClarificationAnswer[]) => string | undefined;

/** Registers a form and returns the one cleanup function for its lifetime. */
export type QuestionResponder = (questions: readonly ClarificationQuestion[], submit: QuestionSubmit,
  finish: (outcome: Exclude<QuestionOutcome, { readonly status: "answered" }>) => void) => () => void;

/**
 * Waits for one explicit operator outcome. Registration is scoped so a stop
 * releases the UI callback before this promise settles.
 */
export async function askQuestions(questions: readonly ClarificationQuestion[], responder: QuestionResponder | undefined,
  signal: AbortSignal, commit: (answers: readonly ClarificationAnswer[]) => void): Promise<QuestionOutcome> {
  const invalid = validateQuestions(questions);
  if (invalid !== undefined) throw new Error(invalid);
  if (responder === undefined) return { status: "unavailable", reason: "No operator question responder is available." };
  const program = Effect.suspend(() => signal.aborted ? Effect.interrupt : Effect.gen(function* () {
    const answer = yield* Deferred.make<QuestionOutcome, Error>();
    return yield* Effect.acquireUseRelease(Effect.sync(() => {
      let done = false;
      const complete = (outcome: QuestionOutcome): void => {
        if (done) return;
        done = true;
        Effect.runSync(Deferred.succeed(answer, outcome));
      };
      const cleanup = responder(questions, (answers) => {
        if (done) return "This question is no longer active.";
        if (signal.aborted) return "The run was stopped before this answer could be saved.";
        const problem = validateAnswers(questions, answers);
        if (problem !== undefined) return problem;
        const submitted = structuredClone(answers);
        try {
          commit(submitted);
        } catch (error) {
          done = true;
          Effect.runSync(Deferred.fail(answer, error instanceof Error ? error : new Error(String(error))));
          return "The answer could not be saved.";
        }
        complete({ status: "answered", answers: submitted });
        return undefined;
      }, (outcome) => { complete(outcome); });
      return () => { done = true; cleanup(); };
    }), () => Deferred.await(answer), (cleanup) => Effect.sync(cleanup));
  }));
  const result = await Effect.runPromiseExit(program, { signal });
  if (Exit.isSuccess(result)) return result.value;
  if (Cause.hasInterruptsOnly(result.cause)) return { status: "cancelled", reason: "The run stopped while the question waited." };
  throw Cause.squash(result.cause);
}
