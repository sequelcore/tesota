/**
 * What Tesota uses from its host, written down from Pi 1.3.0 (#433). Names
 * and shapes follow Pi's extension API, so Tesota's code runs on either
 * engine without renaming anything (#441). Only what Tesota uses is here.
 * The terminal interface (`ctx.ui`, message renderers, themes, components)
 * moves to the shell; until the shell exists (slice 6 of #432) the part
 * Tesota calls is typed from Pi (`ShellUI`, `ShellAPI`), and an engine with
 * no shell does nothing with it, as Pi's print mode. The conformance tests
 * in `tests/` check every engine against it, with Pi as the reference.
 */
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI as PiExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

/** How a run ended, as settle handlers see it. */
export type RunOutcome = "completed" | "aborted" | "error";

/**
 * How a session's last run ended, as the session reports it. `completed`
 * means its lifecycle finished with its verifier's settlement, not that
 * every check passed and never human acceptance. `incomplete` means the
 * run may not say it is done: a settle handler failed, the verifier had no
 * settle handler, or settlement sent the run back too often (#439); Pi has
 * no such state, which the conformance tests mark as a guarantee it lacks.
 * `interrupted` means the process ended during the run, as a resumed
 * session finds it.
 */
export type SessionOutcome = RunOutcome | "incomplete" | "interrupted";

/** A message an extension adds to the conversation at a boundary. */
export interface CustomMessageDraft {
  readonly type: "custom_message";
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
}

/**
 * Data an extension records in the session outside the conversation, as the
 * receipt does in print mode, where the final answer must stay the last message.
 */
export interface CustomEntryDraft {
  readonly type: "custom";
  readonly customType: string;
  readonly data?: unknown;
}

export type EntryDraft = CustomMessageDraft | CustomEntryDraft;

/** An entry on the session's current branch, as far as Tesota reads one: the operator's messages and its receipts. */
export interface BranchEntry {
  readonly type: string;
  readonly message?: { readonly role: string };
  readonly customType?: string;
  readonly details?: unknown;
  readonly data?: unknown;
}

export interface SessionStartEvent {
  readonly type: "session_start";
  readonly reason: "startup" | "reload" | "new" | "resume" | "fork";
}

/** The operator's input, before the agent runs; handlers finish before the agent's first step. */
export interface InputEvent {
  readonly type: "input";
  readonly text: string;
  readonly source: "interactive" | "rpc" | "extension";
  /** Set when the input arrives while the agent is running: steering or a follow-up. */
  readonly streamingBehavior?: "steer" | "followUp";
}

export interface ToolExecutionStartEvent {
  readonly type: "tool_execution_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

export interface ToolResultEvent {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly isError: boolean;
}

/** Before a run settles: handlers may add messages and send the agent back with `continue`. */
export interface SettleEvent {
  readonly type: "agent_before_settle";
  /** What earlier handlers added; Tesota does not read them. */
  readonly entries: readonly { readonly type: string }[];
  readonly continue: boolean;
  readonly outcome: RunOutcome;
  /**
   * Why the run did not complete, in plain words, when the engine knows:
   * the operator stopped it, the provider failed, a handler threw. Pi does
   * not say; the receipt of a run that was not verified states it (#439).
   */
  readonly reason?: string;
}

export interface SettleResult {
  entries?: EntryDraft[];
  continue?: boolean;
}

/** An input handler leaves the input as it is; Tesota never rewrites or swallows it. */
export interface InputResult {
  action: "continue";
}

export interface ContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

/** Model access through the host, for verifiers that ask a model (ClaimCheck). */
export interface ModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  complete(model: Model<Api>, context: Context, options?: { signal?: AbortSignal }): Promise<AssistantMessage>;
}

/** What Tesota draws through the shell; temporary until the shell owns it (slice 6 of #432). */
export type ShellUI = Pick<ExtensionUIContext, "setHeader" | "setFooter" | "setEditorComponent" | "setWorkingIndicator" | "setStatus"
  | "theme">;

/** How Tesota registers what the shell draws; temporary until the shell owns it (slice 6 of #432). */
export type ShellAPI = Pick<PiExtensionAPI, "registerMessageRenderer">;

/** What a handler knows about the session it runs in. */
export interface ExtensionContext {
  readonly ui: ShellUI;
  readonly cwd: string;
  readonly mode: string;
  readonly model: Model<Api> | undefined;
  readonly modelRegistry: ModelRegistry;
  readonly sessionManager: { getBranch(): readonly BranchEntry[] };
  readonly signal: AbortSignal | undefined;
  getContextUsage(): ContextUsage | undefined;
}

export interface ToolResult<Details = unknown> {
  content: { type: "text"; text: string }[];
  details: Details;
  /** The call failed, as a thrown error also says. */
  isError?: boolean;
}

export interface ToolDefinition<Parameters extends TSchema = TSchema, Details = unknown> {
  name: string;
  label: string;
  description: string;
  /** One line for the system prompt's list of tools while the tool is active. */
  promptSnippet?: string;
  /** Rules for the system prompt while the tool is active. */
  promptGuidelines?: string[];
  /** False keeps the tool from the model until an extension activates it. */
  defaultActive?: boolean;
  /** `sequential`: the call runs alone. */
  executionMode?: "sequential" | "parallel";
  /** What a call does, for the engine's permissions (#449): only reads, writes or edits files, or runs something; runs when not said. */
  access?: "read" | "write" | "run";
  parameters: Parameters;
  execute(toolCallId: string, params: Static<Parameters>, signal: AbortSignal | undefined, onUpdate: undefined,
    ctx: ExtensionContext): Promise<ToolResult<Details>>;
}

export type Handler<Event, Result> = (event: Event, ctx: ExtensionContext) => Result | Promise<Result>;

export type FlagOptions =
  | { description?: string; type: "boolean"; default?: boolean }
  | { description?: string; type: "string"; default?: string };

/** The API an extension receives when its session loads it. */
export interface ExtensionAPI extends ShellAPI {
  on(event: "session_start", handler: Handler<SessionStartEvent, void>): void;
  on(event: "input", handler: Handler<InputEvent, InputResult | undefined>): void;
  on(event: "tool_execution_start", handler: Handler<ToolExecutionStartEvent, void>): void;
  on(event: "tool_result", handler: Handler<ToolResultEvent, void>): void;
  on(event: "agent_before_settle", handler: Handler<SettleEvent, SettleResult | undefined>): void;
  registerTool<Parameters extends TSchema, Details>(tool: ToolDefinition<Parameters, Details>): void;
  registerFlag(name: string, options: FlagOptions): void;
  getFlag(name: string): boolean | string | undefined;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getThinkingLevel(): string;
  getSettings(): { quietStartup?: boolean | string };
}

export type ExtensionFactory = (pi: ExtensionAPI) => void;

/** Token use across a session. */
export interface SessionStats {
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
}

/** One message of the conversation, as the shell shows it. */
export interface ConversationMessage {
  readonly role: string;
  /** An extension message's custom type. */
  readonly customType?: string;
  /** A tool result's tool and whether the call failed. */
  readonly toolName?: string;
  readonly isError?: boolean;
  /** The message's text, its parts joined. */
  readonly text?: string;
}

/**
 * How input reaches a session: while a run is going, `streamingBehavior`
 * queues it as a steer or a follow-up, as in Pi; `source` says where it came
 * from, as the input event does.
 */
export interface PromptOptions {
  readonly streamingBehavior?: "steer" | "followUp";
  readonly source?: InputEvent["source"];
}

/** One conversation, its model and its extensions, as the shell drives it. */
export interface Session {
  /**
   * Sends input and resolves once the run has settled; input queued during a
   * run resolves once it is accepted.
   */
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  /** The conversation in order, without the system prompt. */
  messages(): readonly ConversationMessage[];
  lastAssistantText(): string | undefined;
  stats(): SessionStats;
  /** How the last run ended; undefined before the first run settles. */
  outcome(): SessionOutcome | undefined;
  /** Stops the run, waits for it to end, and releases what the session holds. */
  dispose(): Promise<void>;
}
