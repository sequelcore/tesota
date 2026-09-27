import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openModelTarget } from "../src/integrations/model-session.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";
import { CodingSession } from "../src/integrations/pi-coding-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function credentials(): TesotaCredentials {
  const root = mkdtempSync(join(tmpdir(), "tesota-routes-"));
  roots.push(root);
  return new TesotaCredentials(join(root, "auth"));
}

it("sends each route to its engine and model", async () => {
  const store = credentials();
  expect(await openModelTarget("claude-code:opus", undefined, store)).toEqual({ engine: "claude-code", model: "opus" });
  const codex = await openModelTarget("codex:gpt-6-luna", undefined, store);
  expect(codex.engine === "pi" && [codex.model.provider, codex.model.id]).toEqual(["openai-codex", "gpt-6-luna"]);
  const anthropic = await openModelTarget("anthropic:claude-opus-5-5", undefined, store);
  expect(anthropic.engine === "pi" && [anthropic.model.provider, anthropic.model.id]).toEqual(["anthropic", "claude-opus-5-5"]);
  // A reasoning level travels with the target to either engine; without one, none is set and the engine's default applies.
  expect(await openModelTarget("claude-code:opus@xhigh", undefined, store))
    .toEqual({ engine: "claude-code", model: "opus", reasoning: "xhigh" });
  const astra = await openModelTarget("codex:gpt-6-astra@high", undefined, store);
  expect(astra.engine === "pi" && [astra.model.id, astra.reasoning]).toEqual(["gpt-6-astra", "high"]);
  expect(codex.reasoning).toBeUndefined();
});

it("refuses a choice that is not route:model, or a model the route does not have", async () => {
  const store = credentials();
  await expect(openModelTarget("gpt-6-luna", undefined, store)).rejects.toThrow("not a route:model choice");
  await expect(openModelTarget("codex:claude-opus-5-5", undefined, store)).rejects.toThrow("unavailable");
});

it("opens the gateway routes on Pi, with one OpenCode key for Zen and Go", async () => {
  const store = credentials();
  const router = await openModelTarget("openrouter:qwen/qwen3.8-27b:free", undefined, store);
  expect(router.engine === "pi" && [router.model.provider, router.model.id]).toEqual(["openrouter", "qwen/qwen3.8-27b:free"]);
  const zen = await openModelTarget("opencode:gpt-6-luna", undefined, store);
  expect(zen.engine === "pi" && [zen.model.provider, zen.model.id]).toEqual(["opencode", "gpt-6-luna"]);
  const go = await openModelTarget("opencode-go:glm-5.3@high", undefined, store);
  expect(go.engine === "pi" && [go.model.provider, go.model.id, go.reasoning]).toEqual(["opencode-go", "glm-5.3", "high"]);
  await store.modify("opencode", async () => ({ type: "api_key", key: "TEST_OPENCODE_KEY" }));
  expect(await store.read("opencode-go")).toEqual({ type: "api_key", key: "TEST_OPENCODE_KEY" });
});

/** A chat-completions endpoint that records each request's headers and answers "ok". */
async function recordingEndpoint(): Promise<{ url: string; headers: Record<string, string | string[] | undefined>[]; close: () => void }> {
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (body: object): string => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0,
        model: "m", ...body })}\n\n`;
      response.end(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }) +
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + "data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}/v1`, headers, close: () => { server.close(); } };
}

it("names Tesota, not Pi, to the gateways, and gives OpenCode the conversation it belongs to", async () => {
  const endpoint = await recordingEndpoint();
  const root = mkdtempSync(join(tmpdir(), "tesota-identity-"));
  roots.push(root);
  const store = credentials();
  await store.modify("opencode", async () => ({ type: "api_key", key: "TEST_OPENCODE_KEY" }));
  await store.modify("openrouter", async () => ({ type: "api_key", key: "TEST_OPENROUTER_KEY" }));
  try {
    for (const choice of ["opencode-go:glm-5.3", "openrouter:qwen/qwen3.8-27b:free"]) {
      const target = await openModelTarget(choice, undefined, store);
      if (target.engine !== "pi") throw new Error("expected Pi");
      const session = await CodingSession.start({ cwd: root, modelRuntime: target.modelRuntime,
        model: { ...target.model, baseUrl: endpoint.url }, systemPrompt: "Answer briefly.", tools: [] });
      expect((await session.run("Say ok.", new AbortController().signal)).status).toBe("completed");
      session.dispose();
    }
  } finally { endpoint.close(); }
  const [go, router] = endpoint.headers;
  expect(go?.["user-agent"]).toMatch(/^tesota\/\d+\.\d+\.\d+ \(/u);
  expect(go?.["x-opencode-client"]).toBe("tesota");
  expect(go?.["x-opencode-session"]).toMatch(/.+/u);
  expect(go?.["authorization"]).toBe("Bearer TEST_OPENCODE_KEY");
  expect(router?.["user-agent"]).toMatch(/^tesota\//u);
  // Pi's own attribution would list Tesota's calls under Pi on OpenRouter; Tesota sends none of its own yet.
  expect(router?.["http-referer"]).toBeUndefined();
  expect(router?.["x-openrouter-title"]).toBeUndefined();
  expect(router?.["authorization"]).toBe("Bearer TEST_OPENROUTER_KEY");
});
