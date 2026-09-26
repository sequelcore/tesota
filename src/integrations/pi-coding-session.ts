import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type AgentSession, type AgentSessionEvent, type BashOperations, type ModelRuntime, type SessionManager, type ToolDefinition,
  createAgentSession, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, DefaultResourceLoader, defineTool, SessionManager as PiSessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, TSchema } from "@earendil-works/pi-ai";
import { allowsAutonomy, type ExecutionEnvironment } from "../execution-environment.js";

export type CommandApproval = "once" | "always" | "deny";
/** How the operator answered a refused network destination: for this session, for the repository, or not at all. */
export type NetworkDecision = "session" | "repository" | "deny";

/**
 * What the agent is doing, as it happens, for a surface to show. `reply`
 * carries the full text of one assistant message so far; `message` numbers
 * the messages of a session in order.
 */
export type AgentActivity =
  | Readonly<{ type: "reply"; message: number; text: string; final: boolean }>
  | Readonly<{ type: "tool_started"; call: string; tool: string; subject: string }>
  | Readonly<{ type: "tool_output"; call: string; output: string }>
  | Readonly<{ type: "tool_finished"; call: string; failed: boolean; output: string; change?: AgentChange }>;

export interface AgentChange {
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly string[];
}

export type CodingTurnResult =
  | Readonly<{ status: "completed"; reply: string }>
  | Readonly<{ status: "failed"; reason: string }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "unsettled" }>;

export interface CodingSessionOptions {
  /** The workspace checkout; every file tool is confined to it. */
  readonly cwd: string;
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly sessionManager?: SessionManager;
  /** Where shell commands run. File tools always act on the workspace from the host. */
  readonly environment: ExecutionEnvironment;
  /** Commands run without approval; only allowed for an environment that confines them. */
  readonly autonomous: boolean;
  readonly approveCommand: (command: string, signal: AbortSignal | undefined) => Promise<CommandApproval>;
  /** Asked after a command whose network access the environment refused. */
  readonly decideNetwork?: (destinations: readonly string[]) => Promise<NetworkDecision>;
  readonly onActivity?: (activity: AgentActivity) => void;
}

const settlementMs = 10_000;
const instructionFiles = ["AGENTS.md", "CLAUDE.md"];
const instructionLimit = 32 * 1024;

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

function existingRealpath(path: string): string {
  let current = path;
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...missing.reverse()); } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("Path unavailable");
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Resolve a tool path the way Pi does and require it to stay inside the workspace. */
export function confinedPath(root: string, path: string | undefined, write: boolean): string {
  const requested = (path ?? ".").replace(/^@/u, "");
  if (requested.startsWith("~")) throw new Error(`Path is outside the workspace: ${requested}`);
  const actual = existingRealpath(resolve(root, requested));
  if (!contains(root, actual)) throw new Error(`Path is outside the workspace: ${requested}`);
  if (write && relative(root, actual).split(/[\\/]/u)[0]?.toLowerCase() === ".git") {
    throw new Error("The workspace's .git directory cannot be changed");
  }
  return actual;
}

function confine<P extends TSchema, D, S>(root: string, tool: ToolDefinition<P, D, S>,
  write: boolean): ToolDefinition<P, D, S> {
  return { ...tool, execute: (id, params, signal, onUpdate, ctx) => {
    const path: unknown = typeof params === "object" && params !== null ? Reflect.get(params, "path") : undefined;
    confinedPath(root, typeof path === "string" ? path : undefined, write);
    return tool.execute(id, params, signal, onUpdate, ctx);
  } };
}

/**
 * Ask the operator about destinations the environment refused during a
 * command, open the allowed ones, and tell the agent the outcome in the
 * command's output. The proxy cannot hold a connection open for an answer,
 * so the agent reruns the command instead.
 */
async function answerRefusedNetwork(environment: ExecutionEnvironment,
  decide: NonNullable<CodingSessionOptions["decideNetwork"]>, since: Date, onData: (data: Buffer) => void): Promise<void> {
  const network = environment.network;
  if (network === undefined) return;
  const refused = await network.blockedSince(since);
  if (refused.length === 0) return;
  const list = refused.join(", ");
  if (await decide(refused) === "deny") {
    onData(Buffer.from(`\nTesota: the sandbox refused network access to ${list}, and the user declined to allow it. ` +
      "Do not try to reach it another way; continue without it or explain what you need.\n"));
    return;
  }
  await network.allow(refused);
  onData(Buffer.from(`\nTesota: the sandbox refused network access to ${list}; the user has now allowed it. ` +
    "Run the command again if it needed that access.\n"));
}

/**
 * Adapt Pi's shell tool to the session's execution environment. Pi passes the
 * host process environment with each command; it is dropped so no provider
 * receives host variables by default.
 */
export function environmentBash(environment: ExecutionEnvironment,
  approve: CodingSessionOptions["approveCommand"] | undefined,
  decideNetwork?: CodingSessionOptions["decideNetwork"]): BashOperations {
  let alwaysAllowed = approve === undefined;
  return {
    exec: async (command, cwd, options) => {
      if (!alwaysAllowed && approve !== undefined) {
        const answer = await approve(command, options.signal);
        if (answer === "deny") {
          options.onData(Buffer.from("The operator declined this command. Do not retry it; ask or choose another approach.\n"));
          return { exitCode: 1 };
        }
        if (answer === "always") alwaysAllowed = true;
      }
      const started = new Date();
      const result = await environment.run(command, { cwd, onOutput: options.onData,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }) });
      if (decideNetwork !== undefined && (result.outcome === "exited" || result.outcome === "timed_out")) {
        await answerRefusedNetwork(environment, decideNetwork, started, options.onData);
      }
      if (result.outcome === "cancelled") throw new Error("aborted");
      if (result.outcome === "timed_out") throw new Error(`timeout:${options.timeout ?? 0}`);
      if (result.outcome === "not_started") throw new Error(`The command could not start in the ${environment.provider} environment`);
      if (result.outcome === "unconfirmed") throw new Error("The command was stopped, but it could not be confirmed that it ended");
      return { exitCode: result.exitCode };
    },
  };
}

/** The repository's AGENTS.md or CLAUDE.md, for an agent's context. */
export function repositoryInstructions(root: string): string {
  for (const name of instructionFiles) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").slice(0, instructionLimit);
    return `\n\nRepository instructions from ${name}:\n${text}`;
  }
  return "";
}

function commandGuidance(autonomous: boolean): string {
  return autonomous
    ? "Shell commands run without asking in an isolated sandbox that sees only this copy of the repository; " +
      "network access is limited to package registries and hosts the user allowed. When a command reaches " +
      "another host, the user is asked whether to allow it and you are told the answer. "
    : "Every shell command asks the user for approval first; prefer the file tools for reading and editing, " +
      "and run commands when they are worth an approval, such as installing dependencies or running tests. ";
}

function systemPrompt(root: string, autonomous: boolean): string {
  return "You are Tesota, a coding agent working in a private copy of the user's repository. " +
    "Read, search, edit, create and delete files as the task needs. " + commandGuidance(autonomous) +
    "Do not commit, push or change Git " +
    "history: when you finish, Tesota shows the user your changes, runs the repository's checks and lets " +
    "the user apply or reject them. End each turn with a short summary of what you changed and anything " +
    "the user should verify. If a request needs no changes, just answer it." +
    `\n\nPlatform: ${process.platform}.` + repositoryInstructions(root);
}

function replyText(session: AgentSession): string {
  const assistant = session.messages.findLast((message) => message.role === "assistant");
  if (assistant?.role !== "assistant") return "";
  return assistant.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
}

/** The argument that identifies what a tool call acts on: its command, pattern or path. */
function toolSubject(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const key = name === "bash" ? "command" : name === "grep" || name === "find" ? "pattern" : "path";
  const value: unknown = Reflect.get(args, key);
  return typeof value === "string" ? value : "";
}

/** The text parts of a message or tool result, in order. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: unknown) => typeof part === "object" && part !== null &&
    Reflect.get(part, "type") === "text" && typeof Reflect.get(part, "text") === "string"
    ? [String(Reflect.get(part, "text"))] : []).join("\n");
}

function resultText(result: unknown): string {
  return typeof result === "object" && result !== null ? textOf(Reflect.get(result, "content")) : "";
}

/** A bounded view of the patch Pi reports after a successful edit. */
function editChange(result: unknown): AgentChange | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const details: unknown = Reflect.get(result, "details");
  const patch: unknown = typeof details === "object" && details !== null ? Reflect.get(details, "patch") : undefined;
  if (typeof patch !== "string") return undefined;
  const lines = patch.split(/\r?\n/u).filter((line) => line.startsWith("@@") ||
    line.startsWith("+") && !line.startsWith("+++") || line.startsWith("-") && !line.startsWith("---"));
  const added = lines.filter((line) => line.startsWith("+")).length;
  const removed = lines.filter((line) => line.startsWith("-")).length;
  return { added, removed, lines: lines.slice(0, 8).map((line) => line.slice(0, 400)) };
}

/** Map one Pi session event to what a surface shows; other events show nothing. */
export function activityOf(event: AgentSessionEvent, message: number): AgentActivity | undefined {
  switch (event.type) {
    case "message_update":
    case "message_end":
      return event.message.role === "assistant"
        ? { type: "reply", message, text: textOf(event.message.content).trim(), final: event.type === "message_end" }
        : undefined;
    case "tool_execution_start":
      return { type: "tool_started", call: event.toolCallId, tool: event.toolName, subject: toolSubject(event.toolName, event.args) };
    case "tool_execution_update":
      return { type: "tool_output", call: event.toolCallId, output: resultText(event.partialResult) };
    case "tool_execution_end": {
      const change = event.toolName === "edit" && !event.isError ? editChange(event.result) : undefined;
      return { type: "tool_finished", call: event.toolCallId, failed: event.isError, output: resultText(event.result),
        ...(change === undefined ? {} : { change }) };
    }
    default:
      return undefined;
  }
}

/** The tokens a finished model response used, as its provider reported them; undefined for any other event. */
export function responseTokens(event: AgentSessionEvent): number | undefined {
  return event.type === "message_end" && event.message.role === "assistant" ? event.message.usage.totalTokens : undefined;
}

/** The file tools that only read, each confined to the workspace. */
export function readOnlyFileTools(root: string): ToolDefinition[] {
  return [
    defineTool(confine(root, createReadToolDefinition(root), false)),
    defineTool(confine(root, createGrepToolDefinition(root), false)),
    defineTool(confine(root, createFindToolDefinition(root), false)),
    defineTool(confine(root, createLsToolDefinition(root), false)),
  ];
}

/** The model a read-only Tesota session uses, and where its token usage is counted. */
export interface ModelAccess {
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  /** Called with the tokens of each finished model response, as the provider reported them. */
  readonly onUsage?: (tokens: number) => void;
}

/** The session options that carry a model access's usage counter, when it has one. */
export function usageOption(access: ModelAccess): Pick<SessionStartOptions, "onUsage"> {
  return access.onUsage === undefined ? {} : { onUsage: access.onUsage };
}

export interface SessionStartOptions {
  readonly cwd: string;
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
  readonly sessionManager?: SessionManager;
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly onActivity?: (activity: AgentActivity) => void;
  /** Called with the tokens of each finished model response, as the provider reported them. */
  readonly onUsage?: (tokens: number) => void;
}

/** A general coding conversation whose file tools cannot leave the workspace. */
export class CodingSession {
  readonly #session: AgentSession;
  readonly #unsubscribe: () => void;
  #usable = true;

  private constructor(session: AgentSession, onActivity: ((activity: AgentActivity) => void) | undefined,
    onUsage: ((tokens: number) => void) | undefined) {
    this.#session = session;
    let message = session.messages.filter((entry) => entry.role === "assistant").length;
    this.#unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") message += 1;
      const tokens = onUsage === undefined ? undefined : responseTokens(event);
      if (tokens !== undefined) onUsage?.(tokens);
      const activity = onActivity === undefined ? undefined : activityOf(event, message);
      if (activity !== undefined) onActivity?.(activity);
    });
  }

  /** The working agent: every file tool confined to the workspace, and commands in its environment. */
  static async create(options: CodingSessionOptions): Promise<CodingSession> {
    if (options.autonomous && !allowsAutonomy(options.environment.guarantees)) {
      throw new Error("Autonomous sessions require an environment that confines files and network");
    }
    const root = realpathSync(options.cwd);
    return CodingSession.start({ ...options, systemPrompt: systemPrompt(root, options.autonomous), tools: [
      ...readOnlyFileTools(root),
      defineTool(confine(root, createEditToolDefinition(root), true)),
      defineTool(confine(root, createWriteToolDefinition(root), true)),
      defineTool(createBashToolDefinition(root, { operations: environmentBash(options.environment,
        options.autonomous ? undefined : options.approveCommand, options.decideNetwork),
        exposeSessionEnvironment: false })),
    ] });
  }

  /**
   * A Pi session with exactly these tools and this system prompt: no
   * extensions, skills, prompt templates or context files are loaded.
   */
  static async start(options: SessionStartOptions): Promise<CodingSession> {
    const root = realpathSync(options.cwd);
    const settingsManager = SettingsManager.inMemory({ defaultTools: [], enableSkillCommands: false },
      { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: options.systemPrompt });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: root, modelRuntime: options.modelRuntime, model: options.model,
      thinkingLevel: "medium", sessionManager: options.sessionManager ?? PiSessionManager.inMemory(root),
      settingsManager, resourceLoader, tools: options.tools.map((tool) => tool.name), customTools: [...options.tools] });
    return new CodingSession(session, options.onActivity, options.onUsage);
  }

  get usable(): boolean { return this.#usable; }

  /** Run one user request to completion, cancellation or a confirmed failure. */
  async run(request: string, signal: AbortSignal): Promise<CodingTurnResult> {
    if (!this.#usable) throw new Error("Coding session unavailable");
    if (signal.aborted) return { status: "cancelled" };
    let failed: string | undefined;
    const prompt = this.#session.prompt(request, { expandPromptTemplates: false })
      .catch((error: unknown) => { failed = error instanceof Error ? error.message : "The model request failed"; });
    let abortRequested = false;
    let onAbort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => { abortRequested = true; resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { await Promise.race([prompt, aborted]); } finally { signal.removeEventListener("abort", onAbort); }
    if (abortRequested) {
      const abort = this.#session.abort().catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([Promise.all([abort, prompt]).then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false); }, settlementMs); })]);
      clearTimeout(timer);
      if (!settled) { this.#usable = false; return { status: "unsettled" }; }
      return { status: "cancelled" };
    }
    const assistant = this.#session.messages.findLast((message) => message.role === "assistant");
    const error = failed ?? (assistant?.role === "assistant" ? assistant.errorMessage : undefined);
    if (error !== undefined) return { status: "failed", reason: error };
    return { status: "completed", reply: replyText(this.#session) };
  }

  dispose(): void {
    this.#usable = false;
    this.#unsubscribe();
    this.#session.dispose();
  }
}
