import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/session.ts";
import { accepts } from "./scripted.ts";

for (const status of [429, 400]) test(`real OpenAI adapter preserves retry evidence for HTTP ${status}`, async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    calls++;
    return Response.json({ error: { message: status === 429 ? "too many requests" : "invalid max_output_tokens: got 150000", type: status === 429 ? "rate_limit_error" : "invalid_request_error" } },
      { status, headers: { "Retry-After": "121" } });
  } });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-local-key" }));
  const models = createModels({ credentials });
  const provider = openaiProvider();
  models.setProvider(provider);
  const first = provider.getModels()[0];
  if (first === undefined) throw new Error("No OpenAI fixture model");
  const model = { ...first, baseUrl: `${server.url}v1` };
  const cwd = mkdtempSync(join(tmpdir(), "tesota-retry-http-"));
  const session = createSession({ cwd, folder: join(cwd, "sessions"), models, model, verifier: accepts });
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("error");
    expect(calls).toBe(1);
  } finally { await session.dispose(); await server.stop(true); }
});

// pi-ai 1.3.0's Google adapters discard failed-response headers and reject per-call fetch.
// This deliberately documents the limit: only exposed Retry-After can be honored.
for (const makeProvider of [googleProvider, googleVertexProvider]) for (const status of [429, 400]) test(`${makeProvider.name}: missing Retry-After uses bounded engine backoff; HTTP ${status}`, async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    calls++;
    return Response.json({ error: { code: status, status: status === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
      message: status === 429 ? "too many requests" : "invalid max_output_tokens: got 150000" } },
      { status, headers: { "Retry-After": "121" } });
  } });
  const credentials = new InMemoryCredentialStore();
  const provider = makeProvider();
  await credentials.modify(provider.id, async () => ({ type: "api_key", key: "synthetic-local-key" }));
  const models = createModels({ credentials });
  models.setProvider(provider);
  const first = provider.getModels()[0];
  if (first === undefined) throw new Error("No Google fixture model");
  const model = { ...first, baseUrl: `${server.url}v1beta` };
  const cwd = mkdtempSync(join(tmpdir(), "tesota-retry-google-"));
  const session = createSession({ cwd, folder: join(cwd, "sessions"), models, model, verifier: accepts });
  const waits: number[] = [];
  session.subscribe((event) => { if (event.type === "retry" && event.delayMs > 0) waits.push(event.delayMs); });
  try {
    await session.prompt("Answer");
    expect(session.outcome()).toBe("error");
    expect(calls).toBe(status === 429 ? 4 : 1);
    expect(waits).toEqual(status === 429 ? [1000, 2000, 4000] : []);
  } finally { await session.dispose(); await server.stop(true); }
});
