import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContextUsage } from "../../../src/contract.ts";
import type { HistoryMessage } from "./loop.ts";

/** Pi's character estimate: text as written, and 1,200 tokens per image (#441). */
function contentChars(content: string | readonly (TextContent | ImageContent)[]): number {
  return typeof content === "string" ? content.length
    : content.reduce((chars, part) => chars + (part.type === "image" ? 4800 : part.text.length), 0);
}

/** Pi rounds each message's character estimate up separately (#441). */
export function estimateTokens(message: HistoryMessage): number {
  let chars = 0;
  if (message.role === "assistant") {
    for (const part of message.content) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "thinking") chars += part.thinking.length;
      else chars += part.name.length + JSON.stringify(part.arguments).length;
    }
  } else {
    chars = contentChars(message.content);
    if (message.role === "system") {
      for (const section of Object.values(message.sections ?? {})) chars += section?.length ?? 0;
      if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * The context window's use, by Pi's token rules (#441). Without a reply to
 * count from, the system message is estimated with the tools it declares, as
 * Pi estimates it. Replies before `counted` were answers to a conversation
 * compaction has since replaced (#451), so their usage counts nothing now.
 */
export function contextUsage(history: readonly HistoryMessage[], systemPrompt: string, tools: readonly object[],
  contextWindow: number | undefined, counted = 0): ContextUsage | undefined {
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  let trailing = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message === undefined) continue;
    if (index >= counted && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
      const usage = message.usage;
      const used = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      if (used > 0) {
        const tokens = used + trailing;
        return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
      }
    }
    trailing += estimateTokens(message);
  }
  const tokens = Math.ceil((systemPrompt.length + (tools.length > 0 ? JSON.stringify(tools).length : 0)) / 4) + trailing;
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}
