/** Choices the agent displayed; selecting one does not make its wording operator-authored. */
export interface ClarificationQuestion {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiple?: boolean;
  readonly recommended?: number;
}

/** Explicitly submitted choices and optional supplemental text, kept without rewriting. */
export interface ClarificationAnswer {
  readonly selected: readonly number[];
  readonly text?: string;
}

/** One submitted batch, identified within the run by its assistant reply and call. */
export interface Clarification {
  readonly reply: number;
  readonly callId: string;
  readonly at: string;
  readonly questions: readonly ClarificationQuestion[];
  readonly answers: readonly ClarificationAnswer[];
}

/** Request input in journal order, so a later amendment can qualify an earlier answer. */
export type RequestInput =
  | { readonly kind: "amendment"; readonly origin: string; readonly text: string }
  | { readonly kind: "clarification"; readonly clarification: Clarification };

/** An attributed answer as request context, never a claim of evidence or approval. */
export function clarificationText(clarification: Pick<Clarification, "questions" | "answers">): string {
  return clarification.questions.map((question, index) => {
    const answer = clarification.answers[index];
    return [`Agent question: ${question.question}`,
      ...(answer?.selected ?? []).flatMap((selected) => {
        const option = question.options[selected];
        return option === undefined ? [] : [`Operator selected: ${option.label} — ${option.description}`];
      }), ...answer?.text === undefined ? [] : [`Operator text (verbatim):\n${answer.text}`]].join("\n");
  }).join("\n\n");
}
