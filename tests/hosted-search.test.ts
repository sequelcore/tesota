import { afterEach, expect, it, vi } from "vitest";
import type { ModelTarget } from "../src/integrations/model-session.js";

const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], messages: [] as unknown[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (actual) => ({
  ...await actual<object>(),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    return (async function* () { yield* sdk.messages; })();
  },
}));

const { citedAddresses, claudeSearchResult, responsesSearchEvent, hostedSearch } = await import("../src/integrations/hosted-search.js");

afterEach(() => { sdk.options.length = 0; sdk.messages.length = 0; });
const running = (): AbortSignal => new AbortController().signal;

/** A Pi target whose one model call replays these provider events and answers with this text. */
function codex(events: unknown[], answer: string, stopReason = "stop"): { target: ModelTarget; payloads: unknown[] } {
  const payloads: unknown[] = [];
  const modelRuntime = {
    streamSimple: (_model: unknown, _context: unknown, options: { onPayload: (body: unknown) => unknown;
      onProviderStreamEvent: (event: unknown) => void }) => ({
      result: async () => {
        payloads.push(options.onPayload({ model: "gpt-6-luna", tools: [], include: ["reasoning.encrypted_content"] }));
        for (const event of events) options.onProviderStreamEvent(event);
        return { content: [{ type: "text", text: answer }], stopReason, errorMessage: stopReason === "error" ? "usage limit" : undefined,
          usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 } };
      },
    }),
  };
  return { target: { engine: "pi", route: "chatgpt", modelRuntime, model: {} } as unknown as ModelTarget, payloads };
}

const searchDone = (action: Record<string, unknown>) => ({ type: "response.output_item.done", item: { type: "web_search_call", action } });
const citation = (url: string, title: string) => ({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url, title } });

it("adds Codex's own search to the request and checks the answer's citations against what the search found", async () => {
  const { target, payloads } = codex([
    searchDone({ type: "search", query: "bun latest", sources: [{ type: "url", url: "https://github.com/oven-sh/bun/releases" }] }),
    searchDone({ type: "open_page", url: "https://bun.sh/" }),
    citation("https://bun.sh/?utm_source=openai", "Bun"), citation("https://made-up.example/", "Made up"),
  ], "Bun 1.4.2 ([bun.sh](https://bun.sh/?utm_source=openai)).");
  let tokens = 0;
  const outcome = await hostedSearch("chatgpt:gpt-6-luna", async () => target).search("bun latest", 5, running(),
    (usage) => { tokens += usage.input + usage.output; });
  expect(payloads).toEqual([{ model: "gpt-6-luna", tools: [{ type: "web_search" }],
    include: ["reasoning.encrypted_content", "web_search_call.action.sources"] }]);
  expect(outcome).toEqual({ status: "ok", provider: "chatgpt:gpt-6-luna", findings: "Bun 1.4.2 ([bun.sh](https://bun.sh/?utm_source=openai)).",
    results: [{ title: "Bun", url: "https://bun.sh/?utm_source=openai", snippet: "Cited in the findings" },
      { title: "https://github.com/oven-sh/bun/releases", url: "https://github.com/oven-sh/bun/releases", snippet: "" }],
    unverified: ["https://made-up.example/"] });
  expect(tokens).toBe(1000);
});

it("reports a stopped search as the provider's failure, naming the searcher", async () => {
  const { target } = codex([], "", "error");
  expect(await hostedSearch("chatgpt-work:gpt-6-luna", async () => target).search("x", 5, running()))
    .toEqual({ status: "failed", error: "provider_failed", detail: "chatgpt-work:gpt-6-luna: usage limit" });
  expect(await hostedSearch("chatgpt:gpt-6-luna", async () => { throw new Error("not signed in"); }).search("x", 5, running()))
    .toMatchObject({ status: "failed", detail: "chatgpt:gpt-6-luna: not signed in" });
});

it("runs Claude Code with WebSearch as its only tool, and keeps only citations its search found", async () => {
  sdk.messages.push(
    { type: "user", tool_use_result: { query: "bun", results: [{ tool_use_id: "s1", content: [
      { title: "Bun v1.4.2", url: "https://bun.com/blog/bun-v1.4.2" }, { title: "Bun", url: "https://bun.com/" }] }, "summary text"] } },
    { type: "result", subtype: "success", result: "Bun 1.4.2. Sources: [Bun v1.4.2](https://bun.com/blog/bun-v1.4.2), https://elsewhere.example/x.",
      modelUsage: { haiku: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  const target: ModelTarget = { engine: "claude-code", route: "claude-2", model: "haiku", configDirectory: "C:/claude-2" };
  const outcome = await hostedSearch("claude-2:haiku", async () => target).search("bun", 5, running());
  expect(sdk.options[0]).toMatchObject({ model: "haiku", tools: ["WebSearch"], settingSources: [], skills: [], strictMcpConfig: true });
  expect(sdk.options[0]?.["mcpServers"]).toBeUndefined();
  expect(sdk.options[0]?.["env"]).toMatchObject({ CLAUDE_CONFIG_DIR: "C:/claude-2" });
  const gate = sdk.options[0]?.["canUseTool"] as (name: string, input: unknown) => Promise<{ behavior: string }>;
  expect((await gate("WebSearch", {})).behavior).toBe("allow");
  expect((await gate("Bash", {})).behavior).toBe("deny");
  expect(outcome).toMatchObject({ status: "ok", provider: "claude-2:haiku", unverified: ["https://elsewhere.example/x"],
    results: [{ title: "Bun v1.4.2", url: "https://bun.com/blog/bun-v1.4.2", snippet: "Cited in the findings" },
      { title: "Bun", url: "https://bun.com/", snippet: "" }] });
});

it("reads sources only from the events and results that carry them", () => {
  const found: { url: string }[] = [];
  const cited: { url: string }[] = [];
  responsesSearchEvent({ type: "response.output_item.done", item: { type: "message", action: { url: "https://x.example/" } } }, found, cited);
  responsesSearchEvent({ type: "response.output_text.annotation.added", annotation: { type: "file_citation", url: "https://y.example/" } }, found, cited);
  responsesSearchEvent("not an event", found, cited);
  claudeSearchResult({ type: "assistant" } as never, found);
  expect([found, cited]).toEqual([[], []]);
  expect(citedAddresses("See [docs](https://a.example/d) and https://b.example/e, then (https://c.example/f).").map((source) => source.url))
    .toEqual(["https://a.example/d", "https://b.example/e", "https://c.example/f"]);
});
