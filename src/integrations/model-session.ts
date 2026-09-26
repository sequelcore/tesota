import { ModelRuntime, type SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseModelChoice, type ReasoningLevel } from "../model-roles.js";
import type { TokenUsage } from "../token-usage.js";
import { ClaudeCodeSession } from "./claude-code-session.js";
import { TesotaCredentials } from "./tesota-credentials.js";
import type { AgentActivity, ConversationEntry, ModelSession } from "./model-session-contract.js";
import { type CodingSessionOptions, CodingSession, type WorkingAgentOptions, workingAgentSetup } from "./pi-coding-session.js";

/**
 * One interface over the engines a role can run on (decision 021): Pi, for
 * the `codex` and `anthropic` routes, and Claude Code, for `claude-code`. A
 * role's prompt, tools, results, activity and token counts are the same on
 * either.
 */

/**
 * Which engine runs a role, the model it uses, and how much it reasons
 * (decision 029); without a level, Pi reasons at medium and Claude Code at
 * its model's default.
 */
export type ModelTarget =
  | Readonly<{ engine: "pi"; modelRuntime: ModelRuntime; model: Model<Api>; reasoning?: ReasoningLevel }>
  | Readonly<{ engine: "claude-code"; model: string; reasoning?: ReasoningLevel }>;

function reasoningOf(target: ModelTarget): { reasoning?: ReasoningLevel } {
  return target.reasoning === undefined ? {} : { reasoning: target.reasoning };
}

/** Pi's provider for each route it serves. */
const piProviders = { codex: "openai-codex", anthropic: "anthropic" } as const;

/**
 * The engine and model for a `route:model` choice. Pi's routes read Tesota's
 * own credentials: Codex's OAuth login or an Anthropic API key. The
 * `claude-code` route needs nothing from Tesota; Claude Code signs in itself.
 */
export async function openModelTarget(choice: string, signal?: AbortSignal,
  credentials: TesotaCredentials = new TesotaCredentials()): Promise<ModelTarget> {
  const parsed = parseModelChoice(choice);
  if (parsed === undefined) throw new Error(`${choice} is not a route:model choice. Check tesota models.`);
  const reasoning = parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning };
  if (parsed.route === "claude-code") return { engine: "claude-code", model: parsed.model, ...reasoning };
  const modelRuntime = await ModelRuntime.create({ credentials, refreshOnCreate: false, allowModelNetwork: false,
    ...(signal === undefined ? {} : { signal }) });
  const model = modelRuntime.getModel(piProviders[parsed.route], parsed.model);
  if (model === undefined) throw new Error(`${choice} is unavailable. Check tesota models and tesota auth status.`);
  return { engine: "pi", modelRuntime, model, ...reasoning };
}

/** The model a role uses, and where its token usage is counted. */
export interface ModelAccess {
  readonly target: ModelTarget;
  /** Called with the tokens each model call used, by kind, as the provider reported them. */
  readonly onUsage?: (usage: TokenUsage) => void;
}

export interface RoleSessionOptions {
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly onActivity?: (activity: AgentActivity) => void;
  /** Where Pi saves the conversation; Claude Code keeps none for a role. */
  readonly sessionManager?: SessionManager;
}

function usage(access: ModelAccess): { onUsage?: (usage: TokenUsage) => void } {
  return access.onUsage === undefined ? {} : { onUsage: access.onUsage };
}

/** A fresh session for one role, with exactly these tools and this system prompt. */
export async function startModelSession(access: ModelAccess, options: RoleSessionOptions): Promise<ModelSession> {
  const { target } = access;
  if (target.engine === "pi") {
    return CodingSession.start({ ...options, modelRuntime: target.modelRuntime, model: target.model, ...reasoningOf(target),
      ...usage(access) });
  }
  const { sessionManager: _unused, ...claude } = options;
  return ClaudeCodeSession.start({ ...claude, model: target.model, ...reasoningOf(target), ...usage(access) });
}

/** How the working agent's conversation is kept on each engine. */
export interface WorkingAgentConversation {
  /** Pi saves the conversation through its session manager. */
  readonly sessionManager?: SessionManager;
  /** Claude Code saves it under this id, and resumes it when it exists. */
  readonly conversationId: string;
}

/** The working agent's session: a role session that keeps its conversation, on a model that can change. */
export interface WorkingAgent extends ModelSession {
  /** Whether the agent continues a conversation it already had, rather than starting one. */
  readonly resumed: boolean;
  /** Continue the conversation on another model of the same engine (decision 026). */
  switchModel(target: ModelTarget): Promise<void>;
  /** The conversation so far, including the turn in progress, as the engine holds it (decision 027). */
  conversation(): Promise<readonly ConversationEntry[]>;
  /**
   * The input tokens the last model call read, cached or not: what the next
   * call re-reads, and without cache after a switch of model or reasoning
   * level. Undefined before the first call.
   */
  contextTokens(): number | undefined;
}

/** The working agent on its chosen engine, with the same tools and prompt on each. */
export async function startWorkingAgent(access: ModelAccess, options: WorkingAgentOptions &
  Pick<CodingSessionOptions, "onActivity">, conversation: WorkingAgentConversation): Promise<WorkingAgent> {
  const { target } = access;
  if (target.engine === "pi") {
    return CodingSession.create({ ...options, modelRuntime: target.modelRuntime, model: target.model, ...reasoningOf(target),
      ...usage(access),
      ...(conversation.sessionManager === undefined ? {} : { sessionManager: conversation.sessionManager }) });
  }
  return ClaudeCodeSession.start({ cwd: options.cwd, model: target.model, ...reasoningOf(target), ...workingAgentSetup(options),
    ...usage(access),
    ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }), conversationId: conversation.conversationId });
}
