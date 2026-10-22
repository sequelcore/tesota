import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Api, type AssistantMessage, type AssistantMessageEventStream, calculateCost, createAssistantMessageEventStream,
  getCurrentSystemPrompt, getCurrentTools, type ImageContent, type Message, type Model, type Provider, type SimpleStreamOptions,
  type TextContent, type Tool, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { goesOn } from "../handback-rule.ts";

/**
 * Claude through the operator's own Claude Code (#546): a model provider,
 * `claude-code`, that runs the unmodified Claude Code program the Claude
 * Agent SDK bundles for the platform. Claude Code answers each step and
 * runs nothing: its built-in tools are off, and Tesota's tools are declared
 * to it over MCP but run by the engine's loop. A tool call ends the step;
 * the engine's result answers the pending MCP call, and the same query goes
 * on. The engine's history is the source of truth: a query that cannot go
 * on (a new run, a stop, a crash, another model, other tools) is replaced
 * by a new one started from that history, never from Claude Code's own
 * transcript. Sign-in is Claude Code's own; Tesota never reads, copies or
 * stores the credential, and asks Claude Code only whether it is signed in.
 *
 * Adapted from pi-claude-bridge 0.9.3 (https://github.com/elidickinson/pi-claude-bridge,
 * MIT, Copyright (c) 2026 Eli Dickinson; see NOTICE): its stream conversion,
 * MCP tool hand-back, tool-pair repair and usage, without its Pi-only parts.
 */

export const claudeCodeProviderId = "claude-code";
const server = "tesota";
const prefix = `mcp__${server}__`;
/** Claude Code stamps each MCP `tools/call` with the id of the `tool_use` it came from, the one way to pair a result with its call. */
const toolUseIdKey = "claudecode/toolUseId";
/** Without a `[1m]` id Claude Code serves 200K of context, as pi-claude-bridge measured; the engine compacts against what is served. */
const servedContext = 200_000;

/** How Claude Code is started for every query: isolated from the operator's own Claude Code setup. */
const environment = {
  CLAUDE_AGENT_SDK_CLIENT_APP: "tesota",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // The engine compacts its own history; Claude Code compacting its copy would diverge from it.
  DISABLE_AUTO_COMPACT: "1",
  // The operator's claude.ai connectors are not Tesota's tools.
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  // Claude Code's memory for the folder is the operator's own, which settings sources do not cover: it reached the prompt in a live run.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
} as const;

/** The SDK's query, as the provider uses it; a test gives a recorded one. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>;
  close(): void;
}
export type StartQuery = (input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => ClaudeQuery;

export interface ClaudeCodeOptions {
  /** Starts a query: the SDK's, loaded when first used, unless a test gives its own. */
  readonly query?: StartQuery;
  /** Whether Claude Code is signed in: `claude auth status`, unless a test gives its own. */
  readonly signedIn?: () => Promise<boolean>;
}

/** How to sign in, for `/model` when Claude Code is not signed in. */
export const claudeCodeSignIn = "Claude through your own Claude Code: sign in there (run `claude`, then `/login`), then /model again.";

/**
 * The Claude Code program to run: the one the SDK installs for this
 * platform, when Tesota runs from source, or else the operator's own
 * `claude` on the `PATH`, since a compiled `tesota` has no SDK install to
 * find it in (#570). None when neither is there.
 */
export function claudeCodeExecutable(installed: () => string | undefined = sdkClaudeCode): string | undefined {
  // The PATH as it is now: Bun's default lookup keeps the one the process started with.
  return installed() ?? Bun.which("claude", { PATH: process.env["PATH"] ?? "" }) ?? undefined;
}

/** The program the SDK installs for this platform, chosen as the SDK chooses it (musl first on a Linux without glibc). */
function sdkClaudeCode(): string | undefined {
  const report = process.platform === "linux" && typeof process.report?.getReport === "function"
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } } : undefined;
  const musl = report !== undefined && report.header?.glibcVersionRuntime === undefined;
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  let require: NodeJS.Require;
  // The program is the SDK's own dependency, so it is found from where the SDK is installed.
  try { require = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")); } catch { return undefined; }
  for (const name of process.platform !== "linux" ? [base] : musl ? [`${base}-musl`, base] : [base, `${base}-musl`]) {
    try {
      const path = join(dirname(require.resolve(`${name}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
      if (existsSync(path)) return path;
    } catch { /* not installed for this platform */ }
  }
  return undefined;
}

/** Whether Claude Code says it is signed in; only `loggedIn` is read from its answer, which holds no credential. */
function statusSignedIn(): Promise<boolean> {
  const program = claudeCodeExecutable();
  if (program === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(program, ["auth", "status", "--json"], { encoding: "utf8", windowsHide: true, timeout: 15_000 }, (_error, stdout) => {
      try { resolve((JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true); } catch { resolve(false); }
    });
  });
}

/** pi-ai's Anthropic catalog as Claude Code's models: the bare ids, at the context Claude Code serves them, drawn on the plan rather than billed. */
export function claudeCodeModels(anthropic: readonly Model<Api>[]): Model<Api>[] {
  return anthropic.filter(({ id }) => !/-20\d{6}$/u.test(id)).map((model) => ({ ...model, provider: claudeCodeProviderId,
    contextWindow: Math.min(model.contextWindow, servedContext), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
}

// --- History: the engine's messages as the Anthropic messages a new query starts from ---

type AnthropicBlock = Record<string, unknown>;
interface AnthropicMessage { role: "user" | "assistant"; content: string | AnthropicBlock[] }

/** Anthropic accepts only `[A-Za-z0-9_-]` in a tool call's id; another provider's ids are made to fit, the same way every time. */
const toolId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/gu, "_");

function imageBlock(image: ImageContent): AnthropicBlock {
  return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function userBlocks(content: string | readonly (TextContent | ImageContent)[]): AnthropicBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return content.flatMap((block): AnthropicBlock[] => block.type === "text" ? block.text === "" ? [] : [{ type: "text", text: block.text }]
    : [imageBlock(block)]);
}

/**
 * The engine's history as Anthropic messages. Every result of one reply's
 * calls goes in the user message right after that reply, where Claude
 * expects them, even when a steer came between them; a reply that a stop
 * cut before anything streamed is left out. Thinking is kept only when
 * Claude Code made it, since Anthropic refuses a signature it did not mint.
 */
export function anthropicHistory(messages: readonly Message[]): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];
  let results: AnthropicMessage | undefined;
  let reply: number | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      const blocks = userBlocks(message.content);
      converted.push({ role: "user", content: blocks.length === 0 ? "[empty]" : blocks });
    } else if (message.role === "assistant") {
      if (message.content.length === 0) continue;
      const blocks = message.content.flatMap((block): AnthropicBlock[] => {
        if (block.type === "text") return block.text === "" ? [] : [{ type: "text", text: block.text }];
        if (block.type === "thinking") {
          return message.provider === claudeCodeProviderId && block.thinkingSignature !== undefined && block.thinkingSignature !== ""
            ? [{ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }] : [];
        }
        return [{ type: "tool_use", id: toolId(block.id), name: `${prefix}${block.name}`, input: block.arguments }];
      });
      results = undefined;
      reply = converted.length;
      converted.push({ role: "assistant", content: blocks.length === 0 ? [{ type: "text", text: "[content omitted]" }] : blocks });
    } else if (message.role === "toolResult") {
      const block = { type: "tool_result", tool_use_id: toolId(message.toolCallId), content: resultBlocks(message), is_error: message.isError };
      if (results !== undefined) (results.content as AnthropicBlock[]).push(block);
      else {
        results = { role: "user", content: [block] };
        converted.splice(reply === undefined ? converted.length : reply + 1, 0, results);
      }
    }
  }
  return converted;
}

function resultBlocks(message: ToolResultMessage): string | AnthropicBlock[] {
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return message.content.some((block) => block.type === "image") ? userBlocks(message.content) : text;
}

/** Where the trailing run of user messages, the new request or a steer, starts. */
function turnStart(messages: readonly Message[]): number {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role === "user") start -= 1;
  return start;
}

/** What a new query is opened with when the engine's history ends at results rather than at a request: a resume or a crash. */
const continuing = "[The session was resumed. What precedes this ends with the results of your last tool calls. Continue from there.]";

// --- Tesota's tools over MCP, answered by the engine ---

interface McpResult { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean }

function mcpResult(message: ToolResultMessage): McpResult {
  const content = message.content.flatMap((block): McpResult["content"] => block.type === "text" ? [{ type: "text", text: block.text }]
    : [{ type: "image", data: block.data, mimeType: block.mimeType }]);
  return { content: content.length === 0 ? [{ type: "text", text: "" }] : content, isError: message.isError };
}

/**
 * A tool's parameters as Claude Code accepts them: it drops a tool whose
 * schema has a top-level `anyOf`, `oneOf` or `allOf`, so those are flattened
 * into one object, and the engine still checks the call against the whole schema.
 */
function flatSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = ["anyOf", "oneOf", "allOf"].flatMap((key) => Array.isArray(schema[key]) ? schema[key] as Record<string, unknown>[] : []);
  if (branches.length === 0) return schema;
  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...rest } = schema;
  const properties: Record<string, unknown> = {};
  for (const source of [schema, ...branches]) {
    for (const [key, value] of Object.entries((source["properties"] ?? {}) as Record<string, unknown>)) if (!(key in properties)) properties[key] = value;
  }
  return { ...rest, type: "object", properties };
}

interface Transport { onmessage?: (message: Record<string, unknown>) => void; send(message: Record<string, unknown>): Promise<void>; start?(): Promise<void> }

/**
 * An in-process MCP server declaring Tesota's tools. The SDK only connects
 * it to a transport, so it answers JSON-RPC itself, with the tools' JSON
 * Schemas as they are; a call waits for the engine's result (`answer`).
 */
function toolServer(tools: readonly Tool[], answer: (callId: string) => Promise<McpResult>) {
  const reply = async (request: Record<string, unknown>): Promise<unknown> => {
    const params = (request["params"] ?? {}) as Record<string, unknown>;
    if (request["method"] === "initialize") {
      return { protocolVersion: params["protocolVersion"] ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } };
    }
    if (request["method"] === "tools/list") {
      return { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: flatSchema(tool.parameters as Record<string, unknown>) })) };
    }
    if (request["method"] === "tools/call") {
      const callId = ((params["_meta"] ?? {}) as Record<string, unknown>)[toolUseIdKey];
      if (typeof callId !== "string") throw new Error(`tools/call came without _meta["${toolUseIdKey}"], so its result cannot be paired with its call`);
      return await answer(callId);
    }
    if (request["method"] === "ping") return {};
    throw Object.assign(new Error(`Method not found: ${String(request["method"])}`), { code: -32601 });
  };
  const instance = {
    async connect(transport: Transport): Promise<void> {
      transport.onmessage = (request) => {
        if (request["id"] === undefined) return;
        void reply(request).then((result) => ({ jsonrpc: "2.0", id: request["id"], result }),
          (error: unknown) => ({ jsonrpc: "2.0", id: request["id"], error: { code: (error as { code?: number }).code ?? -32603,
            message: error instanceof Error ? error.message : String(error) } }))
          .then((message) => transport.send(message)).catch(() => undefined);
      };
      await transport.start?.();
    },
  };
  // The SDK types the instance as the MCP SDK's server class, of which it calls only `connect`.
  return { type: "sdk" as const, name: server, instance: instance as never };
}

// --- The prompt Claude Code reads, kept open so a steer can reach it between a call and its result ---

interface Prompt {
  readonly stream: AsyncGenerator<SDKUserMessage>;
  /** Resolves once the SDK has written the message to Claude Code; rejects once the prompt is closed. */
  push(message: SDKUserMessage): Promise<void>;
  end(): void;
}

function openPrompt(): Prompt {
  const queue: { message: SDKUserMessage; written: () => void; failed: (error: Error) => void }[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done) await new Promise<void>((resolve) => { wake = resolve; });
        const item = queue.shift();
        if (item === undefined) return;
        try { yield item.message; item.written(); } finally { item.failed(new Error("The prompt was closed.")); }
      }
    } finally {
      done = true;
      for (const item of queue.splice(0)) item.failed(new Error("The prompt was closed."));
    }
  }
  return {
    stream: stream(),
    push: (message) => done ? Promise.reject(new Error("The prompt was closed."))
      : new Promise((written, failed) => { queue.push({ message, written, failed }); wake?.(); wake = undefined; }),
    end: () => { done = true; wake?.(); wake = undefined; },
  };
}

const userMessage = (content: AnthropicBlock[], priority?: "next"): SDKUserMessage =>
  ({ type: "user", message: { role: "user", content } as unknown as SDKUserMessage["message"], parent_tool_use_id: null, ...priority === undefined ? {} : { priority } });

// --- One query, across the steps of a run ---

type Block = AssistantMessage["content"][number] & { index?: number; partialJson?: string };
interface BlockStart { type?: string; id?: string; name?: string; input?: ToolCall["arguments"] }
interface Delta { type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string }

const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);
const effortOf: Record<string, Options["effort"]> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** Claude Code's effort for a thinking level: the model's own mapping when pi-ai has one Claude Code accepts. */
function effortFor(model: Model<Api>, reasoning: SimpleStreamOptions["reasoning"]): Options["effort"] | undefined {
  if (reasoning === undefined) return undefined;
  const mapped = (model.thinkingLevelMap as Record<string, unknown> | undefined)?.[reasoning];
  if (mapped === undefined) return effortOf[reasoning];
  return typeof mapped === "string" && efforts.has(mapped) ? mapped as Options["effort"] : undefined;
}

type Arguments = ToolCall["arguments"];

function parsed(json: string, fallback: Arguments): Arguments {
  try { return json === "" ? fallback : JSON.parse(json) as Arguments; } catch { return fallback; }
}

const toolNames = (tools: readonly Tool[]): string => tools.map(({ name }) => name).sort().join("\n");

class Conversation {
  readonly prompt = openPrompt();
  readonly waiting = new Map<string, (result: McpResult) => void>();
  readonly early = new Map<string, McpResult>();
  /** The Claude Code sessions this query wrote, removed when it ends: the engine keeps the conversation. */
  readonly sessions = new Set<string>();
  query: ClaudeQuery | undefined;
  stream: AssistantMessageEventStream | undefined;
  output: AssistantMessage | undefined;
  started = false;
  /** The ids of the calls the last step ended with, and the history's length once its reply was added. */
  calls: string[] = [];
  answeredAt = 0;
  /** The API message being streamed, and the ids of those that streamed, so the SDK's copy of each is not added again. */
  messageId: string | undefined;
  readonly streamed = new Set<string>();
  failure: string | undefined;
  limit: string | undefined;
  closed = false;
  readonly unlisten: (() => void)[] = [];
  readonly key: string | undefined;
  readonly cwd: string;
  readonly model: Model<Api>;
  /** What the query was opened with, which a step must still match to go on in it. */
  readonly system: string;
  readonly tools: string;
  readonly offered: ReadonlySet<string>;

  constructor(key: string | undefined, cwd: string, model: Model<Api>, system: string, tools: readonly Tool[]) {
    this.key = key;
    this.cwd = cwd;
    this.model = model;
    this.system = system;
    this.tools = toolNames(tools);
    this.offered = new Set(tools.map(({ name }) => name));
  }

  /** Starts a step: its reply streams to `stream`. */
  begin(stream: AssistantMessageEventStream): void {
    this.stream = stream;
    this.started = false;
    this.output = { role: "assistant", content: [], api: this.model.api, provider: this.model.provider, model: this.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now() };
  }

  get blocks(): Block[] { return (this.output as AssistantMessage).content as Block[]; }

  #start(): void {
    if (this.started || this.stream === undefined || this.output === undefined) return;
    this.stream.push({ type: "start", partial: this.output });
    this.started = true;
  }

  usage(counters: Record<string, unknown> | undefined): void {
    if (counters === undefined || this.output === undefined) return;
    const usage = this.output.usage;
    const read = (key: string): number | undefined => typeof counters[key] === "number" ? counters[key] : undefined;
    usage.input = read("input_tokens") ?? usage.input;
    usage.output = read("output_tokens") ?? usage.output;
    usage.cacheRead = read("cache_read_input_tokens") ?? usage.cacheRead;
    usage.cacheWrite = read("cache_creation_input_tokens") ?? usage.cacheWrite;
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    calculateCost(this.model, usage);
  }

  /** A tool Claude Code calls that is not Tesota's is answered by Claude Code itself, which refuses it and goes on. */
  #ours(name: string): string | undefined {
    const tool = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
    return tool !== undefined && this.offered.has(tool) ? tool : undefined;
  }

  /** One event of the API message being streamed. */
  event(event: Record<string, unknown>): void {
    const output = this.output;
    if (this.stream === undefined || output === undefined) return;
    const at = this.blocks.findIndex((block) => block.index === event["index"]);
    if (event["type"] === "message_start") {
      const message = event["message"] as { id?: string; usage?: Record<string, unknown> } | undefined;
      // A message still open is one Claude Code gave up on and asks again for: its blocks never completed.
      this.#dropOpen();
      this.messageId = message?.id;
      if (message?.id !== undefined) this.streamed.add(message.id);
      this.usage(message?.usage);
    } else if (event["type"] === "content_block_start") this.#blockStart(event["index"] as number, event["content_block"] as BlockStart | undefined);
    else if (event["type"] === "content_block_delta" && at >= 0) this.#delta(at, event["delta"] as Delta);
    else if (event["type"] === "content_block_stop" && at >= 0) this.#blockStop(at);
    else if (event["type"] === "message_delta") {
      const reason = (event["delta"] as { stop_reason?: string } | undefined)?.stop_reason;
      output.stopReason = reason === "max_tokens" ? "length" : "stop";
      this.usage(event["usage"] as Record<string, unknown> | undefined);
    } else if (event["type"] === "message_stop") {
      this.#dropOpen();
      this.messageId = undefined;
      this.#endOnCalls();
    }
  }

  #blockStart(index: number, content: BlockStart | undefined): void {
    if (content?.type === "text") this.#open({ type: "text", text: "", index }, "text_start");
    else if (content?.type === "thinking") this.#open({ type: "thinking", thinking: "", thinkingSignature: "", index }, "thinking_start");
    else if (content?.type === "tool_use") {
      const name = this.#ours(content.name ?? "");
      if (name !== undefined) this.#open({ type: "toolCall", id: content.id ?? "", name, arguments: content.input ?? {}, partialJson: "", index }, "toolcall_start");
    }
  }

  #delta(at: number, delta: Delta): void {
    const block = this.blocks[at] as Block;
    const [stream, output] = [this.stream as AssistantMessageEventStream, this.output as AssistantMessage];
    if (delta.type === "text_delta" && block.type === "text") {
      block.text += delta.text ?? "";
      stream.push({ type: "text_delta", contentIndex: at, delta: delta.text ?? "", partial: output });
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += delta.thinking ?? "";
      stream.push({ type: "thinking_delta", contentIndex: at, delta: delta.thinking ?? "", partial: output });
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature ?? "");
    } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson = (block.partialJson ?? "") + (delta.partial_json ?? "");
      block.arguments = parsed(block.partialJson, block.arguments);
      stream.push({ type: "toolcall_delta", contentIndex: at, delta: delta.partial_json ?? "", partial: output });
    }
  }

  #blockStop(at: number): void {
    const block = this.blocks[at] as Block;
    const [stream, output] = [this.stream as AssistantMessageEventStream, this.output as AssistantMessage];
    delete block.index;
    if (block.type === "text") stream.push({ type: "text_end", contentIndex: at, content: block.text, partial: output });
    else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: at, content: block.thinking, partial: output });
    else if (block.type === "toolCall") {
      block.arguments = parsed(block.partialJson ?? "", block.arguments);
      delete block.partialJson;
      stream.push({ type: "toolcall_end", contentIndex: at, toolCall: block, partial: output });
    }
  }

  #open(block: Block, type: "text_start" | "thinking_start" | "toolcall_start"): void {
    this.#start();
    this.blocks.push(block);
    this.stream?.push({ type, contentIndex: this.blocks.length - 1, partial: this.output as AssistantMessage });
  }

  /** Removes the blocks a cut stream never closed: a call Claude Code will never make, or thinking without its signature. */
  #dropOpen(): void {
    for (let at = this.blocks.length - 1; at >= 0; at -= 1) if (this.blocks[at]?.index !== undefined) this.blocks.splice(at, 1);
  }

  /** A whole message, which the SDK sends after streaming it, and alone when Claude Code fell back to asking without streaming. */
  message(message: { id?: string; model?: string; content?: Record<string, unknown>[]; usage?: Record<string, unknown> }): void {
    if (this.stream === undefined || this.output === undefined || message.id !== undefined && this.streamed.has(message.id)) return;
    // Claude Code reports its own failures, such as a plan's limit, as a `<synthetic>` message: the error carries its words, not the reply.
    if (message.model === "<synthetic>") {
      this.failure = (message.content ?? []).map((block) => typeof block["text"] === "string" ? block["text"] : "").join("\n").trim() || this.failure;
      return;
    }
    this.#dropOpen();
    for (const block of message.content ?? []) {
      if (block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
        this.#open({ type: "text", text: block["text"] }, "text_start");
        this.stream.push({ type: "text_end", contentIndex: this.blocks.length - 1, content: block["text"], partial: this.output });
      } else if (block["type"] === "tool_use") {
        const name = this.#ours(String(block["name"]));
        if (name === undefined) continue;
        const call: ToolCall = { type: "toolCall", id: String(block["id"]), name, arguments: (block["input"] ?? {}) as Arguments };
        this.#open(call, "toolcall_start");
        this.stream.push({ type: "toolcall_end", contentIndex: this.blocks.length - 1, toolCall: call, partial: this.output });
      }
    }
    this.usage(message.usage);
    this.#endOnCalls();
  }

  /** Ends the step once its reply has calls: the engine runs them, and their results answer the MCP calls Claude Code waits on. */
  #endOnCalls(): void {
    const calls = this.blocks.filter((block) => block.type === "toolCall");
    if (calls.length === 0 || this.stream === undefined || this.output === undefined) return;
    this.calls = calls.map(({ id }) => id);
    this.output.stopReason = "toolUse";
    this.#finish("done");
  }

  #finish(how: "done" | "error" | "aborted"): void {
    const stream = this.stream;
    const output = this.output;
    if (stream === undefined || output === undefined) return;
    this.stream = undefined;
    // What a stop or a failure cut is not part of the reply the engine keeps.
    if (how !== "done") this.#dropOpen();
    this.#start();
    if (how === "done") stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : output.stopReason === "length" ? "length" : "stop", message: output });
    else {
      output.stopReason = how === "aborted" ? "aborted" : "error";
      output.errorMessage ??= how === "aborted" ? "Stopped." : "Claude Code ended without saying why.";
      stream.push({ type: "error", reason: how, error: output });
    }
    stream.end();
  }

  /** The query ended its turn, or failed: the step ends with what it gave, or with why it failed. */
  settle(error?: string): void {
    if (this.output !== undefined && (error ?? this.failure) !== undefined) {
      const reason = error ?? this.failure ?? "";
      this.output.errorMessage = `Claude Code: ${this.limit === undefined ? reason : `${this.limit} ${reason}`.trim()}`;
      this.#finish("error");
    } else this.#finish("done");
  }

  /** Stops the query, answering any MCP call still waiting so Claude Code's side settles. */
  close(how?: "aborted"): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.values()) resolve({ content: [{ type: "text", text: "Stopped." }], isError: true });
    this.waiting.clear();
    this.prompt.end();
    for (const unlisten of this.unlisten.splice(0)) unlisten();
    if (how === "aborted") this.#finish("aborted");
    void this.query?.interrupt().catch(() => undefined);
    try { this.query?.close(); } catch { /* already ended */ }
  }

  /** Removes only this query's transcripts, then its project bucket if nothing else uses it. */
  async removeTranscripts(): Promise<void> {
    const id = this.sessions.values().next().value;
    if (id === undefined) return;
    const { deleteSession, getSessionPath } = await import("cc-session-io");
    for (const session of this.sessions) try { deleteSession(session, this.cwd); } catch { /* already gone */ }
    // The project bucket is shared with the operator's Claude Code: remove it only if empty.
    try { rmdirSync(dirname(getSessionPath(id, this.cwd))); } catch { /* absent, not empty, or not removable */ }
  }

  /** Whether `messages` go on from where the last step stopped: its reply, then every one of its calls' results, then maybe a steer. */
  answers(model: Model<Api>, system: string, tools: string, messages: readonly Message[]): boolean {
    const reply = messages[this.answeredAt - 1];
    const made = reply?.role === "assistant" ? reply.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : [];
    const after = messages.slice(this.answeredAt);
    const results = after.slice(0, turnStart(after));
    const answered = this.calls.map((id) => results.some((message) => message.role === "toolResult" && message.toolCallId === id));
    const same = !this.closed && this.stream === undefined && model.id === this.model.id && system === this.system && tools === this.tools
      && results.every((message) => message.role === "toolResult");
    return goesOn(same, this.calls, made, answered);
  }

  /** Gives the engine's results to the MCP calls waiting on them, a steer first so Claude Code reads it before going on. */
  async deliver(after: readonly Message[]): Promise<void> {
    const calls = this.calls;
    this.calls = [];
    const steer = after.slice(turnStart(after)).flatMap((message) => message.role === "user" ? userBlocks(message.content) : []);
    if (steer.length > 0) await this.prompt.push(userMessage(steer, "next")).catch(() => undefined);
    for (const message of after) {
      if (message.role !== "toolResult" || !calls.includes(message.toolCallId)) continue;
      const result = mcpResult(message);
      const waiting = this.waiting.get(message.toolCallId);
      if (waiting === undefined) this.early.set(message.toolCallId, result);
      else { this.waiting.delete(message.toolCallId); waiting(result); }
    }
  }

  /** What an MCP call gets: its result once the engine has it. */
  answer(callId: string): Promise<McpResult> {
    const result = this.early.get(callId);
    if (result !== undefined) { this.early.delete(callId); return Promise.resolve(result); }
    if (this.closed) return Promise.resolve({ content: [{ type: "text", text: "Stopped." }], isError: true });
    return new Promise((resolve) => { this.waiting.set(callId, resolve); });
  }
}

/** What a refused request says about the plan's limit, which Claude Code sends just before the failure it causes. */
function planLimit(info: unknown): string | undefined {
  const limit = info as { status?: string; rateLimitType?: string; resetsAt?: number } | undefined;
  if (limit?.status !== "rejected") return undefined;
  const until = limit.resetsAt === undefined ? "" : ` until ${new Date(limit.resetsAt * 1000).toISOString()}`;
  return `The Claude plan's limit${limit.rateLimitType === undefined ? "" : ` (${limit.rateLimitType})`} is reached${until}.`;
}

/** The text of a `result` that failed, or none when it succeeded. */
function failureOf(message: Record<string, unknown>): string | undefined {
  if (message["subtype"] === "success" && message["is_error"] !== true) return undefined;
  const errors = Array.isArray(message["errors"]) ? (message["errors"] as unknown[]).map(String).join("; ") : "";
  const text = typeof message["result"] === "string" ? message["result"] : "";
  return (errors || text || String(message["subtype"])).trim();
}

/**
 * The `claude-code` provider over `anthropic`, pi-ai's Anthropic catalog,
 * whose models it offers as `claude-code/<id>` once Claude Code is signed in.
 */
export function claudeCodeProvider(anthropic: readonly Model<Api>[], options: ClaudeCodeOptions = {}): Provider {
  const models = claudeCodeModels(anthropic);
  const signedIn = options.signedIn ?? statusSignedIn;
  const live = new Map<string, Conversation>();
  let start: Promise<StartQuery> | undefined;
  const sdk = (): Promise<StartQuery> => start ??= options.query !== undefined ? Promise.resolve(options.query)
    : import("@anthropic-ai/claude-agent-sdk").then(({ query }) => query as StartQuery);

  /** Opens a new query on the engine's history, the trailing request or steer as its prompt. */
  async function open(conversation: Conversation, model: Model<Api>, messages: readonly Message[], tools: readonly Tool[],
    options: SimpleStreamOptions | undefined): Promise<void> {
    const cwd = conversation.cwd;
    const turn = turnStart(messages);
    const earlier = anthropicHistory(messages.slice(0, turn));
    const asked = messages.slice(turn).flatMap((message) => message.role === "user" ? userBlocks(message.content) : []);
    // The query's Claude Code session is named before it starts, so it is removed even when a stop comes before Claude Code says it.
    const session = randomUUID();
    conversation.sessions.add(session);
    let resume: string | undefined;
    if (earlier.length > 0) {
      const { createSession, repairToolPairing } = await import("cc-session-io");
      const written = createSession({ projectPath: cwd, model: model.id, sessionId: session });
      written.importMessages(repairToolPairing(earlier as Parameters<typeof repairToolPairing>[0]));
      written.save();
      resume = session;
    }
    void conversation.prompt.push(userMessage(asked.length > 0 ? asked : [{ type: "text", text: continuing }])).catch(() => undefined);
    const effort = effortFor(model, options?.reasoning);
    const program = claudeCodeExecutable();
    const stderr: string[] = [];
    const query = (await sdk())({ prompt: conversation.prompt.stream, options: {
      cwd, model: model.id, systemPrompt: conversation.system, tools: [], mcpServers: { [server]: toolServer(tools, (id) => conversation.answer(id)) },
      strictMcpConfig: true, settingSources: [], skills: [], settings: { autoMemoryEnabled: false },
      canUseTool: async (name, input) => name.startsWith(prefix) ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Only Tesota's tools are available." },
      includePartialMessages: true, env: { ...process.env, ...environment },
      stderr: (data) => { stderr.push(data); if (stderr.length > 20) stderr.shift(); },
      ...effort === undefined ? {} : { effort, extraArgs: { "thinking-display": "summarized" } },
      ...resume === undefined ? { sessionId: session } : { resume },
      ...program === undefined ? {} : { pathToClaudeCodeExecutable: program } } });
    conversation.query = query;
    void consume(conversation, query, stderr);
  }

  async function consume(conversation: Conversation, query: ClaudeQuery, stderr: readonly string[]): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of query) {
        const record = message as unknown as Record<string, unknown>;
        if (message.type === "stream_event") conversation.event(record["event"] as Record<string, unknown>);
        else if (message.type === "assistant") conversation.message(record["message"] as Parameters<Conversation["message"]>[0]);
        else if (message.type === "system" && record["subtype"] === "init" && typeof record["session_id"] === "string") conversation.sessions.add(record["session_id"]);
        else if (message.type === "rate_limit_event") conversation.limit = planLimit(record["rate_limit_info"]) ?? conversation.limit;
        else if (message.type === "result") {
          // The turn is over: the step ends now, and closing the prompt lets Claude Code exit.
          conversation.failure = failureOf(record) ?? conversation.failure;
          conversation.settle();
          conversation.prompt.end();
        }
      }
    } catch (thrown) {
      error = [thrown instanceof Error ? thrown.message : String(thrown), stderr.join("").trim()].filter((part) => part !== "").join(": ");
    } finally {
      if (!conversation.closed) conversation.settle(error);
      conversation.close();
      if (conversation.key !== undefined && live.get(conversation.key) === conversation) live.delete(conversation.key);
      await conversation.removeTranscripts();
    }
  }

  function streamSimple(model: Model<Api>, context: { messages: Message[] }, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const messages = context.messages.filter((message) => message.role !== "system") as Message[];
    const tools = getCurrentTools(context.messages);
    const system = getCurrentSystemPrompt(context.messages);
    const cwd = options?.metadata?.["cwd"];
    if (typeof cwd !== "string" || cwd === "") throw new Error("Claude Code requires the session's working folder in metadata.cwd.");
    const key = options?.sessionId;
    const parked = key === undefined ? undefined : live.get(key);
    let conversation: Conversation;
    if (parked !== undefined && parked.cwd === cwd && parked.answers(model, system, toolNames(tools), messages)) {
      conversation = parked;
      conversation.begin(stream);
      void conversation.deliver(messages.slice(conversation.answeredAt));
    } else {
      parked?.close();
      conversation = new Conversation(key, cwd, model, system, tools);
      if (key !== undefined) live.set(key, conversation);
      conversation.begin(stream);
      open(conversation, model, messages, tools, options).catch((error: unknown) => {
        conversation.settle(error instanceof Error ? error.message : String(error));
        conversation.close();
        if (key !== undefined && live.get(key) === conversation) live.delete(key);
      });
    }
    conversation.answeredAt = messages.length + 1;
    const signal = options?.signal;
    if (signal !== undefined) {
      const stop = (): void => {
        conversation.close("aborted");
        if (key !== undefined && live.get(key) === conversation) live.delete(key);
      };
      if (signal.aborted) stop();
      else {
        signal.addEventListener("abort", stop, { once: true });
        conversation.unlisten.push(() => { signal.removeEventListener("abort", stop); });
      }
    }
    return stream;
  }

  return {
    id: claudeCodeProviderId,
    name: "Claude Code",
    auth: {
      apiKey: {
        name: "Claude Code sign-in",
        // Signed in or not, as Claude Code says; nothing of the credential reaches Tesota.
        check: async () => await signedIn() ? { type: "api_key", source: "Claude Code" } : undefined,
        resolve: async () => ({ auth: {}, source: "Claude Code" }),
      },
    },
    getModels: () => models,
    stream: (model, context, options) => streamSimple(model, context as unknown as { messages: Message[] }, options as SimpleStreamOptions),
    streamSimple: (model, context, options) => streamSimple(model, context as unknown as { messages: Message[] }, options),
  };
}
