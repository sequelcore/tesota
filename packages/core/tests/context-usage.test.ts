import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { contextBreakdown, contextReport, contextUsage } from "../../../src/context-usage.js";
import type { HistoryMessage } from "../src/loop.ts";

/**
 * The session's context use, by Pi's token rules (#441): each number below is
 * what Pi 1.3.0's `estimateTokens` and `calculateContextTokens` gave for the
 * same messages, a quarter of the characters rounded up per message, an image
 * as 1,200 tokens.
 */
test("without a positive context window, usage is unknown", () => {
  for (const window of [undefined, 0, -1]) expect(contextUsage([], "system", [], window)).toBeUndefined();
});

test("a fresh session estimates the system prompt and each message separately", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "hello", timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "x" }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 0 },
    { role: "custom", customType: "note", content: "hidden", display: false, details: { ignored: "x".repeat(100) }, timestamp: 0 },
  ];
  const systemPrompt = "system prompt";
  const tokens = 1209;
  expect(contextUsage([], systemPrompt, [], 1000)).toEqual({ tokens: 4, contextWindow: 1000, percent: 0.4 });
  expect(contextUsage(history, systemPrompt, [], 1000)).toEqual({ tokens, contextWindow: 1000, percent: (tokens / 1000) * 100 });
});

test("after a reply, reported total usage replaces the estimate, even past the window", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, input: 20, output: 10, cacheRead: 5, cacheWrite: 5, totalTokens: 125 };
  const tokens = 125;
  expect(contextUsage([{ role: "user", content: "before", timestamp: 0 }, reply], "a long system prompt", [], 100))
    .toEqual({ tokens, contextWindow: 100, percent: 125 });
});

test("tool results and custom messages after the last valid reply add their estimates", () => {
  const earlier = fauxAssistantMessage("earlier");
  earlier.usage = { ...earlier.usage, totalTokens: 900 };
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, totalTokens: 20 };
  const trailing: HistoryMessage[] = [
    { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 0 },
    { role: "toolResult", toolCallId: "read-2", toolName: "read", content: [{ type: "image", data: "", mimeType: "image/png" }], isError: true, timestamp: 0 },
    { role: "custom", customType: "send-back", content: "try again", display: false, timestamp: 0 },
  ];
  const tokens = 1225;
  expect(contextUsage([earlier, reply, ...trailing], "ignored once usage is known", [], 4096))
    .toEqual({ tokens, contextWindow: 4096, percent: (tokens / 4096) * 100 });
});

for (const stopReason of ["error", "aborted"] as const) {
  test("a last reply with " + stopReason + " is estimated after the earlier valid usage", () => {
    const earlier = fauxAssistantMessage("earlier");
    earlier.usage = { ...earlier.usage, totalTokens: 100 };
    const failed = fauxAssistantMessage([
      { type: "text", text: "partial" },
      { type: "thinking", thinking: "reasoning" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.txt" } },
    ], { stopReason });
    failed.usage = { ...failed.usage, totalTokens: 900 };
    const tokens = 110;
    expect(contextUsage([earlier, failed], "system", [], 1000))
      .toEqual({ tokens, contextWindow: 1000, percent: (tokens / 1000) * 100 });
    const estimated = 12;
    expect(contextUsage([failed], "system", [], 1000))
      .toEqual({ tokens: estimated, contextWindow: 1000, percent: (estimated / 1000) * 100 });
  });
}

test("zero usage is estimated, or trails an earlier reply with usage", () => {
  const zero = fauxAssistantMessage("zero usage reply");
  const earlier = fauxAssistantMessage("earlier");
  earlier.usage = { ...earlier.usage, totalTokens: 40 };
  const estimated = 6;
  expect(contextUsage([zero], "system", [], 1000))
    .toEqual({ tokens: estimated, contextWindow: 1000, percent: (estimated / 1000) * 100 });
  const tokens = 44;
  expect(contextUsage([earlier, zero], "system", [], 1000))
    .toEqual({ tokens, contextWindow: 1000, percent: (tokens / 1000) * 100 });
});

test("when totalTokens is zero, all four usage components count", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, input: 20, output: 10, cacheRead: 5, cacheWrite: 7, totalTokens: 0 };
  expect(contextUsage([reply], "system", [], 1000)).toEqual({ tokens: 42, contextWindow: 1000, percent: 4.2 });
});

test("without a reply to count from, the tools the system message declares count as Pi estimates them", () => {
  const tools = [{ name: "lookup", description: "x".repeat(4000), parameters: { type: "object", properties: {} } }];
  const tokens = 1023;
  expect(contextUsage([], "system", tools, 10_000)).toEqual({ tokens, contextWindow: 10_000, percent: (tokens / 10_000) * 100 });
  expect(tokens).toBeGreaterThan(1000);
});

test("/context splits the window by what fills it: prompt, tools, MCP tools, memory files, skills, messages and what is free (#779)", () => {
  // 100 characters of the prompt's own text, a 40-character memory file and a 20-character skill catalog, as the prompt holds them.
  const prompt = `${"P".repeat(100)}${"F".repeat(40)}${"S".repeat(20)}`;
  const tools = [{ name: "read", description: "d", parameters: {} }, { name: "mcp__x__y", description: "d", parameters: {} }];
  const history: HistoryMessage[] = [{ role: "user", content: "hello", timestamp: 0 }];
  expect(contextBreakdown({ prompt, files: [{ path: "AGENTS.md", content: "F".repeat(40) }], catalog: "S".repeat(20), tools, history,
    contextWindow: 1000 })).toEqual({
    contextWindow: 1000, systemPrompt: 25, tools: 13, mcpTools: 14, memoryFiles: [{ path: "AGENTS.md", tokens: 10 }], skills: 5,
    messages: 2, free: 931,
  });
});

test("/context says how much the last reply read from the provider's cache, and nothing before a reply (#779)", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, cacheRead: 300 };
  const failed = fauxAssistantMessage("broke", { stopReason: "error" });
  const parts = { prompt: "", files: [], catalog: "", tools: [], contextWindow: 1000 };
  expect(contextBreakdown({ ...parts, history: [{ role: "user", content: "go", timestamp: 0 }] })).not.toHaveProperty("cached");
  expect(contextBreakdown({ ...parts, history: [{ role: "user", content: "go", timestamp: 0 }, reply, failed] }).cached).toBe(300);
});

test("/context reads as one line per part, the memory files by name, and what the cache held (#779)", () => {
  expect(contextReport({ contextWindow: 200_000, systemPrompt: 1_250, tools: 1_170, mcpTools: 0,
    memoryFiles: [{ path: "~/.agents/AGENTS.md", tokens: 1_100 }, { path: "AGENTS.md", tokens: 567 }], skills: 2_533, messages: 12_380,
    free: 181_000, cached: 18_018 })).toBe([
    "Context: 19,000 of 200,000 tokens (10%), estimated at a quarter of the characters.",
    "  System prompt    1,250",
    "  Tools            1,170",
    "  Memory files     1,667  ~/.agents/AGENTS.md 1,100 · AGENTS.md 567",
    "  Skills           2,533",
    "  Messages        12,380",
    "  Free           181,000",
    "The last reply read 18,018 tokens from the provider's cache.",
  ].join("\n"));
});

test("after a reply, /context takes the total the provider counted and shows what no part accounts for as not attributed (#779)", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, totalTokens: 900 };
  const history: HistoryMessage[] = [{ role: "user", content: "hello", timestamp: 0 }, reply, { role: "user", content: "again", timestamp: 0 }];
  // Parts: a 400-character prompt (100), and messages "hello" (2), "done" (1) and "again" (2); the provider counted 900 up to the reply.
  expect(contextBreakdown({ prompt: "P".repeat(400), files: [], catalog: "", tools: [], history, contextWindow: 1000 })).toMatchObject({
    systemPrompt: 100, messages: 5, counted: 902, notAttributed: 797, free: 98,
  });
});

test("when the parts' estimate passes what the provider counted, nothing is left unattributed (#779)", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, totalTokens: 50 };
  // A 400-character prompt is estimated at 100 tokens, past the 50 the provider counted.
  expect(contextBreakdown({ prompt: "P".repeat(400), files: [], catalog: "", tools: [], history: [reply], contextWindow: 1000 }))
    .toMatchObject({ systemPrompt: 100, counted: 50, notAttributed: 0, free: 899 });
});

test("after a reply, /context's total is the provider's count, with what no part accounts for on its own line (#779)", () => {
  expect(contextReport({ contextWindow: 200_000, systemPrompt: 283, tools: 1_750, mcpTools: 0,
    memoryFiles: [{ path: "AGENTS.md", tokens: 567 }], skills: 2_533, messages: 5, free: 190_469, cached: 3_293,
    counted: 9_531, notAttributed: 4_393 })).toBe([
    "Context: 9,531 of 200,000 tokens (5%), counted by the provider at the last reply; parts estimated at a quarter of the characters.",
    "  System prompt      283",
    "  Tools            1,750",
    "  Memory files       567  AGENTS.md 567",
    "  Skills           2,533",
    "  Messages             5",
    "  Not attributed   4,393  such as the provider's own framing",
    "  Free           190,469",
    "The last reply read 3,293 tokens from the provider's cache.",
  ].join("\n"));
});
