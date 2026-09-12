import * as z from "zod";
import { modelTextSchema, taskProposalSchema, validProposalPath } from "./task-proposal-contract.js";

const messageSchema = modelTextSchema(4_000);
const evidencePathSchema = z.string().min(1).max(512).refine(validProposalPath);

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
