import type { ConversationMessage } from "../../../src/contract.ts";

/** What a message of either engine holds, as far as the conversation shows it. */
interface MessageLike {
  readonly role: string;
  readonly content?: unknown;
  readonly customType?: unknown;
  readonly toolName?: unknown;
  readonly isError?: unknown;
}

/** The text of a message's content: a string, or its text parts joined. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((part: unknown) => typeof part === "object" && part !== null && "type" in part && part.type === "text"
    && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
}

/** A message as the conversation shows it, with only the fields it has. */
export function conversationMessage(message: MessageLike): ConversationMessage {
  const text = textOf(message.content);
  return {
    role: message.role,
    ...typeof message.customType === "string" ? { customType: message.customType } : {},
    ...typeof message.toolName === "string" ? { toolName: message.toolName } : {},
    ...typeof message.isError === "boolean" ? { isError: message.isError } : {},
    ...text === undefined ? {} : { text },
  };
}
