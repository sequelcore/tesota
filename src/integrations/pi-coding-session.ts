import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type AgentSession, type BashOperations, type ModelRuntime, type SessionManager, type ToolDefinition,
  createAgentSession, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, DefaultResourceLoader, defineTool, SessionManager as PiSessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, TSchema } from "@earendil-works/pi-ai";
import type { ExecutionEnvironment } from "../execution-environment.js";

export type CommandApproval = "once" | "always" | "deny";

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
  readonly approveCommand: (command: string, signal: AbortSignal | undefined) => Promise<CommandApproval>;
  readonly onActivity?: (text: string) => void;
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
 * Adapt Pi's shell tool to the session's execution environment. Pi passes the
 * host process environment with each command; it is dropped so no provider
 * receives host variables by default.
 */
function environmentBash(environment: ExecutionEnvironment, approve: CodingSessionOptions["approveCommand"]): BashOperations {
  let alwaysAllowed = false;
  return {
    exec: async (command, cwd, options) => {
      if (!alwaysAllowed) {
        const answer = await approve(command, options.signal);
        if (answer === "deny") {
          options.onData(Buffer.from("The operator declined this command. Do not retry it; ask or choose another approach.\n"));
          return { exitCode: 1 };
        }
        if (answer === "always") alwaysAllowed = true;
      }
      const result = await environment.run(command, { cwd, onOutput: options.onData,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeout === undefined ? {} : { timeoutSeconds: options.timeout }) });
      if (result.outcome === "cancelled") throw new Error("aborted");
      if (result.outcome === "timed_out") throw new Error(`timeout:${options.timeout ?? 0}`);
      if (result.outcome === "not_started") throw new Error(`The command could not start in the ${environment.provider} environment`);
      return { exitCode: result.exitCode };
    },
  };
}

function repositoryInstructions(root: string): string {
  for (const name of instructionFiles) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").slice(0, instructionLimit);
    return `\n\nRepository instructions from ${name}:\n${text}`;
  }
  return "";
}

function systemPrompt(root: string): string {
  return "You are Tesota, a coding agent working in a private copy of the user's repository. " +
    "Read, search, edit, create and delete files as the task needs. Every shell command asks the user " +
    "for approval first; prefer the file tools for reading and editing, and run commands when they are " +
    "worth an approval, such as installing dependencies or running tests. Do not commit, push or change Git " +
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

function describeTool(name: string, args: unknown): string {
  const field = (key: string): string => {
    if (typeof args !== "object" || args === null) return "";
    const value: unknown = Reflect.get(args, key);
    return typeof value === "string" ? value : "";
  };
  if (name === "bash") return `Running ${field("command")}`;
  if (name === "grep" || name === "find") return `Searching ${field("pattern")}`;
  return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)} ${field("path")}`.trim();
}

/** A general coding conversation whose file tools cannot leave the workspace. */
export class CodingSession {
  readonly #session: AgentSession;
  readonly #unsubscribe: () => void;
  #usable = true;

  private constructor(session: AgentSession, onActivity: ((text: string) => void) | undefined) {
    this.#session = session;
    this.#unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") onActivity?.(describeTool(event.toolName, event.args));
    });
  }

  static async create(options: CodingSessionOptions): Promise<CodingSession> {
    const root = realpathSync(options.cwd);
    const tools: ToolDefinition[] = [
      defineTool(confine(root, createReadToolDefinition(root), false)),
      defineTool(confine(root, createGrepToolDefinition(root), false)),
      defineTool(confine(root, createFindToolDefinition(root), false)),
      defineTool(confine(root, createLsToolDefinition(root), false)),
      defineTool(confine(root, createEditToolDefinition(root), true)),
      defineTool(confine(root, createWriteToolDefinition(root), true)),
      defineTool(createBashToolDefinition(root, { operations: environmentBash(options.environment, options.approveCommand),
        exposeSessionEnvironment: false })),
    ];
    const settingsManager = SettingsManager.inMemory({ defaultTools: [], enableSkillCommands: false },
      { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: systemPrompt(root) });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: root, modelRuntime: options.modelRuntime, model: options.model,
      thinkingLevel: "medium", sessionManager: options.sessionManager ?? PiSessionManager.inMemory(root),
      settingsManager, resourceLoader, tools: tools.map((tool) => tool.name), customTools: tools });
    return new CodingSession(session, options.onActivity);
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
