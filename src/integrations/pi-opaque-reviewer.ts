import { CodexCredentials } from "./codex-credentials.js";
import { storedCodexModels } from "./pi-live.js";
import type { CredentialStore, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";

/** Gentle 2.8's reviewer route stays fixed independently of Tesota's task model. */
export const REVIEW_CODEX_MODEL_ID = "gpt-5.6-luna";

/** The relay passes bytes; this adapter admits only a bounded, valid UTF-8 prompt. */
export const OPAQUE_PI_REVIEWER_LIMITS: Readonly<{
  promptBytes: number;
  stdoutBytes: number;
  timeoutMs: number;
}> = Object.freeze({ promptBytes: 2 * 1024 * 1024, stdoutBytes: 2 * 1024 * 1024, timeoutMs: 600_000 });

export const OPAQUE_PI_REVIEWER_FAILURE = {
  CANCELLED: "cancelled",
  INVALID_PROMPT: "invalid-prompt",
  PROMPT_TOO_LARGE: "prompt-too-large",
  MODEL_UNAVAILABLE: "model-unavailable",
  PROVIDER_FAILED: "provider-failed",
  PROVIDER_ABORTED: "provider-aborted",
  INVALID_OUTPUT: "invalid-output",
  OUTPUT_TOO_LARGE: "output-too-large",
  TIMED_OUT: "timed-out",
} as const;

export type OpaquePiReviewerFailureKind =
  (typeof OPAQUE_PI_REVIEWER_FAILURE)[keyof typeof OPAQUE_PI_REVIEWER_FAILURE];

/** A transport-only failure. Provider diagnostics and prompt content never cross this boundary. */
export class OpaquePiReviewerError extends Error {
  readonly kind: OpaquePiReviewerFailureKind;

  constructor(kind: OpaquePiReviewerFailureKind, message: string) {
    super(message);
    this.name = "OpaquePiReviewerError";
    this.kind = kind;
  }
}

export interface OpaquePiReviewerOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface OpaquePiReviewerResult {
  readonly stdout: Buffer;
  readonly promptByteLength: number;
  readonly stdoutByteLength: number;
}

interface OpaquePiModels {
  getModel(provider: string, id: string): Model<import("@earendil-works/pi-ai").Api> | undefined;
  streamSimple(
    model: Model<import("@earendil-works/pi-ai").Api>,
    context: import("@earendil-works/pi-ai").Context,
    options?: SimpleStreamOptions,
  ): AsyncIterable<import("@earendil-works/pi-ai").AssistantMessageEvent>;
}

export interface OpaquePiReviewerDependencies {
  readonly credentials: CredentialStore;
  readonly resolveModels: (credentials: CredentialStore, signal: AbortSignal) => Promise<OpaquePiModels>;
}

function failure(kind: OpaquePiReviewerFailureKind, message: string): OpaquePiReviewerError {
  return new OpaquePiReviewerError(kind, message);
}

function decodePrompt(prompt: Buffer): string {
  if (prompt.byteLength > OPAQUE_PI_REVIEWER_LIMITS.promptBytes) {
    throw failure(OPAQUE_PI_REVIEWER_FAILURE.PROMPT_TOO_LARGE, "Pi reviewer prompt exceeds the byte bound");
  }
  try {
    // ignoreBOM retains a provider-issued BOM. Re-encoding confirms that valid
    // UTF-8 reaches Pi with precisely the original byte sequence.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(prompt);
    if (!Buffer.from(text, "utf8").equals(prompt)) {
      throw new Error("UTF-8 round trip changed bytes");
    }
    return text;
  } catch {
    throw failure(OPAQUE_PI_REVIEWER_FAILURE.INVALID_PROMPT, "Pi reviewer prompt is not valid UTF-8");
  }
}

function resolveTimeout(timeoutMs: number | undefined): number {
  const requested = timeoutMs ?? OPAQUE_PI_REVIEWER_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError("Pi reviewer timeout must be a positive integer");
  }
  return Math.min(requested, OPAQUE_PI_REVIEWER_LIMITS.timeoutMs);
}

function validateOutput(message: import("@earendil-works/pi-ai").AssistantMessage): Buffer {
  if (message.stopReason !== "stop") {
    throw failure(
      message.stopReason === "aborted" ? OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_ABORTED : OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_FAILED,
      message.stopReason === "aborted" ? "Pi reviewer was aborted by its provider" : "Pi reviewer did not complete normally",
    );
  }
  if (message.content.length === 0 || message.content.some((block) => block.type !== "text" && block.type !== "thinking")) {
    throw failure(OPAQUE_PI_REVIEWER_FAILURE.INVALID_OUTPUT, "Pi reviewer returned empty or non-text output");
  }
  const stdout = Buffer.from(message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""), "utf8");
  if (stdout.length === 0) throw failure(OPAQUE_PI_REVIEWER_FAILURE.INVALID_OUTPUT, "Pi reviewer returned empty output");
  if (stdout.length > OPAQUE_PI_REVIEWER_LIMITS.stdoutBytes) {
    throw failure(OPAQUE_PI_REVIEWER_FAILURE.OUTPUT_TOO_LARGE, "Pi reviewer output exceeds the byte bound");
  }
  return stdout;
}

async function consume(
  models: OpaquePiModels,
  model: Model<import("@earendil-works/pi-ai").Api>,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Buffer> {
  let terminal: import("@earendil-works/pi-ai").AssistantMessage | undefined;
  let streamedBytes = 0;
  const stream = models.streamSimple(model, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, {
    signal,
    maxRetries: 0,
    maxTokens: 16_384,
    timeoutMs,
    transport: "sse",
    cacheRetention: "none",
  });
  for await (const event of stream) {
    if (event.type === "text_delta") {
      streamedBytes += Buffer.byteLength(event.delta, "utf8");
      if (streamedBytes > OPAQUE_PI_REVIEWER_LIMITS.stdoutBytes) {
        throw failure(OPAQUE_PI_REVIEWER_FAILURE.OUTPUT_TOO_LARGE, "Pi reviewer output exceeds the byte bound");
      }
      continue;
    }
    if (event.type === "done") {
      terminal = event.message;
      continue;
    }
    if (event.type === "error") {
      throw failure(
        event.reason === "aborted" ? OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_ABORTED : OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_FAILED,
        event.reason === "aborted" ? "Pi reviewer was aborted by its provider" : "Pi reviewer provider failed",
      );
    }
    // Reasoning events are provider metadata and never enter stdout. Tool calls
    // would violate the provider's tool-free reviewer transport.
    if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
      throw failure(OPAQUE_PI_REVIEWER_FAILURE.INVALID_OUTPUT, "Pi reviewer returned non-text output");
    }
  }
  if (terminal === undefined) throw failure(OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_FAILED, "Pi reviewer ended without a terminal response");
  return validateOutput(terminal);
}

/** Creates the narrow seam used by offline contract tests; production resolves only Tesota's Codex store. */
export function createOpaquePiReviewer(dependencies: OpaquePiReviewerDependencies):
  (prompt: Buffer, options?: OpaquePiReviewerOptions) => Promise<OpaquePiReviewerResult> {
  return async (prompt: Buffer, options: OpaquePiReviewerOptions = {}): Promise<OpaquePiReviewerResult> => {
    const promptText = decodePrompt(prompt);
    if (options.signal?.aborted) throw failure(OPAQUE_PI_REVIEWER_FAILURE.CANCELLED, "Pi reviewer was cancelled before launch");
    const timeoutMs = resolveTimeout(options.timeoutMs);
    const timeout = new AbortController();
    const cancellation = new AbortController();
    const signal = options.signal === undefined
      ? AbortSignal.any([timeout.signal, cancellation.signal])
      : AbortSignal.any([options.signal, timeout.signal, cancellation.signal]);
    let rejectDeadline: (reason: OpaquePiReviewerError) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const expire = (): void => {
      timeout.abort();
      rejectDeadline(failure(OPAQUE_PI_REVIEWER_FAILURE.TIMED_OUT, "Pi reviewer exceeded its time bound"));
    };
    const cancel = (): void => {
      cancellation.abort();
      rejectDeadline(failure(OPAQUE_PI_REVIEWER_FAILURE.CANCELLED, "Pi reviewer was cancelled"));
    };
    const timer = setTimeout(expire, timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const execution = (async (): Promise<Buffer> => {
        const models = await dependencies.resolveModels(dependencies.credentials, signal);
        const model = models.getModel("openai-codex", REVIEW_CODEX_MODEL_ID);
        if (model?.api !== "openai-codex-responses") {
          throw failure(OPAQUE_PI_REVIEWER_FAILURE.MODEL_UNAVAILABLE, "Tesota Codex reviewer model is unavailable");
        }
        return consume(models, model, promptText, signal, timeoutMs);
      })();
      // A provider that ignores cancellation cannot hold this host open after
      // the local deadline has settled the public operation.
      void execution.catch(() => undefined);
      const stdout = await Promise.race([execution, deadline]);
      return { stdout, promptByteLength: prompt.length, stdoutByteLength: stdout.length };
    } catch (error) {
      if (error instanceof OpaquePiReviewerError) throw error;
      if (timeout.signal.aborted) throw failure(OPAQUE_PI_REVIEWER_FAILURE.TIMED_OUT, "Pi reviewer exceeded its time bound");
      if (options.signal?.aborted) throw failure(OPAQUE_PI_REVIEWER_FAILURE.CANCELLED, "Pi reviewer was cancelled");
      throw failure(OPAQUE_PI_REVIEWER_FAILURE.PROVIDER_FAILED, "Pi reviewer provider failed");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  };
}

const defaultReviewer = createOpaquePiReviewer({
  credentials: new CodexCredentials(),
  resolveModels: async (credentials, signal): Promise<Models> => await storedCodexModels(credentials, signal),
});

/** Runs one provider-issued UTF-8 prompt through direct, tool-free Pi inference. */
export async function runOpaquePiReviewer(
  prompt: Buffer,
  options: OpaquePiReviewerOptions = {},
): Promise<OpaquePiReviewerResult> {
  return await defaultReviewer(prompt, options);
}
