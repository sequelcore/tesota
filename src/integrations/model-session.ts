import { createRequire } from "node:module";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ModelChoice, parseModelChoice, type ReasoningLevel, type RouteKind } from "../model-roles.js";
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
  | Readonly<{ engine: "pi"; route: string; modelRuntime: ModelRuntime; model: Model<Api>; reasoning?: ReasoningLevel }>
  | Readonly<{ engine: "claude-code"; route: string; model: string; reasoning?: ReasoningLevel;
    /** Claude Code's configuration folder for an added route, where that account is signed in; the operator's own otherwise. */
    configDirectory?: string }>;

/** Where an added `claude-code` route's account is signed in (decision 050): a configuration folder of its own. */
export function claudeCodeRouteDirectory(route: string): string {
  return join(homedir(), ".tesota", "claude-code", route);
}

/** Whether two choices use the same account: the same route, or two kinds' default routes, which share Tesota's own sign-ins. */
export function sameAccount(from: ModelChoice, to: ModelChoice): boolean {
  return from.route === to.route || from.route === from.kind && to.route === to.kind;
}

function reasoningOf(target: ModelTarget): { reasoning?: ReasoningLevel } {
  return target.reasoning === undefined ? {} : { reasoning: target.reasoning };
}

function configOf(target: Extract<ModelTarget, { engine: "claude-code" }>): { configDirectory?: string } {
  return target.configDirectory === undefined ? {} : { configDirectory: target.configDirectory };
}

/** Pi's provider for each kind of route it serves. */
const piProviders = { codex: "openai-codex", anthropic: "anthropic", openrouter: "openrouter", opencode: "opencode",
  "opencode-go": "opencode-go" } as const satisfies Partial<Record<RouteKind, string>>;

/** How Tesota names itself to a gateway, as OpenCode Go asks of every client: its own name and version, and the system. */
export function tesotaUserAgent(): string {
  const manifest: unknown = createRequire(import.meta.url)("../../package.json");
  const version = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
  return `tesota/${typeof version === "string" ? version : "0.0.0"} (${platform()} ${release()}; ${arch()})`;
}

/**
 * The headers that name Tesota on a gateway route (decision 031), in place
 * of Pi's own. Pi adds OpenCode's `x-opencode-session` from the
 * conversation's id, which OpenCode needs to route and cache; the client is
 * Tesota. OpenRouter is sent no app attribution, which would list Tesota
 * publicly in its rankings.
 */
function identityHeaders(route: RouteKind): Record<string, string> | undefined {
  if (route === "openrouter") return { "User-Agent": tesotaUserAgent() };
  if (route === "opencode" || route === "opencode-go") return { "User-Agent": tesotaUserAgent(), "x-opencode-client": "tesota" };
  return undefined;
}

/**
 * The engine and model for a `route:model` choice. The kind decides the
 * engine and the model; the route decides the account (decision 050). Pi's
 * routes read Tesota's own credentials, an added route's from its own file.
 * The `claude-code` route needs nothing from Tesota; Claude Code signs in
 * itself, an added route in its own configuration folder.
 */
export async function openModelTarget(choice: string, signal?: AbortSignal,
  credentials: TesotaCredentials = new TesotaCredentials()): Promise<ModelTarget> {
  const parsed = parseModelChoice(choice);
  if (parsed === undefined) throw new Error(`${choice} is not a route:model choice. Check tesota models.`);
  const reasoning = parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning };
  const added = parsed.route !== parsed.kind;
  if (parsed.kind === "claude-code") {
    return { engine: "claude-code", route: parsed.route, model: parsed.model, ...reasoning,
      ...added ? { configDirectory: claudeCodeRouteDirectory(parsed.route) } : {} };
  }
  const provider = piProviders[parsed.kind];
  const modelRuntime = await ModelRuntime.create({ credentials: added ? TesotaCredentials.forRoute(parsed.route, provider) : credentials,
    refreshOnCreate: false, allowModelNetwork: false, ...(signal === undefined ? {} : { signal }) });
  const model = modelRuntime.getModel(provider, parsed.model);
  if (model === undefined) throw new Error(`${choice} is unavailable. Check tesota models and tesota auth status.`);
  const identity = identityHeaders(parsed.kind);
  return { engine: "pi", route: parsed.route, modelRuntime,
    model: identity === undefined ? model : { ...model, headers: { ...model.headers, ...identity } }, ...reasoning };
}

/**
 * A session whose failed requests name their route, so the operator knows
 * which account's plan refused or ran out, as a lapsed ChatGPT plan did on
 * 2026-09-29 with nothing saying which account it was.
 */
export function namingRoute<T extends ModelSession>(route: string, session: T): T {
  return new Proxy(session, {
    get(target, property) {
      if (property === "run") {
        return async (request: string, signal: AbortSignal) => {
          const turn = await target.run(request, signal);
          return turn.status === "failed" ? { ...turn, reason: `${route}: ${turn.reason}` } : turn;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
    return namingRoute(target.route, await CodingSession.start({ ...options, modelRuntime: target.modelRuntime, model: target.model,
      ...reasoningOf(target), ...usage(access) }));
  }
  const { sessionManager: _unused, ...claude } = options;
  return namingRoute(target.route, await ClaudeCodeSession.start({ ...claude, model: target.model, ...reasoningOf(target),
    ...configOf(target), ...usage(access) }));
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
  /**
   * Add the operator's message to the run in progress, read before the agent's
   * next step; false when no run is in progress. Absent on Claude Code, whose
   * query takes its one prompt when it starts.
   */
  steer?(text: string): boolean;
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
    return namingRoute(target.route, await CodingSession.create({ ...options, modelRuntime: target.modelRuntime, model: target.model,
      ...reasoningOf(target), ...usage(access),
      ...(conversation.sessionManager === undefined ? {} : { sessionManager: conversation.sessionManager }) }));
  }
  return namingRoute(target.route, await ClaudeCodeSession.start({ cwd: options.cwd, model: target.model, ...reasoningOf(target),
    ...configOf(target), ...workingAgentSetup(options), ...usage(access),
    ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }), conversationId: conversation.conversationId }));
}
