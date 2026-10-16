import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import { expect, test } from "bun:test";
import { contextUsage } from "../src/context-usage.ts";
import type { HistoryMessage } from "../src/loop.ts";

/** The session's context use, against Pi's token rules (#441). */
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
  const tokens = estimateTokens({ role: "system", content: systemPrompt, timestamp: 0 })
    + history.reduce((sum, message) => sum + estimateTokens(message), 0);
  expect(contextUsage([], systemPrompt, [], 1000)).toEqual({ tokens: 4, contextWindow: 1000, percent: 0.4 });
  expect(contextUsage(history, systemPrompt, [], 1000)).toEqual({ tokens, contextWindow: 1000, percent: (tokens / 1000) * 100 });
});

test("after a reply, reported total usage replaces the estimate, even past the window", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, input: 20, output: 10, cacheRead: 5, cacheWrite: 5, totalTokens: 125 };
  const tokens = calculateContextTokens(reply.usage);
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
  const tokens = calculateContextTokens(reply.usage) + trailing.reduce((sum, message) => sum + estimateTokens(message), 0);
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
    const tokens = calculateContextTokens(earlier.usage) + estimateTokens(failed);
    expect(contextUsage([earlier, failed], "system", [], 1000))
      .toEqual({ tokens, contextWindow: 1000, percent: (tokens / 1000) * 100 });
    const estimated = estimateTokens({ role: "system", content: "system", timestamp: 0 }) + estimateTokens(failed);
    expect(contextUsage([failed], "system", [], 1000))
      .toEqual({ tokens: estimated, contextWindow: 1000, percent: (estimated / 1000) * 100 });
  });
}

test("zero usage is estimated, or trails an earlier reply with usage", () => {
  const zero = fauxAssistantMessage("zero usage reply");
  const earlier = fauxAssistantMessage("earlier");
  earlier.usage = { ...earlier.usage, totalTokens: 40 };
  const estimated = estimateTokens({ role: "system", content: "system", timestamp: 0 }) + estimateTokens(zero);
  expect(contextUsage([zero], "system", [], 1000))
    .toEqual({ tokens: estimated, contextWindow: 1000, percent: (estimated / 1000) * 100 });
  const tokens = calculateContextTokens(earlier.usage) + estimateTokens(zero);
  expect(contextUsage([earlier, zero], "system", [], 1000))
    .toEqual({ tokens, contextWindow: 1000, percent: (tokens / 1000) * 100 });
});

test("when totalTokens is zero, all four usage components count", () => {
  const reply = fauxAssistantMessage("done");
  reply.usage = { ...reply.usage, input: 20, output: 10, cacheRead: 5, cacheWrite: 7, totalTokens: 0 };
  expect(calculateContextTokens(reply.usage)).toBe(42);
  expect(contextUsage([reply], "system", [], 1000)).toEqual({ tokens: 42, contextWindow: 1000, percent: 4.2 });
});

test("without a reply to count from, the tools the system message declares count as Pi estimates them", () => {
  const tools = [{ name: "lookup", description: "x".repeat(4000), parameters: { type: "object", properties: {} } }];
  const tokens = estimateTokens({ role: "system", content: "system", toolsAdded: tools, timestamp: 0 } as never);
  expect(contextUsage([], "system", tools, 10_000)).toEqual({ tokens, contextWindow: 10_000, percent: (tokens / 10_000) * 100 });
  expect(tokens).toBeGreaterThan(1000);
});
