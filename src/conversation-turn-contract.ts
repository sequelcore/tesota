import * as z from "zod";
import { modelTextSchema, taskProposalSchema, validProposalPath } from "./task-proposal-contract.js";

const messageSchema = modelTextSchema(4_000);
const evidencePathSchema = z.string().min(1).max(512).refine(validProposalPath);
const requestSchema = z.string().trim().min(1).max(8_000);
const baselineSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export interface InitialConversationInput {
  readonly request: string;
  readonly clarification?: undefined;
}

export interface ContinuedConversationInput {
  readonly request: string;
  readonly clarification: { readonly question: string; readonly answer: string; readonly baseline: string };
}

export type ConversationInput = InitialConversationInput | ContinuedConversationInput;

const initialConversationInputSchema: z.ZodType<InitialConversationInput> =
  z.strictObject({ request: requestSchema });
const continuedConversationInputSchema: z.ZodType<ContinuedConversationInput> = z.strictObject({
  request: requestSchema,
  clarification: z.strictObject({
    question: messageSchema.max(1_000),
    answer: messageSchema.max(4_000),
    baseline: baselineSchema,
  }),
}).refine((input) => retainedConversationRequest(input).length <= 8_000,
  { message: "Retained clarified request exceeds 8000 characters" });

export const conversationInputSchema: z.ZodType<ConversationInput> = z.union([
  initialConversationInputSchema,
  continuedConversationInputSchema,
]);

/** Canonical request evidence retained when one clarification produces a proposal. */
export function retainedConversationRequest(input: ContinuedConversationInput): string {
  return `${input.request}\n\nClarification: ${input.clarification.question}\n` +
    `Operator answer: ${input.clarification.answer}`;
}

export const answerTurnSchema: z.ZodType<{
  kind: "answer"; message: string; evidenceFiles: string[]; uncertainties: string[];
}> = z.strictObject({
  kind: z.literal("answer"),
  message: messageSchema,
  evidenceFiles: z.array(evidencePathSchema).min(1).max(64),
  uncertainties: z.array(messageSchema.max(500)).max(8),
});

export const clarificationTurnSchema: z.ZodType<{
  kind: "clarification"; question: string; reason: string;
}> = z.strictObject({
  kind: z.literal("clarification"),
  question: messageSchema.max(1_000),
  reason: messageSchema.max(1_000),
});

export const taskProposalTurnSchema: z.ZodType<{
  kind: "task_proposal"; proposal: z.infer<typeof taskProposalSchema>;
}> = z.strictObject({
  kind: z.literal("task_proposal"),
  proposal: taskProposalSchema,
});

export const continuedConversationTurnSchema: z.ZodType<
  z.infer<typeof answerTurnSchema> | z.infer<typeof taskProposalTurnSchema>
> = z.union([
  answerTurnSchema,
  taskProposalTurnSchema,
]);

export const conversationTurnSchema: z.ZodType<
  z.infer<typeof answerTurnSchema> | z.infer<typeof clarificationTurnSchema> | z.infer<typeof taskProposalTurnSchema>
> = z.union([
  answerTurnSchema,
  clarificationTurnSchema,
  taskProposalTurnSchema,
]);

export type AnswerTurn = z.infer<typeof answerTurnSchema>;
export type ClarificationTurn = z.infer<typeof clarificationTurnSchema>;
export type TaskProposalTurn = z.infer<typeof taskProposalTurnSchema>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type ConversationTurnKind = ConversationTurn["kind"];
