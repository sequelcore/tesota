import { realpathSync } from "node:fs";
import { createSdkMcpServer, getSessionInfo, query, tool, type CanUseTool, type SDKMessage,
  type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as z from "zod";
import { type AgentActivity, type CodingTurnResult, editChange, resultText, textOf, toolSubject } from "./pi-coding-session.js";

/**
 * A role's session on Claude Code (decision 021), run by the Claude Agent SDK
 * with the Claude Code program it bundles, unmodified. Claude Code signs in by
 * itself, through Anthropic's own flow; Tesota never reads its credentials.
 *
 * The session gets Tesota's own tools and nothing else: every built-in tool
 * is disabled, Tesota's tools come from an in-process MCP server, and any
 * other call is refused. None of the operator's Claude Code settings,
 * CLAUDE.md, hooks, skills or MCP servers load.
 */

const server = "tesota";
const prefix = `mcp__${server}__`;

export interface ClaudeCodeSessionOptions {
  readonly cwd: string;
  /** A Claude Code model alias, such as `opus`, or a full model id. */
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly onActivity?: (activity: AgentActivity) => void;
  readonly onUsage?: (tokens: number) => void;
  /**
   * The conversation to keep across requests, under this id, for the working
   * agent; read-only roles keep none.
   */
  readonly conversationId?: string;
}

/** Every token a run used, over all the models it called, as Claude Code reported them. */
export function resultTokens(result: SDKResultMessage): number {
  return Object.values(result.modelUsage).reduce((total, usage) => total + usage.inputTokens + usage.outputTokens +
    usage.cacheReadInputTokens + usage.cacheCreationInputTokens, 0);
}

/** How a run ended, from its result message; a run that stopped without one did not finish. */
export function claudeCodeTurn(result: SDKResultMessage | undefined, cancelled: boolean): CodingTurnResult {
  if (cancelled) return { status: "cancelled" };
  if (result === undefined) return { status: "failed", reason: "Claude Code stopped without a result" };
  if (result.subtype === "success" && !result.is_error) return { status: "completed", reply: result.result.trim() };
  const reason = result.subtype === "success" ? result.result : result.errors.join("; ");
  return { status: "failed", reason: reason.trim() || result.subtype };
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

/** One of Tesota's tools, run by Tesota when Claude Code calls it, reporting its activity as Pi's would. */
function sdkTool(definition: ToolDefinition, signal: () => AbortSignal, emit: Emit, next: () => string) {
  return tool(definition.name, definition.description, toolShape(definition.parameters), async (args) => {
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
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      const output = error instanceof Error ? error.message : "The tool failed";
      emit({ type: "tool_finished", call, failed: true, output });
      return { content: [{ type: "text" as const, text: output }], isError: true };
    }
  });
}

const toolNote = "\n\nYour tools are Tesota's, named with the prefix `mcp__tesota__`: for example `read` is " +
  "`mcp__tesota__read`. No other tools are available.";

export class ClaudeCodeSession {
  readonly #options: ClaudeCodeSessionOptions;
  readonly #root: string;
  #usable = true;
  #message = 0;
  #calls = 0;
  #conversationStarted = false;
  #signal: AbortSignal = new AbortController().signal;

  private constructor(options: ClaudeCodeSessionOptions, root: string, conversationStarted: boolean) {
    this.#options = options;
    this.#root = root;
    this.#conversationStarted = conversationStarted;
  }

  /** A working agent's conversation resumes if Claude Code already holds it for this workspace. */
  static async start(options: ClaudeCodeSessionOptions): Promise<ClaudeCodeSession> {
    const root = realpathSync(options.cwd);
    const existing = options.conversationId === undefined ? false
      : await getSessionInfo(options.conversationId, { dir: root }) !== undefined;
    return new ClaudeCodeSession(options, root, existing);
  }

  get usable(): boolean { return this.#usable; }

  #emit(activity: AgentActivity): void { this.#options.onActivity?.(activity); }

  #observe(message: SDKMessage): void {
    if (message.type !== "assistant" || message.parent_tool_use_id !== null) return;
    const text = textOf(message.message.content).trim();
    if (text.length === 0) return;
    this.#message += 1;
    this.#emit({ type: "reply", message: this.#message, text, final: true });
  }

  #conversation(): Record<string, unknown> {
    const id = this.#options.conversationId;
    if (id === undefined) return { persistSession: false };
    return this.#conversationStarted ? { resume: id } : { sessionId: id };
  }

  /** Run one request to completion, cancellation or a confirmed failure. */
  async run(request: string, signal: AbortSignal): Promise<CodingTurnResult> {
    if (!this.#usable) throw new Error("Coding session unavailable");
    if (signal.aborted) return { status: "cancelled" };
    const abort = new AbortController();
    const stop = (): void => { abort.abort(); };
    signal.addEventListener("abort", stop, { once: true });
    this.#signal = abort.signal;
    const tools = this.#options.tools.map((definition) => sdkTool(definition, () => this.#signal,
      (activity) => { this.#emit(activity); }, () => `claude-${++this.#calls}`));
    let result: SDKResultMessage | undefined;
    try {
      for await (const message of query({ prompt: request, options: {
        cwd: this.#root, model: this.#options.model, systemPrompt: this.#options.systemPrompt + toolNote,
        tools: [], mcpServers: { [server]: createSdkMcpServer({ name: server, version: "1.0.0", tools }) },
        // Every call goes through one gate: Tesota's tools are allowed there, and nothing else is.
        canUseTool: onlyTesotaTools, settingSources: [], strictMcpConfig: true, skills: [],
        abortController: abort, env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "tesota" },
        ...this.#conversation(),
      } })) {
        this.#observe(message);
        if (message.type === "result") result = message;
      }
    } catch (error) {
      if (!abort.signal.aborted) return { status: "failed", reason: error instanceof Error ? error.message : "Claude Code failed" };
    } finally { signal.removeEventListener("abort", stop); }
    if (result !== undefined) this.#options.onUsage?.(resultTokens(result));
    const turn = claudeCodeTurn(result, abort.signal.aborted);
    if (turn.status === "completed" && this.#options.conversationId !== undefined) this.#conversationStarted = true;
    return turn;
  }

  dispose(): void { this.#usable = false; }
}
