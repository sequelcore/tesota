import type { ClarificationQuestion } from "../../../../src/clarification.ts";
import type { QuestionOutcome } from "../questions.ts";
import { questionParameters as parameters, validateQuestions } from "../questions-schema.ts";
import type { EngineTool } from "../tool.ts";
import { clarificationText } from "../../../../src/clarification.ts";

export interface AskHost { ask(questions: readonly ClarificationQuestion[], signal: AbortSignal, callId: string): Promise<QuestionOutcome> }
const nativeTools = new WeakSet<object>();

/** Whether a tool is this module's built-in host bridge, never merely a matching name. */
export const isNativeAskTool = (tool: EngineTool): boolean => nativeTools.has(tool);

/** Tesota's native structured clarification tool. */
export function askTool(host: AskHost): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "ask_user", access: "read", parameters,
    description: "Ask the operator one to three focused questions when the answer materially changes the next action. Offer two to four choices each; the operator may add text. A choice is not permission to execute consequential actions.",
    async execute({ questions }, signal, callId) {
      const invalid = validateQuestions(questions);
      if (invalid !== undefined) return { isError: true, text: invalid };
      const outcome = await host.ask(questions, signal, callId);
      if (outcome.status === "answered") return { isError: false,
        text: clarificationText({ questions, answers: outcome.answers }) };
      return { isError: true, text: outcome.reason };
    },
  };
  const native = tool as EngineTool;
  nativeTools.add(native);
  return native;
}
