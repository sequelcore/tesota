import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ContextUsage } from "./contract.js";

type EstimatedMessage = Message | { readonly role: "custom"; readonly content: string };

/** Pi's character estimate: text as written, and 1,200 tokens per image (#441). */
function contentChars(content: string | readonly (TextContent | ImageContent)[]): number {
  return typeof content === "string" ? content.length
    : content.reduce((chars, part) => chars + (part.type === "image" ? 4800 : part.text.length), 0);
}

/** Pi rounds each message's character estimate up separately (#441). */
export function estimateTokens(message: EstimatedMessage): number {
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
export function contextUsage(history: readonly EstimatedMessage[], systemPrompt: string, tools: readonly object[],
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

/** How much of the window each part of the context takes (#779), in Pi's estimate of a quarter of the characters, rounded up. */
export interface ContextBreakdown {
  readonly contextWindow: number;
  /** The prompt's own text: what it says of the agent and its tools, without the memory files and skills it carries. */
  readonly systemPrompt: number;
  readonly tools: number;
  readonly mcpTools: number;
  readonly memoryFiles: readonly { readonly path: string; readonly tokens: number }[];
  readonly skills: number;
  readonly messages: number;
  readonly free: number;
  /** What the last reply read from the provider's cache; none before a reply. */
  readonly cached?: number;
}

/** What `/context` shows (#779): the prompt as sent, split into the memory `files` and skill `catalog` it holds, the tools and the conversation. */
export function contextBreakdown(parts: { readonly prompt: string; readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly catalog: string; readonly tools: readonly { readonly name: string }[]; readonly history: readonly EstimatedMessage[];
  readonly contextWindow: number }): ContextBreakdown {
  const quarter = (chars: number): number => Math.ceil(chars / 4);
  const declared = (tools: readonly object[]): number => tools.length === 0 ? 0 : quarter(JSON.stringify(tools).length);
  const memoryFiles = parts.files.map(({ path, content }) => ({ path, tokens: quarter(content.length) }));
  const held = parts.files.reduce((chars, { content }) => chars + content.length, 0) + parts.catalog.length;
  const breakdown = {
    systemPrompt: quarter(Math.max(0, parts.prompt.length - held)),
    tools: declared(parts.tools.filter(({ name }) => !name.startsWith("mcp__"))),
    mcpTools: declared(parts.tools.filter(({ name }) => name.startsWith("mcp__"))),
    skills: quarter(parts.catalog.length),
    messages: parts.history.reduce((tokens, message) => tokens + estimateTokens(message), 0),
  };
  const used = Object.values(breakdown).reduce((sum, tokens) => sum + tokens, 0) + memoryFiles.reduce((sum, { tokens }) => sum + tokens, 0);
  const last = parts.history.findLast((message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted");
  return { contextWindow: parts.contextWindow, ...breakdown, memoryFiles, free: Math.max(0, parts.contextWindow - used),
    ...last?.role === "assistant" ? { cached: last.usage.cacheRead } : {} };
}

/** `/context`'s text (#779): the total, one line per part with the memory files by name, MCP tools only when there are some, and the cache. */
export function contextReport(breakdown: ContextBreakdown): string {
  const count = (tokens: number): string => tokens.toLocaleString("en-US");
  const line = (label: string, tokens: number, detail = ""): string =>
    `  ${label.padEnd(13)}${count(tokens).padStart(9)}${detail === "" ? "" : `  ${detail}`}`;
  const memory = breakdown.memoryFiles.reduce((sum, { tokens }) => sum + tokens, 0);
  const used = breakdown.systemPrompt + breakdown.tools + breakdown.mcpTools + memory + breakdown.skills + breakdown.messages;
  return [
    `Context: ${count(used)} of ${count(breakdown.contextWindow)} tokens (${Math.round((used / breakdown.contextWindow) * 100)}%), `
      + "estimated at a quarter of the characters.",
    line("System prompt", breakdown.systemPrompt),
    line("Tools", breakdown.tools),
    ...breakdown.mcpTools === 0 ? [] : [line("MCP tools", breakdown.mcpTools)],
    line("Memory files", memory, breakdown.memoryFiles.map(({ path, tokens }) => `${path} ${count(tokens)}`).join(" · ")),
    line("Skills", breakdown.skills),
    line("Messages", breakdown.messages),
    line("Free", breakdown.free),
    ...breakdown.cached === undefined ? [] : [`The last reply read ${count(breakdown.cached)} tokens from the provider's cache.`],
  ].join("\n");
}
