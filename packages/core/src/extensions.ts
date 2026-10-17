import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type {
  BranchEntry, ContextUsage, EntryDraft, ExtensionAPI, ExtensionContext, ExtensionFactory, FlagOptions, Handler, InputEvent,
  RunOutcome, SessionStartEvent, SettleEvent, SettleResult, ShellAPI, ShellUI, ToolDefinition, ToolExecutionStartEvent, ToolResultEvent,
} from "../../../src/contract.ts";

/** Where extensions draw (#446): the shell's interface, its message renderers, and how a registered tool is drawn. */
export interface DrawingSurface {
  readonly ui: ShellUI;
  readonly registerMessageRenderer: ShellAPI["registerMessageRenderer"];
  readonly toolRegistered: (tool: object) => void;
}

export interface HostOptions {
  readonly cwd: string;
  readonly mode: string;
  readonly models: Models;
  readonly model: Model<Api>;
  /** The operator's flag values, by name; a flag without one has its registered default. */
  readonly flags?: Readonly<Record<string, boolean | string>>;
  /** The thinking level the provider is asked for. */
  readonly thinkingLevel: string;
  /** The tools: registering one, and which the model may call. */
  readonly tools: {
    register(tool: ToolDefinition): void;
    active(): string[];
    setActive(names: readonly string[]): void;
  };
  /** The session's entries as Pi's branch shapes them. */
  readonly branch: () => BranchEntry[];
  readonly contextUsage: () => ContextUsage | undefined;
  /** The shell extensions draw on; none draws nothing, as Pi's print mode. */
  readonly surface?: DrawingSurface;
}

/** What one settle phase returned: its handlers' entries in order, whether any sent the run back, and what each that threw said. */
export interface PhaseResult {
  readonly entries: readonly EntryDraft[];
  readonly continued: boolean;
  readonly errors: readonly string[];
  /** Whether the phase had a settle handler at all. */
  readonly registered: boolean;
}

/** The events of a session, sent to its extensions and then to its verifier. */
export interface ExtensionHost {
  sessionStart(event: SessionStartEvent): Promise<void>;
  input(event: InputEvent, signal: AbortSignal | undefined): Promise<void>;
  toolStart(event: ToolExecutionStartEvent, signal: AbortSignal): Promise<void>;
  toolResult(event: ToolResultEvent, signal: AbortSignal): Promise<void>;
  /**
   * Runs one phase's settle handlers in order. Their results accumulate: a
   * later handler sees what earlier ones added and cannot drop it or cancel
   * a send-back. A handler that throws is recorded and the next one runs.
   * Each gets `signal` and is awaited even after it aborts.
   */
  settle(phase: "extensions" | "verifier", outcome: RunOutcome, signal: AbortSignal, reason?: string): Promise<PhaseResult>;
  /** What the handlers of other events threw since the last call; settlement counts them as failures. */
  takeErrors(): string[];
  /** What a registered tool's call is given, as handlers are. */
  context(signal: AbortSignal | undefined): ExtensionContext;
}

type Handlers = { [Name in keyof Events]: Handler<Events[Name][0], Events[Name][1]>[] };
interface Events {
  session_start: [SessionStartEvent, void];
  input: [InputEvent, unknown];
  tool_execution_start: [ToolExecutionStartEvent, void];
  tool_result: [ToolResultEvent, void];
  agent_before_settle: [SettleEvent, SettleResult | undefined];
}
const noHandlers = (): Handlers =>
  ({ session_start: [], input: [], tool_execution_start: [], tool_result: [], agent_before_settle: [] });

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The interface with no shell, in print mode: setters do nothing and never call a component's factory; there is no theme. */
const headless: ShellUI = {
  setHeader: () => undefined,
  setFooter: () => undefined,
  setEditorComponent: () => undefined,
  setWorkingIndicator: () => undefined,
  setStatus: () => undefined,
  get theme(): never { throw new Error("There is no theme without the terminal shell."); },
};

/**
 * The engine's extension host (#439, #441): events, the handler context,
 * flags, tools and what the session reports. The verifier registers
 * through the same API but into handlers of its own, so no extension can
 * add to, replace or reorder them; every event reaches the extensions first.
 */
export function createHost(options: HostOptions, extensions: readonly ExtensionFactory[], verifier: ExtensionFactory): ExtensionHost {
  const flags = new Map<string, FlagOptions>();
  const ordinary = noHandlers();
  const verifying = noHandlers();
  const errors: string[] = [];
  const modelRegistry: ExtensionContext["modelRegistry"] = {
    find: (provider, id) => options.models.getModel(provider, id),
    complete: (model, context, completeOptions) => options.models.complete(model, context, completeOptions),
  };
  const context = (signal: AbortSignal | undefined): ExtensionContext => ({
    cwd: options.cwd, mode: options.mode, model: options.model, modelRegistry, signal, ui: options.surface?.ui ?? headless,
    sessionManager: { getBranch: options.branch },
    getContextUsage: options.contextUsage,
  });
  const api = (handlers: Handlers): ExtensionAPI => ({
    on: ((event: keyof Events, handler: never) => { handlers[event].push(handler); }) as ExtensionAPI["on"],
    registerFlag: (name, flag) => { flags.set(name, flag); },
    getFlag: (name) => options.flags?.[name] ?? flags.get(name)?.default,
    registerTool: (tool) => {
      options.tools.register(tool as unknown as ToolDefinition);
      options.surface?.toolRegistered(tool);
    },
    getActiveTools: () => options.tools.active(),
    setActiveTools: (names) => { options.tools.setActive(names); },
    getThinkingLevel: () => options.thinkingLevel,
    getSettings: () => ({}),
    // With no shell there is nothing to draw custom messages on.
    registerMessageRenderer: options.surface?.registerMessageRenderer ?? (() => undefined),
  });
  for (const factory of extensions) factory(api(ordinary));
  verifier(api(verifying));

  /** Sends an event to every handler, the extensions' first, recording what each throws. */
  async function emit<Name extends Exclude<keyof Events, "agent_before_settle">>(name: Name, event: Events[Name][0],
    signal: AbortSignal | undefined): Promise<void> {
    for (const handler of [...ordinary[name], ...verifying[name]] as Handler<Events[Name][0], unknown>[]) {
      try { await handler(event, context(signal)); } catch (error) { errors.push(`${name}: ${message(error)}`); }
    }
  }

  return {
    sessionStart: (event) => emit("session_start", event, undefined),
    input: (event, signal) => emit("input", event, signal),
    toolStart: (event, signal) => emit("tool_execution_start", event, signal),
    toolResult: (event, signal) => emit("tool_result", event, signal),
    async settle(phase, outcome, signal, reason) {
      const handlers = (phase === "extensions" ? ordinary : verifying).agent_before_settle;
      const entries: EntryDraft[] = [];
      let continued = false;
      const failed: string[] = [];
      for (const handler of handlers) {
        try {
          const result = await handler({ type: "agent_before_settle", entries: [...entries], continue: continued, outcome,
            ...reason === undefined ? {} : { reason } }, context(signal));
          entries.push(...result?.entries ?? []);
          continued ||= result?.continue === true;
        } catch (error) {
          failed.push(message(error));
        }
      }
      return { entries, continued, errors: failed, registered: handlers.length > 0 };
    },
    takeErrors: () => errors.splice(0),
    context,
  };
}
