import { realpathSync } from "node:fs";
import { createSdkMcpServer, getSessionInfo, getSessionMessages, query, tool, type CanUseTool, type HookCallback, type SDKMessage,
  type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as z from "zod";
import type { ModelTarget } from "./model-session.js";
import type { AgentActivity, ConversationEntry, TurnResult } from "./model-session-contract.js";
import { editChange, resultText, textOf, toolSubject } from "./pi-coding-session.js";
import type { ReasoningLevel } from "../model-roles.js";
import { NO_TOKENS, type TokenUsage, addTokens } from "../token-usage.js";

/**
 * A role's session on Claude Code (decision 021), run by the Claude Agent SDK
 * with the Claude Code program it bundles, unmodified. Claude Code signs in by
 * itself, through Anthropic's own flow; Tesota never reads its credentials.
 *
 * The session gets Tesota's own tools and nothing else: every built-in tool
 * is disabled, Tesota's tools come from an in-process MCP server, and any
 * other call is refused. None of the operator's Claude Code settings,
 * CLAUDE.md, hooks, skills or MCP servers load, and Claude Code's
 * nonessential traffic, such as its background model call, is off.
 */

const server = "tesota";
const prefix = `mcp__${server}__`;

export interface ClaudeCodeSessionOptions {
  readonly cwd: string;
  /** A Claude Code model alias, such as `opus`, or a full model id. */
  readonly model: string;
  /** Claude Code's effort (decision 029); the model's default when absent. */
  readonly reasoning?: ReasoningLevel;
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly onActivity?: (activity: AgentActivity) => void;
  readonly onUsage?: (usage: TokenUsage) => void;
  /**
   * The conversation to keep across requests, under this id, for the working
   * agent; read-only roles keep none.
   */
  readonly conversationId?: string;
  /** Claude Code's configuration folder, where an added route's account is signed in (decision 050); the operator's own when absent. */
  readonly configDirectory?: string;
}

/**
 * The tokens a run used over all the models it called, as Claude Code
 * reported them. Claude Code counts fresh input apart from the cache, so the
 * cache's parts are added back into `input`.
 */
export function resultUsage(result: SDKResultMessage): TokenUsage {
  return Object.values(result.modelUsage).reduce((total, usage) => addTokens(total, {
    input: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens, output: usage.outputTokens,
    cacheRead: usage.cacheReadInputTokens, cacheCreation: usage.cacheCreationInputTokens }), NO_TOKENS);
}

/** How a run ended, from its result message; a run that stopped without one did not finish. */
export function claudeCodeTurn(result: SDKResultMessage | undefined, cancelled: boolean): TurnResult {
  if (cancelled) return { status: "cancelled" };
  if (result === undefined) return { status: "failed", reason: "Claude Code stopped without a result" };
  if (result.subtype === "success" && !result.is_error) return { status: "completed", reply: result.result.trim() };
  const reason = result.subtype === "success" ? result.result : result.errors.join("; ");
  return { status: "failed", reason: reason.trim() || result.subtype };
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  return Array.isArray(block) ? textOf(block) : "";
}

/**
 * One message of a Claude Code conversation as conversation entries: text,
 * tool calls with their arguments and tool results. Tesota's tools lose their
 * `mcp__tesota__` prefix, so a call reads as it does on Pi; thinking is left out.
 */
export function claudeCodeEntries(role: "user" | "assistant", content: unknown): ConversationEntry[] {
  if (typeof content === "string") return content.trim() === "" ? [] : [{ role, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown): ConversationEntry[] => {
    if (typeof block !== "object" || block === null) return [];
    const type: unknown = Reflect.get(block, "type");
    if (type === "text") return [{ role, text: String(Reflect.get(block, "text")) }];
    if (type === "tool_use") {
      const name = String(Reflect.get(block, "name")).replace(prefix, "");
      return [{ role: "tool_call", text: `${name} ${JSON.stringify(Reflect.get(block, "input"))}` }];
    }
    if (type === "tool_result") return [{ role: "tool_result", text: blockText(Reflect.get(block, "content")) }];
    return [];
  });
}

/** The input one API call read, cached or not, from an assistant message's usage; undefined when it has none. */
export function callContext(message: unknown): number | undefined {
  const usage: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "usage") : undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const size = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    .reduce((total, key) => total + (Number(Reflect.get(usage, key)) || 0), 0);
  return size > 0 ? size : undefined;
}

/** Allows Tesota's tools and refuses anything else Claude Code tries to call. */
export const onlyTesotaTools: CanUseTool = async (name, input) => name.startsWith(prefix)
  ? { behavior: "allow", updatedInput: input }
  : { behavior: "deny", message: "Only Tesota's tools are available in this session." };

/** A zod object shape for a tool's JSON Schema parameters, as the SDK's tool definitions take them. */
export function toolShape(parameters: unknown): z.ZodRawShape {
  const schema = z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]);
  if (!(schema instanceof z.ZodObject)) throw new Error("A Tesota tool's parameters must be an object");
  return schema.shape;
}

type Emit = (activity: AgentActivity) => void;

/** How one of Tesota's tools reports back to its session. */
interface ToolContext {
  readonly signal: () => AbortSignal;
  readonly emit: Emit;
  readonly next: () => string;
  /** Called when the tool asks to end the turn, as Tesota's submission tools do. */
  readonly terminate: () => void;
  /** Called with each call in progress, so a stopped turn can wait for its tools to settle. */
  readonly track: (call: Promise<unknown>) => void;
}

/** One of Tesota's tools, run by Tesota when Claude Code calls it, reporting its activity as Pi's would. */
function sdkTool(definition: ToolDefinition, { signal, emit, next, terminate, track }: ToolContext) {
  return tool(definition.name, definition.description, toolShape(definition.parameters), (args) => {
    const running = runTool(definition, args, { signal, emit, next, terminate });
    track(running);
    return running;
  });
}

/** One call of a Tesota tool, reported as it starts, streams and ends. */
async function runTool(definition: ToolDefinition, args: Record<string, unknown>,
  { signal, emit, next, terminate }: Omit<ToolContext, "track">) {
  const call = next();
  emit({ type: "tool_started", call, tool: definition.name, subject: toolSubject(definition.name, args) });
  try {
    // Tesota's tools read their own workspace root; the Pi-specific context is not used by them.
    const result = await definition.execute(call, args, signal(), (partial) => {
      emit({ type: "tool_output", call, output: resultText(partial) });
    }, undefined as unknown as ExtensionContext);
    const output = resultText(result);
    const change = definition.name === "edit" ? editChange(result) : undefined;
    emit({ type: "tool_finished", call, failed: false, output, ...(change === undefined ? {} : { change }) });
    if (result.terminate === true) terminate();
    return { content: [{ type: "text" as const, text: output }] };
  } catch (error) {
    const output = error instanceof Error ? error.message : "The tool failed";
    emit({ type: "tool_finished", call, failed: true, output });
    return { content: [{ type: "text" as const, text: output }], isError: true };
  }
}

/** How long a stopped Claude Code turn may take to end before its process is ended, as Pi's sessions wait. */
const settlementMs = 10_000;

const toolNote = "\n\nYour tools are Tesota's, named with the prefix `mcp__tesota__`: for example `read` is " +
  "`mcp__tesota__read`. No other tools are available.";

export class ClaudeCodeSession {
  readonly #options: ClaudeCodeSessionOptions;
  readonly #root: string;
  #model: string;
  #effort: ReasoningLevel | undefined;
  /** Whether the session continues a conversation Claude Code already held. */
  readonly resumed: boolean;
  #usable = true;
  #message = 0;
  #calls = 0;
  #conversationStarted = false;
  #terminating = 0;
  #signal: AbortSignal = new AbortController().signal;
  /** The conversation: what Claude Code saved before this session started, then every message since. */
  readonly #entries: ConversationEntry[];
  #contextTokens: number | undefined;

  private constructor(options: ClaudeCodeSessionOptions, root: string, conversationStarted: boolean,
    earlier: readonly ConversationEntry[], contextTokens: number | undefined) {
    this.#entries = [...earlier];
    this.#contextTokens = contextTokens;
    this.#options = options;
    this.#root = root;
    this.#model = options.model;
    this.#effort = options.reasoning;
    this.#conversationStarted = conversationStarted;
    this.resumed = conversationStarted;
  }

  /** A working agent's conversation resumes if Claude Code already holds it for this workspace. */
  static async start(options: ClaudeCodeSessionOptions): Promise<ClaudeCodeSession> {
    const root = realpathSync(options.cwd);
    const existing = options.conversationId === undefined ? false
      : await getSessionInfo(options.conversationId, { dir: root }) !== undefined;
    const saved = !existing || options.conversationId === undefined ? []
      : (await getSessionMessages(options.conversationId, { dir: root }))
        .filter((message) => message.parent_tool_use_id === null && message.type !== "system");
    const earlier = saved.flatMap((message) => claudeCodeEntries(message.type === "assistant" ? "assistant" : "user",
      typeof message.message === "object" && message.message !== null ? Reflect.get(message.message, "content") : undefined));
    const lastCall = saved.findLast((message) => message.type === "assistant");
    return new ClaudeCodeSession(options, root, existing, earlier, lastCall === undefined ? undefined : callContext(lastCall.message));
  }

  get usable(): boolean { return this.#usable; }

  /**
   * Continue this conversation on another Claude Code model (decision 026):
   * the next request resumes it with that model, as Claude Code's own
   * `/model` does.
   */
  async switchModel(target: ModelTarget): Promise<void> {
    if (target.engine !== "claude-code") throw new Error("That model runs on another engine; its conversation cannot continue here");
    this.#model = target.model;
    this.#effort = target.reasoning;
  }

  #emit(activity: AgentActivity): void { this.#options.onActivity?.(activity); }

  /** The conversation so far, including the turn in progress. */
  async conversation(): Promise<readonly ConversationEntry[]> { return [...this.#entries]; }

  /** The input the last API call read, cached or not. */
  contextTokens(): number | undefined { return this.#contextTokens; }

  #observe(message: SDKMessage): void {
    // Tool results come back as user messages; the request itself was recorded when it was sent.
    if (message.type === "user" && message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
      this.#entries.push(...claudeCodeEntries("user", message.message.content).filter((entry) => entry.role === "tool_result"));
    }
    if (message.type !== "assistant" || message.parent_tool_use_id !== null) return;
    this.#contextTokens = callContext(message.message) ?? this.#contextTokens;
    this.#entries.push(...claudeCodeEntries("assistant", message.message.content));
    const text = textOf(message.message.content).trim();
    if (text.length === 0) return;
    this.#message += 1;
    this.#emit({ type: "reply", message: this.#message, text, final: true });
  }

  /**
   * After each batch of tool calls: as on Pi, a batch whose every tool asked
   * to end the turn ends it, so no model call follows a submission.
   */
  readonly #afterBatch: HookCallback = async (input) => {
    const size = input.hook_event_name === "PostToolBatch" ? input.tool_calls.length : 0;
    const ends = size > 0 && this.#terminating === size;
    this.#terminating = 0;
    return ends ? { continue: false, stopReason: "Tesota's tool ended the turn." } : {};
  };

  #conversation(): Record<string, unknown> {
    const id = this.#options.conversationId;
    if (id === undefined) return { persistSession: false };
    return this.#conversationStarted ? { resume: id } : { sessionId: id };
  }

  /**
   * Run one request to completion, cancellation or a confirmed failure. A
   * stop ends the turn as Pi's abort does: Tesota's tools are cancelled and
   * Claude Code is interrupted, so the model takes no step after it; only when
   * Claude Code does not stop in time is its process ended. Anything the model
   * still says after the stop is neither shown nor kept.
   */
  async run(request: string, signal: AbortSignal): Promise<TurnResult> {
    if (!this.#usable) throw new Error("Coding session unavailable");
    if (signal.aborted) return { status: "cancelled" };
    const stopped = new AbortController();
    const abort = new AbortController();
    this.#signal = stopped.signal;
    this.#terminating = 0;
    this.#entries.push({ role: "user", text: request });
    const calls = new Set<Promise<unknown>>();
    const tools = this.#options.tools.map((definition) => sdkTool(definition, { signal: () => this.#signal,
      emit: (activity) => { if (!stopped.signal.aborted || activity.type === "tool_finished") this.#emit(activity); },
      next: () => `claude-${++this.#calls}`, terminate: () => { this.#terminating += 1; },
      track: (call) => { calls.add(call); void call.finally(() => calls.delete(call)); } }));
    const run = query({ prompt: request, options: {
      cwd: this.#root, model: this.#model, ...(this.#effort === undefined ? {} : { effort: this.#effort }), systemPrompt: this.#options.systemPrompt + toolNote,
      tools: [], mcpServers: { [server]: createSdkMcpServer({ name: server, version: "1.0.0", tools }) },
      // Every call goes through one gate: Tesota's tools are allowed there, and nothing else is.
      canUseTool: onlyTesotaTools, settingSources: [], strictMcpConfig: true, skills: [],
      hooks: { PostToolBatch: [{ hooks: [this.#afterBatch] }] }, abortController: abort,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "tesota", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...this.#options.configDirectory === undefined ? {} : { CLAUDE_CONFIG_DIR: this.#options.configDirectory } },
      ...this.#conversation(),
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      stopped.abort();
      timer = setTimeout(() => { abort.abort(); }, settlementMs);
      run.interrupt().catch(() => { abort.abort(); });
    };
    signal.addEventListener("abort", stop, { once: true });
    let result: SDKResultMessage | undefined;
    // Resolves once every call still in progress has settled, as Pi waits for its tools; false when one did not in time.
    const settled = async (): Promise<boolean> => {
      let limit: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<false>((resolve) => { limit = setTimeout(() => { resolve(false); }, settlementMs); });
      try { return await Promise.race([Promise.allSettled(calls).then(() => true), late]); } finally { clearTimeout(limit); }
    };
    try {
      for await (const message of run) {
        if (!stopped.signal.aborted) this.#observe(message);
        if (message.type === "result") result = message;
      }
    } catch (error) {
      if (!stopped.signal.aborted) return { status: "failed", reason: error instanceof Error ? error.message : "Claude Code failed" };
    } finally { signal.removeEventListener("abort", stop); clearTimeout(timer); }
    if (stopped.signal.aborted && !await settled()) { this.#usable = false; return { status: "unsettled" }; }
    if (result !== undefined) this.#options.onUsage?.(resultUsage(result));
    const turn = claudeCodeTurn(result, stopped.signal.aborted);
    if (turn.status === "completed" && this.#options.conversationId !== undefined) this.#conversationStarted = true;
    return turn;
  }

  dispose(): void { this.#usable = false; }
}
