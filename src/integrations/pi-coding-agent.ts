import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { LIVE_CODEX_MODEL_ID } from "./pi-live.js";

export const PI_CODING_AGENT_LIMITS: Readonly<{ sessionMs: number; outputMessages: number }> = Object.freeze({ sessionMs: 120_000, outputMessages: 64 });

export interface PiCodingAgentRun {
  readonly status: "completed" | "timed_out" | "failed";
  readonly messages: number;
  readonly toolNames: readonly string[];
  readonly responseText: string;
  readonly error?: string;
}

/**
 * Runs the full Pi Coding Agent SDK behind a Tesota-owned, time-bounded host.
 * The caller owns the candidate and decides whether any resulting bytes are
 * acceptable. This host never commits, promotes or grants repository authority.
 */
export async function runPiCodingAgent(options: {
  readonly cwd: string;
  readonly prompt: string;
  readonly credentials: CredentialStore;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly tools?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
}): Promise<PiCodingAgentRun> {
  const runtime = await ModelRuntime.create({ credentials: options.credentials, refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
  if (model === undefined) throw new Error("Pi Coding Agent model unavailable");
  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(options.cwd),
    tools: [...(options.tools ?? ["read", "edit"])],
    ...(options.customTools === undefined ? {} : { customTools: [...options.customTools] }),
  });
  const toolNames = new Set<string>();
  let messages = 0;
  const responses: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolNames.add(event.toolName);
    if (event.type === "message_end") messages += 1;
    if (event.type === "message_end" && event.message.role === "assistant") responses.push(contentText(event.message.content));
  });
  const timeoutMs = options.timeoutMs ?? PI_CODING_AGENT_LIMITS.sessionMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("Pi Coding Agent session timed out"));
    }, timeoutMs);
  });
  try {
    await Promise.race([session.prompt(options.prompt).then(() => session.waitForIdle()), timeout]);
    if (options.signal?.aborted) return { status: "failed", messages, toolNames: [...toolNames], responseText: responses.join("\n"), error: "session aborted" };
    return { status: "completed", messages, toolNames: [...toolNames], responseText: responses.join("\n") };
  } catch (error) {
    if (!session.isIdle) await session.abort().catch(() => undefined);
    return { status: timedOut ? "timed_out" : "failed", messages, toolNames: [...toolNames], responseText: responses.join("\n"), error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    session.dispose();
  }
}
