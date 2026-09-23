import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, CredentialStore, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  createOpaquePiReviewer,
  OPAQUE_PI_REVIEWER_FAILURE,
  OPAQUE_PI_REVIEWER_LIMITS,
  OpaquePiReviewerError,
  REVIEW_CODEX_MODEL_ID,
} from "../src/integrations/pi-opaque-reviewer.js";

const model: Model<"openai-codex-responses"> = {
  id: REVIEW_CODEX_MODEL_ID,
  name: "Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 16_384,
};

const credentials: CredentialStore = {
  read: async () => undefined,
  list: async () => [],
  modify: async (_id, fn) => await fn(undefined),
  delete: async () => undefined,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: REVIEW_CODEX_MODEL_ID,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  };
}

function completedStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "length", message });
  stream.end(message);
  return stream;
}

function reviewer(stream: ReturnType<typeof createAssistantMessageEventStream>) {
  const getModel = vi.fn((_provider: string, _id: string): Model<Api> => model);
  const streamSimple = vi.fn((_model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => stream);
  const resolveModels = vi.fn(async (_credentials: CredentialStore, _signal: AbortSignal) => ({ getModel, streamSimple }));
  return {
    run: createOpaquePiReviewer({ credentials, resolveModels }),
    getModel,
    streamSimple,
    resolveModels,
  };
}

it("passes exact valid UTF-8 prompt bytes to direct, tool-free Pi inference and returns only output bytes", async () => {
  const prompt = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("review\u0000\r\n", "utf8")]);
  const output = "provider result\r\n";
  const fake = reviewer(completedStream(assistant([{ type: "text", text: output }])));

  const result = await fake.run(prompt, { timeoutMs: 1_000 });

  expect(result).toStrictEqual({
    stdout: Buffer.from(output, "utf8"),
    promptByteLength: prompt.length,
    stdoutByteLength: Buffer.byteLength(output, "utf8"),
  });
  expect(fake.getModel).toHaveBeenCalledWith("openai-codex", REVIEW_CODEX_MODEL_ID);
  expect(fake.streamSimple).toHaveBeenCalledTimes(1);
  const call = fake.streamSimple.mock.calls[0];
  if (call === undefined) throw new Error("Expected a Pi stream call");
  const [requestedModel, context, options] = call;
  expect(requestedModel).toBe(model);
  expect(context).toStrictEqual({
    messages: [{ role: "user", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(prompt), timestamp: expect.any(Number) }],
  });
  expect(options).toMatchObject({ maxRetries: 0, maxTokens: 16_384, timeoutMs: 1_000,
    transport: "sse", cacheRetention: "none" });
  expect(context.tools).toBeUndefined();
});

it("rejects invalid or oversized prompt bytes before credentials or inference", async () => {
  const fake = reviewer(completedStream(assistant([{ type: "text", text: "unused" }])));

  await expect(fake.run(Buffer.from([0xff]))).rejects.toMatchObject({
    kind: OPAQUE_PI_REVIEWER_FAILURE.INVALID_PROMPT,
  } satisfies Partial<OpaquePiReviewerError>);
  await expect(fake.run(Buffer.alloc(OPAQUE_PI_REVIEWER_LIMITS.promptBytes + 1))).rejects.toMatchObject({
    kind: OPAQUE_PI_REVIEWER_FAILURE.PROMPT_TOO_LARGE,
  } satisfies Partial<OpaquePiReviewerError>);
  expect(fake.resolveModels).not.toHaveBeenCalled();
});

it.each([
  ["empty", assistant([]), OPAQUE_PI_REVIEWER_FAILURE.INVALID_OUTPUT],
  ["thinking", assistant([{ type: "thinking", thinking: "hidden" }]), OPAQUE_PI_REVIEWER_FAILURE.INVALID_OUTPUT],
  ["length", assistant([{ type: "text", text: "partial" }], "length"), OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_FAILED],
  ["oversized", assistant([{ type: "text", text: "x".repeat(OPAQUE_PI_REVIEWER_LIMITS.stdoutBytes + 1) }]), OPAQUE_PI_REVIEWER_FAILURE.OUTPUT_TOO_LARGE],
] as const)("fails closed on %s provider output", async (_name, message, kind) => {
  const fake = reviewer(completedStream(message));
  await expect(fake.run(Buffer.from("prompt"))).rejects.toMatchObject({ kind } satisfies Partial<OpaquePiReviewerError>);
});

it("returns after its local timeout when a provider stream never settles", async () => {
  const stream = createAssistantMessageEventStream();
  let requestSignal: AbortSignal | undefined;
  const fake = reviewer(stream);
  fake.streamSimple.mockImplementation((_model, _context, options) => {
    requestSignal = options?.signal;
    return stream;
  });

  await expect(fake.run(Buffer.from("prompt"), { timeoutMs: 20 })).rejects.toMatchObject({
    kind: OPAQUE_PI_REVIEWER_FAILURE.TIMED_OUT,
  } satisfies Partial<OpaquePiReviewerError>);
  expect(requestSignal?.aborted).toBe(true);
});

it("honors caller cancellation before resolving credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = reviewer(completedStream(assistant([{ type: "text", text: "unused" }])));

  await expect(fake.run(Buffer.from("prompt"), { signal: controller.signal })).rejects.toMatchObject({
    kind: OPAQUE_PI_REVIEWER_FAILURE.CANCELLED,
  } satisfies Partial<OpaquePiReviewerError>);
  expect(fake.resolveModels).not.toHaveBeenCalled();
});

it("ignores provider reasoning events while preserving final text output", async () => {
  const stream = createAssistantMessageEventStream();
  const partial = assistant([{ type: "thinking", thinking: "private" }]);
  const message = assistant([{ type: "text", text: "review result" }]);
  stream.push({ type: "start", partial });
  stream.push({ type: "thinking_start", contentIndex: 0, partial });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "private", partial });
  stream.push({ type: "thinking_end", contentIndex: 0, content: "private", partial });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  const fake = reviewer(stream);

  await expect(fake.run(Buffer.from("prompt"))).resolves.toMatchObject({ stdout: Buffer.from("review result") });
});
