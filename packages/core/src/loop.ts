import {
  type Api, type AssistantMessage, type Message, type Model, type Models, type ToolCall, type ToolResultMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionOutcome } from "./contract.ts";
import { conversationMessage } from "./conversation.ts";
import type { EngineTool, ToolOutput } from "./tool.ts";
import { codingTools } from "./tools/index.ts";

export interface LoopOptions {
  /** The session's folder: tools resolve paths and run commands from here. */
  readonly cwd: string;
  readonly models: Models;
  readonly model: Model<Api>;
  readonly systemPrompt?: string;
  /** The tools the model may call; read, write, edit and the platform's shell when not given. */
  readonly tools?: (spool: () => string) => readonly EngineTool[];
}

/**
 * The engine's agent loop, before sessions, settlement and extensions arrive
 * (#432). Its `prompt` resolves when the loop ends: the model answered
 * without calling a tool, failed, or was stopped. That is not settlement;
 * nothing verifies the work yet.
 */
export type Loop = Pick<Session, "prompt" | "abort" | "messages" | "lastAssistantText" | "stats" | "outcome" | "dispose">;

const defaultPrompt = (cwd: string): string =>
  `You are a coding agent working in ${cwd}. Use the tools to read, change and run what the request needs.`;

const result = (call: ToolCall, output: ToolOutput): ToolResultMessage => ({
  role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output.text }],
  isError: output.isError, timestamp: Date.now(),
});

/** Runs one tool call: an unknown tool, invalid arguments or an exception become a failed call the model sees. */
async function execute(tools: readonly EngineTool[], call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) return { text: `Tool "${call.name}" not found.`, isError: true };
  try {
    return await tool.execute(validateToolArguments(tool, call) as never, signal);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

const truncatedCall = (call: ToolCall): ToolOutput => ({
  text: `Tool call "${call.name}" was not run: the reply hit the output token limit, so its arguments may be cut off. `
    + "Call it again with complete arguments.", isError: true,
});

const stoppedCall: ToolOutput = { text: "Not run: the operator stopped the agent.", isError: true };

export function createLoop(options: LoopOptions): Loop {
  const history: Message[] = [];
  const tokens = { input: 0, output: 0, total: 0 };
  let spoolFolder: string | undefined;
  const spool = (): string => (spoolFolder ??= mkdtempSync(join(tmpdir(), "tesota-core-output-")));
  const tools = options.tools?.(spool) ?? codingTools(options.cwd, spool);
  const declared = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const systemPrompt = options.systemPrompt ?? defaultPrompt(options.cwd);
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  let outcome: SessionOutcome | undefined;

  /** Streams one reply and counts its usage once, partial usage included when it failed. */
  async function reply(signal: AbortSignal): Promise<AssistantMessage> {
    const stream = options.models.stream(options.model, { systemPrompt, messages: history, tools: declared }, { signal });
    for await (const _event of stream) { /* the shell will draw these; the loop needs only the result */ }
    const message = await stream.result();
    history.push(message);
    tokens.input += message.usage.input;
    tokens.output += message.usage.output;
    tokens.total += message.usage.totalTokens;
    return message;
  }

  async function run(text: string, signal: AbortSignal): Promise<SessionOutcome> {
    history.push({ role: "user", content: text, timestamp: Date.now() });
    for (;;) {
      const message = await reply(signal);
      if (message.stopReason === "error") return "error";
      if (message.stopReason === "aborted" || signal.aborted) return "aborted";
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      if (calls.length === 0) return "completed";
      for (const call of calls) {
        const output = message.stopReason === "length" ? truncatedCall(call)
          : signal.aborted ? stoppedCall : await execute(tools, call, signal);
        history.push(result(call, output));
      }
      if (signal.aborted) return "aborted";
    }
  }

  return {
    async prompt(text) {
      if (running !== undefined) throw new Error("A prompt is already running; abort it or wait for it to end.");
      controller = new AbortController();
      const current = run(text, controller.signal).then((ended) => { outcome = ended; });
      running = current;
      try { await current; } finally { running = undefined; }
    },
    async abort() {
      controller?.abort();
      await running?.catch(() => undefined);
    },
    messages: () => history.map(conversationMessage),
    lastAssistantText: () => {
      const last = history.findLast((message): message is AssistantMessage => message.role === "assistant");
      return last?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    },
    stats: () => ({ tokens: { ...tokens } }),
    outcome: () => outcome,
    dispose: () => {
      controller?.abort();
      if (spoolFolder !== undefined) rmSync(spoolFolder, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
