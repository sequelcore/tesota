import {
  type Api, type AssistantMessage, type Message, type Model, type Models, type ToolCall, type ToolResultMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Base, captureBase } from "./base.ts";
import type { Session, SessionOutcome } from "./contract.ts";
import { conversationMessage } from "./conversation.ts";
import type { Behavior, Origin, SessionWriter } from "./session-file.ts";
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
  /** Where the session's entries go. */
  readonly writer: SessionWriter;
  /** What a resumed session already holds; a new session starts empty. */
  readonly resumed?: LoopState;
  /** The base of a request; the gate's units (`captureBase`) when not given. */
  readonly captureBase?: (cwd: string) => Promise<Base>;
}

/** Where a session stands: its conversation, its last run and amendment, its usage and how its last run ended. */
export interface LoopState {
  readonly history: readonly Message[];
  readonly runs: number;
  readonly amendments: number;
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
  readonly outcome: SessionOutcome | undefined;
}

const defaultPrompt = (cwd: string): string =>
  `You are a coding agent working in ${cwd}. Use the tools to read, change and run what the request needs.`;

/** A call's result as the model sees it. */
export const toolResult = (call: Pick<ToolCall, "id" | "name">, output: ToolOutput, timestamp: number = Date.now()): ToolResultMessage => ({
  role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output.text }],
  isError: output.isError, timestamp,
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

/** An amendment waiting to enter the conversation. */
interface Queued {
  readonly id: number;
  readonly behavior: Behavior;
  readonly text: string;
}

/**
 * The engine's agent loop, before settlement and extensions arrive (#432),
 * writing everything to its session (#437). Its `prompt` resolves when the
 * loop ends: the model answered without calling a tool, failed, or was
 * stopped. That is not settlement; nothing verifies the work yet. A failed
 * write ends the run: `prompt` rejects and nothing further runs.
 */
export function createLoop(options: LoopOptions): Session {
  const { writer } = options;
  const history: Message[] = [...options.resumed?.history ?? []];
  const tokens = { ...options.resumed?.tokens ?? { input: 0, output: 0, total: 0 } };
  let runs = options.resumed?.runs ?? 0;
  let amendments = options.resumed?.amendments ?? 0;
  let outcome = options.resumed?.outcome;
  let spoolFolder: string | undefined;
  const spool = (): string => (spoolFolder ??= mkdtempSync(join(tmpdir(), "tesota-core-output-")));
  const tools = options.tools?.(spool) ?? codingTools(options.cwd, spool);
  const declared = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const systemPrompt = options.systemPrompt ?? defaultPrompt(options.cwd);
  const base = options.captureBase ?? captureBase;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  /** Settles once the running request is in the ledger, so no amendment comes before it. */
  let recorded: Promise<void> = Promise.resolve();
  let queue: Queued[] = [];
  /** Settles once the session is disposed; disposing again waits for the same. */
  let disposed: Promise<void> | undefined;

  /** Streams one reply, records it and counts its usage once, partial usage included when it failed. */
  async function reply(run: number, signal: AbortSignal): Promise<AssistantMessage> {
    const stream = options.models.stream(options.model, { systemPrompt, messages: history, tools: declared }, { signal });
    for await (const _event of stream) { /* the shell will draw these; the loop needs only the result */ }
    const message = await stream.result();
    writer.append({ type: "assistant", run, message });
    history.push(message);
    tokens.input += message.usage.input;
    tokens.output += message.usage.output;
    tokens.total += message.usage.totalTokens;
    return message;
  }

  /** Moves the queued amendments of the given behaviors into the conversation, in the order they came. */
  function deliver(run: number, behaviors: readonly Behavior[]): boolean {
    const due = queue.filter((amendment) => behaviors.includes(amendment.behavior));
    queue = queue.filter((amendment) => !behaviors.includes(amendment.behavior));
    for (const { id, text } of due) {
      writer.append({ type: "delivered", run, amendment: id });
      history.push({ role: "user", content: text, timestamp: Date.now() });
    }
    return due.length > 0;
  }

  /**
   * Runs the reply's calls in order. Each call's intent is synced before it
   * runs, with everything appended before it, so a call that may have
   * changed files is never missing from the session.
   */
  async function runCalls(run: number, message: AssistantMessage, calls: readonly ToolCall[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      let output: ToolOutput;
      if (message.stopReason === "length") output = truncatedCall(call);
      else if (signal.aborted) output = stoppedCall;
      else {
        writer.append({ type: "call_intent", run, callId: call.id });
        writer.sync();
        output = await execute(tools, call, signal);
      }
      const result = toolResult(call, output);
      writer.append({ type: "tool_result", run, message: result });
      history.push(result);
    }
  }

  async function loop(run: number, signal: AbortSignal): Promise<SessionOutcome> {
    for (;;) {
      deliver(run, ["steer"]);
      const message = await reply(run, signal);
      if (message.stopReason === "error") return "error";
      if (message.stopReason === "aborted" || signal.aborted) return "aborted";
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      if (calls.length === 0) {
        if (deliver(run, ["steer", "followUp"])) continue;
        return "completed";
      }
      await runCalls(run, message, calls, signal);
      if (signal.aborted) return "aborted";
    }
  }

  /** A run: its request and base are synced into the ledger before the model hears of it, and its end before it reports. */
  async function start(run: number, text: string, origin: Origin, signal: AbortSignal): Promise<void> {
    const at = new Date().toISOString();
    const written = (async () => {
      writer.append({ type: "request", run, text, origin, at, base: await base(options.cwd) });
      writer.sync();
    })();
    recorded = written.catch(() => undefined);
    await written;
    history.push({ role: "user", content: text, timestamp: Date.parse(at) });
    const ended = await loop(run, signal);
    writer.append({ type: "run_end", run, outcome: ended });
    writer.sync();
    outcome = ended;
  }

  /** Input during a run: an amendment, synced into the ledger after its request, then queued. */
  async function amend(run: number, text: string, behavior: Behavior, origin: Origin): Promise<void> {
    await recorded;
    const id = ++amendments;
    writer.append({ type: "amendment", run, id, behavior, origin, text, at: new Date().toISOString() });
    writer.sync();
    queue.push({ id, behavior, text });
  }

  return {
    async prompt(text, { streamingBehavior, source = "interactive" } = {}) {
      if (running !== undefined) {
        if (streamingBehavior === undefined) throw new Error("A prompt is already running; steer it, queue a follow-up, abort it or wait.");
        await amend(runs, text, streamingBehavior, source);
        return;
      }
      controller = new AbortController();
      queue = [];
      const current = start(++runs, text, source, controller.signal);
      running = current;
      try {
        await current;
      } catch (error) {
        outcome = "error";
        throw error;
      } finally {
        running = undefined;
      }
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
    dispose: () => disposed ??= (async () => {
      controller?.abort();
      await running?.catch(() => undefined);
      writer.close();
      if (spoolFolder !== undefined) rmSync(spoolFolder, { recursive: true, force: true, maxRetries: 3 });
    })(),
  };
}
