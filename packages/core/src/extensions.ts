import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type {
  EntryDraft, ExtensionAPI, ExtensionContext, ExtensionFactory, FlagOptions, Handler, InputEvent, RunOutcome, SessionStartEvent,
  SettleEvent, SettleResult, ToolExecutionStartEvent, ToolResultEvent,
} from "./contract.ts";

export interface HostOptions {
  readonly cwd: string;
  readonly mode: string;
  readonly models: Models;
  readonly model: Model<Api>;
  /** The operator's flag values, by name; a flag without one has its registered default. */
  readonly flags?: Readonly<Record<string, boolean | string>>;
  /** The names of the tools the model may call. */
  readonly activeTools: () => string[];
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

/** Temporary until slice 5 of #432 brings the rest of the extension API; remove with it. */
const slice5 = (what: string) => (): never => { throw new Error(`${what} comes with the extension API in slice 5 of #432.`); };

/**
 * The engine's extension host (#439), with what the gate uses: events,
 * the handler context, flags and the active tools. The verifier registers
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
    cwd: options.cwd, mode: options.mode, model: options.model, modelRegistry, signal,
    sessionManager: { getBranch: slice5("The session branch") },
    getContextUsage: slice5("Context usage"),
  });
  const api = (handlers: Handlers): ExtensionAPI => ({
    on: ((event: keyof Events, handler: never) => { handlers[event].push(handler); }) as ExtensionAPI["on"],
    registerFlag: (name, flag) => { flags.set(name, flag); },
    getFlag: (name) => options.flags?.[name] ?? flags.get(name)?.default,
    getActiveTools: () => options.activeTools(),
    registerTool: slice5("Registering a tool"),
    setActiveTools: slice5("Setting the active tools"),
    getThinkingLevel: slice5("The thinking level"),
    getSettings: slice5("Settings"),
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
  };
}
