import {
  type Api, type AssistantMessage, type JsonValue, type Message, type Model, type Models, type ModelThinkingLevel, type ToolCall, type ToolResultMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Base, captureBase } from "./base.ts";
import type { BranchEntry, EntryDraft, ExtensionFactory, RunOutcome, Session, SessionOutcome, ToolDefinition } from "../../../src/contract.ts";
import { contextUsage } from "./context-usage.ts";
import { conversationMessage } from "./conversation.ts";
import { createHost, type DrawingSurface, type PhaseResult } from "./extensions.ts";
import type { Behavior, Origin, SessionWriter, SettlePhase } from "./session-file.ts";
import { afterExtensions, afterVerifier, continuationLimit } from "./settle-rule.ts";
import type { EngineTool, ToolOutput } from "./tool.ts";
import { codingTools } from "./tools/index.ts";

export interface LoopOptions {
  /** The session's folder: tools resolve paths and run commands from here. */
  readonly cwd: string;
  readonly models: Models;
  readonly model: Model<Api>;
  readonly systemPrompt?: string;
  /** The tools the model may call; read, write, edit and the platform's shell when not given. */
  readonly tools?: (spool: () => string) => readonly EngineTool[];
  /** Where the session's entries go. */
  readonly writer: SessionWriter;
  /** What a resumed session already holds; a new session starts empty. */
  readonly resumed?: LoopState;
  /** The base of a request; the gate's units (`captureBase`) when not given. */
  readonly captureBase?: (cwd: string) => Promise<Base>;
  /** The session's extensions; they settle before the verifier and cannot replace it. */
  readonly extensions?: readonly ExtensionFactory[];
  /** What verifies each run before it may complete (#439); a run whose verifier has no settle handler never completes. */
  readonly verifier: ExtensionFactory;
  /** How the session is shown, as handlers read it in `ctx.mode`: `tui` when not given. */
  readonly mode?: string;
  /** The operator's flag values, by name. */
  readonly flags?: Readonly<Record<string, boolean | string>>;
  /** How hard a reasoning model thinks; `off` when not given, and for a model that does not reason. */
  readonly thinkingLevel?: ModelThinkingLevel;
  /** The session's entries as Pi's branch shapes them, for extensions that read it. */
  readonly branch: () => BranchEntry[];
  /** The shell the session's extensions draw on; none in print mode. */
  readonly surface?: DrawingSurface;
}

/** A message a settle handler added: the conversation keeps it as it came, and the model reads it as the operator's. */
export interface CustomMessage {
  readonly role: "custom";
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
  readonly timestamp: number;
}

export type HistoryMessage = Message | CustomMessage;

/**
 * What a session tells the shell as it happens (#444): a message entering the
 * conversation, the reply as it streams, a call starting, and the run's
 * state: working, settling (its extensions and verifier), or ended.
 */
export type SessionEvent =
  | { readonly type: "message"; readonly message: HistoryMessage }
  | { readonly type: "reply"; readonly partial: AssistantMessage }
  | { readonly type: "call"; readonly call: ToolCall }
  | { readonly type: "state"; readonly state: "working" | "settling" }
  | { readonly type: "ended"; readonly outcome: SessionOutcome };

/** The engine's session as the loop runs it: the contract's, its conversation, and its events. */
export interface LoopSession extends Session {
  /** The conversation in order, as the model and the shell see it. */
  history(): readonly HistoryMessage[];
  /** Tells `listener` what happens from now on; the returned function stops it. */
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

/** Where a session stands: its conversation, its last run and amendment, its usage and how its last run ended. */
export interface LoopState {
  readonly history: readonly HistoryMessage[];
  readonly runs: number;
  readonly amendments: number;
  readonly tokens: { readonly input: number; readonly output: number; readonly total: number };
  readonly outcome: SessionOutcome | undefined;
  /** The tools the model could call when the session was last written, when an extension changed them. */
  readonly activeTools?: readonly string[];
}

/**
 * The engine's system prompt in `cwd` with the active tools: what each
 * that has one says of itself, and their rules, trimmed and each once, in
 * Pi's form (#441).
 */
export function defaultPrompt(cwd: string, active: readonly EngineTool[]): string {
  const listed = active.flatMap(({ name, promptSnippet }) => promptSnippet === undefined || promptSnippet.trim() === "" ? []
    : [`- ${name}: ${promptSnippet.replace(/\s+/gu, " ").trim()}`]);
  const rules = [...new Set(active.flatMap(({ promptGuidelines }) => promptGuidelines ?? []).map((rule) => rule.trim())
    .filter((rule) => rule !== ""))].map((rule) => `- ${rule}`);
  return [`You are a coding agent working in ${cwd}. Use the tools to read, change and run what the request needs.`,
    ...listed.length > 0 ? [`Available tools:\n${listed.join("\n")}`] : [],
    ...rules.length > 0 ? [`Guidelines:\n${rules.join("\n")}`] : []].join("\n\n");
}

/** A call's result as the model sees it, with an extension tool's details. */
export const toolResult = (call: Pick<ToolCall, "id" | "name">, output: ToolOutput, timestamp: number = Date.now()): ToolResultMessage => ({
  role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output.text }],
  ...output.details === undefined ? {} : { details: output.details }, isError: output.isError, timestamp,
});

/** The conversation as the model reads it: a settle handler's message is context from the operator's side. */
const modelContext = (history: readonly HistoryMessage[]): Message[] => history.map((message) =>
  message.role === "custom" ? { role: "user", content: message.content, timestamp: message.timestamp } : message);

/**
 * Runs one tool call: an unknown or inactive tool, invalid arguments or an
 * exception become a failed call the model sees.
 */
async function execute(tools: readonly EngineTool[], call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) return { text: `Tool "${call.name}" not found.`, isError: true };
  try {
    return await tool.execute(validateToolArguments(tool, call) as never, signal, call.id);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/** An extension's tool as the engine runs it: its text parts joined, its details kept, and a returned `isError` a failure (#441). */
function extensionTool(tool: ToolDefinition, context: (signal: AbortSignal) => Parameters<ToolDefinition["execute"]>[4]): EngineTool {
  const { name, description, parameters, promptSnippet, promptGuidelines } = tool;
  return {
    name, description, parameters,
    ...promptSnippet === undefined ? {} : { promptSnippet }, ...promptGuidelines === undefined ? {} : { promptGuidelines },
    execute: async (args, signal, callId) => {
      const result = await tool.execute(callId, args, signal, undefined, context(signal));
      // Details are stored as JSON, as Pi stores them.
      return { text: result.content.map((part) => part.text).join(""), isError: result.isError === true,
        ...result.details === undefined ? {} : { details: result.details as JsonValue } };
    },
  };
}

const truncatedCall = (call: ToolCall): ToolOutput => ({
  text: `Tool call "${call.name}" was not run: the reply hit the output token limit, so its arguments may be cut off. `
    + "Call it again with complete arguments.", isError: true,
});

const stoppedCall: ToolOutput = { text: "Not run: the operator stopped the agent.", isError: true };

const stoppedReason = "the operator stopped the run";

/**
 * A session's tools and which the model may call, in the order they came
 * (#441), as Pi keeps them. An extension's tool is active unless it says
 * otherwise. Setting the active tools ignores unknown names and repeats and
 * takes effect from the next model request. Each request records the tools
 * it offers when they changed, so a resumed session restores what the model
 * last had; a restored tool registered only later becomes active then,
 * unless a change that dropped a tool came first.
 */
function toolbox(tools: EngineTool[], writer: SessionWriter) {
  let active = tools.map(({ name }) => name);
  /** Restored tools not registered yet; once restored, only these become active as they register. */
  let pending = new Set<string>();
  let restored = false;
  /** The tools the last request offered, as recorded. */
  let offered: string | undefined;
  const known = (name: string): boolean => tools.some((tool) => tool.name === name);
  const activeTools = (): EngineTool[] => active.flatMap((name) => tools.filter((tool) => tool.name === name));
  return {
    activeTools,
    active: (): string[] => [...active],
    register(tool: ToolDefinition, context: (signal: AbortSignal) => Parameters<ToolDefinition["execute"]>[4]): void {
      if (known(tool.name)) throw new Error(`A tool named "${tool.name}" is already registered.`);
      tools.push(extensionTool(tool, context));
      if (restored ? pending.delete(tool.name) : tool.defaultActive !== false) active.push(tool.name);
    },
    setActive(names: readonly string[]): void {
      const next = [...new Set(names)].filter(known);
      if (active.some((name) => !next.includes(name))) pending.clear();
      active = next;
    },
    restore(names: readonly string[] | undefined): void {
      if (names === undefined) return;
      restored = true;
      offered = names.join("\n");
      active = names.filter(known);
      pending = new Set(names.filter((name) => !known(name)));
    },
    /** The tools one model request offers, which its calls run with; recorded when they changed. */
    forRequest(): EngineTool[] {
      const offering = active.join("\n");
      if (offering !== offered) writer.append({ type: "active_tools", names: [...active] });
      offered = offering;
      return activeTools();
    },
  };
}

/** What the model is told of a tool. */
const declaration = ({ name, description, parameters }: EngineTool) => ({ name, description, parameters });

/** The thinking level the provider is asked for: the session's for a model that reasons, `off` otherwise. */
const thinkingOf = (model: Model<Api>, level: ModelThinkingLevel | undefined): ModelThinkingLevel =>
  model.reasoning ? level ?? "off" : "off";

/** An amendment waiting to enter the conversation. */
interface Queued {
  readonly id: number;
  readonly behavior: Behavior;
  readonly text: string;
}

/** How the model's turns of a run ended, and why when they failed. */
interface Ended {
  readonly outcome: RunOutcome;
  readonly reason?: string;
}

/** What settlement decided: another model turn, sent back by a handler (`automatic`) or for input that came meanwhile, or the run's end. */
type Settled = { readonly next: "continue"; readonly automatic: boolean } | { readonly next: "end"; readonly outcome: SessionOutcome };

/**
 * The engine's agent loop (#432), writing everything to its session (#437)
 * and settling each run with its extensions and then its verifier (#439).
 * A run ends `completed` only when its verifier settled it; `prompt`
 * resolves once it has ended, and rejects when a write fails, after which
 * nothing further runs.
 */
export function createLoop(options: LoopOptions): LoopSession {
  const { writer } = options;
  const history: HistoryMessage[] = [...options.resumed?.history ?? []];
  const listeners = new Set<(event: SessionEvent) => void>();
  /** Tells every listener; one that throws does not stop the run. */
  const emit = (event: SessionEvent): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* the shell's failure is the shell's, never the run's */ }
    }
  };
  const add = (message: HistoryMessage): void => {
    history.push(message);
    emit({ type: "message", message });
  };
  const tokens = { ...options.resumed?.tokens ?? { input: 0, output: 0, total: 0 } };
  let runs = options.resumed?.runs ?? 0;
  let amendments = options.resumed?.amendments ?? 0;
  let outcome = options.resumed?.outcome;
  let spoolFolder: string | undefined;
  const spool = (): string => (spoolFolder ??= mkdtempSync(join(tmpdir(), "tesota-core-output-")));
  const tools = toolbox([...options.tools?.(spool) ?? codingTools(options.cwd, spool)], writer);
  const thinkingLevel = thinkingOf(options.model, options.thinkingLevel);
  const base = options.captureBase ?? captureBase;
  const promptFor = (): string => options.systemPrompt ?? defaultPrompt(options.cwd, tools.activeTools());
  const host = createHost({
    cwd: options.cwd, mode: options.mode ?? "print", models: options.models, model: options.model, thinkingLevel,
    ...options.flags === undefined ? {} : { flags: options.flags },
    tools: { register: (tool) => { tools.register(tool, (signal) => host.context(signal)); }, active: tools.active,
      setActive: tools.setActive },
    branch: options.branch,
    contextUsage: () => contextUsage(history, promptFor(), tools.activeTools().map(declaration), options.model.contextWindow),
    ...options.surface === undefined ? {} : { surface: options.surface },
  }, options.extensions ?? [], options.verifier);
  tools.restore(options.resumed?.activeTools);
  const started = host.sessionStart({ type: "session_start", reason: options.resumed === undefined ? "startup" : "resume" });
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  /** Settles once the running request is in the ledger, so no amendment comes before it. */
  let recorded: Promise<void> = Promise.resolve();
  let queue: Queued[] = [];
  /** While a run settles, input handlers wait for it, in the order their input came; settlement waits for those already running. */
  let settling = false;
  let waiting: (() => Promise<void>)[] = [];
  const handling = new Set<Promise<void>>();
  /** Set once the running request's end is written: input after it belongs to no run. */
  let closed = false;
  /** Settles once the session is disposed; disposing again waits for the same. */
  let disposed: Promise<void> | undefined;

  /**
   * Streams one reply, records it and counts its usage once, partial usage
   * included when it failed. A provider that throws ends the turns as an
   * error, as one that returns its error does; a failed write still rejects.
   */
  async function reply(run: number, signal: AbortSignal, offered: readonly EngineTool[]): Promise<AssistantMessage | Ended> {
    let message: AssistantMessage;
    try {
      const stream = options.models.streamSimple(options.model,
        { systemPrompt: promptFor(), messages: modelContext(history), tools: offered.map(declaration) },
        { signal, ...thinkingLevel === "off" ? {} : { reasoning: thinkingLevel } });
      for await (const event of stream) if ("partial" in event) emit({ type: "reply", partial: event.partial });
      message = await stream.result();
    } catch (error) {
      return signal.aborted ? { outcome: "aborted", reason: stoppedReason }
        : { outcome: "error", reason: error instanceof Error ? error.message : String(error) };
    }
    writer.append({ type: "assistant", run, message });
    add(message);
    tokens.input += message.usage.input;
    tokens.output += message.usage.output;
    tokens.total += message.usage.totalTokens;
    return message;
  }

  /** Moves the queued amendments of the given behaviors into the conversation, in the order they came. */
  function deliver(run: number, behaviors: readonly Behavior[]): boolean {
    const due = queue.filter((amendment) => behaviors.includes(amendment.behavior));
    queue = queue.filter((amendment) => !behaviors.includes(amendment.behavior));
    for (const { id, text } of due) {
      writer.append({ type: "delivered", run, amendment: id });
      add({ role: "user", content: text, timestamp: Date.now() });
    }
    return due.length > 0;
  }

  /**
   * Runs the reply's calls in order. Each call's intent is synced before it
   * runs, with everything appended before it, so a call that may have
   * changed files is never missing from the session.
   */
  async function runCalls(run: number, message: AssistantMessage, calls: readonly ToolCall[], signal: AbortSignal,
    offered: readonly EngineTool[]): Promise<void> {
    for (const call of calls) {
      let output: ToolOutput;
      if (message.stopReason === "length") output = truncatedCall(call);
      else if (signal.aborted) output = stoppedCall;
      else {
        writer.append({ type: "call_intent", run, callId: call.id });
        writer.sync();
        emit({ type: "call", call });
        await host.toolStart({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }, signal);
        output = await execute(offered, call, signal);
        await host.toolResult({ type: "tool_result", toolCallId: call.id, toolName: call.name, input: call.arguments,
          isError: output.isError }, signal);
      }
      const result = toolResult(call, output);
      writer.append({ type: "tool_result", run, message: result });
      add(result);
    }
  }

  /**
   * The model's turns, until it answers without calling a tool and no input
   * waits, fails, or is stopped. After settlement sent the run back, the run
   * is at the boundary where follow-ups enter, so they enter with the steers.
   */
  async function turns(run: number, signal: AbortSignal, settled: boolean): Promise<Ended> {
    let boundary = settled;
    for (;;) {
      deliver(run, boundary ? ["steer", "followUp"] : ["steer"]);
      boundary = false;
      // A reply's calls run with the tools its request offered, whatever extensions change meanwhile.
      const offered = tools.forRequest();
      const message = await reply(run, signal, offered);
      if (!("role" in message)) return message;
      if (message.stopReason === "error") return { outcome: "error", reason: message.errorMessage ?? "the provider failed" };
      if (message.stopReason === "aborted" || signal.aborted) return { outcome: "aborted", reason: stoppedReason };
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      if (calls.length === 0) {
        if (deliver(run, ["steer", "followUp"])) continue;
        return { outcome: "completed" };
      }
      await runCalls(run, message, calls, signal, offered);
      if (signal.aborted) return { outcome: "aborted", reason: stoppedReason };
    }
  }

  /** Records what a settle phase added: messages into the conversation, data beside it. */
  function record(run: number, entries: readonly EntryDraft[]): void {
    for (const entry of entries) {
      if (entry.type === "custom") {
        writer.append({ type: "custom", run, customType: entry.customType, ...entry.data === undefined ? {} : { data: entry.data } });
        continue;
      }
      const { customType, content, display, details } = entry;
      writer.append({ type: "custom_message", run, customType, content, display, ...details === undefined ? {} : { details } });
      add({ role: "custom", customType, content, display, ...details === undefined ? {} : { details }, timestamp: Date.now() });
    }
  }

  /** A settlement phase's handlers, after its start is synced. */
  async function phase(run: number, generation: number, name: SettlePhase, told: RunOutcome, signal: AbortSignal,
    reason: string | undefined): Promise<PhaseResult> {
    writer.append({ type: "settle", run, generation, phase: name, outcome: told });
    writer.sync();
    return host.settle(name, told, signal, reason);
  }

  /**
   * What a phase returned, recorded and synced before anything acts on it;
   * synchronous, so no input is recorded between it and what settlement
   * decides from it.
   */
  function settled(run: number, generation: number, name: SettlePhase, result: PhaseResult): PhaseResult {
    const errors = [...host.takeErrors(), ...result.errors];
    record(run, result.entries);
    writer.append({ type: "settled", run, generation, phase: name, continued: result.continued, errors, registered: result.registered });
    writer.sync();
    return { ...result, errors };
  }

  /**
   * Settles the run's turns (#439): the extensions settle, then the
   * verifier, and the proved rule (`settle-rule.ts`) decides from what they
   * returned whether the run goes on or how it ends. The verifier finalizes
   * a run that will not complete, told why; only a verification it ran on a
   * completed run, with no failure and no input it did not see, completes it.
   * Input handlers already running finish first. The verifier's result, the
   * decision and the run's end are written in one synchronous step, so input
   * either came before them and sends the run back, or comes after the end.
   */
  async function settle(run: number, generation: number, ended: Ended, continuations: number, signal: AbortSignal): Promise<Settled> {
    await Promise.all(handling);
    const ordinary = settled(run, generation, "extensions", await phase(run, generation, "extensions", ended.outcome, signal, ended.reason));
    const first = afterExtensions(ended.outcome, signal.aborted, ordinary.errors.length > 0, ordinary.continued, continuations,
      continuationLimit);
    if (first === "continue") return { next: "continue", automatic: true };
    const verifying = first === "verify";
    const why = signal.aborted ? stoppedReason : ordinary.errors.length > 0 ? `a settle handler failed: ${ordinary.errors.join("; ")}`
      : ordinary.continued ? `settlement sent the run back ${continuationLimit} times` : ended.reason;
    const told: RunOutcome = signal.aborted ? "aborted" : verifying ? "completed" : ended.outcome === "completed" ? "error" : ended.outcome;
    const returned = await phase(run, generation, "verifier", told, signal, verifying ? undefined : why);
    const verdict = settled(run, generation, "verifier", returned);
    const errors = [...ordinary.errors, ...verdict.errors];
    const next = afterVerifier(ended.outcome, verifying, signal.aborted, errors.length > 0, verdict.registered, verdict.continued,
      queue.length > 0, continuations, continuationLimit);
    if (next === "continue") return { next: "continue", automatic: verdict.continued };
    const reason = next === "completed" ? undefined : next === "aborted" ? stoppedReason
      : errors.length > 0 ? `a settle handler failed: ${errors.join("; ")}`
        : !verdict.registered ? "the verifier has no settle handler"
          : verdict.continued ? `settlement sent the run back ${continuationLimit} times` : why;
    writer.append({ type: "run_end", run, outcome: next, ...reason === undefined ? {} : { reason } });
    writer.sync();
    closed = true;
    return { next: "end", outcome: next };
  }

  /**
   * Runs the input handlers that waited for settlement, in order. After the
   * run's end what they throw belongs to no run and is dropped; that end
   * did not complete, since their input would have sent the run back.
   */
  async function release(): Promise<void> {
    settling = false;
    for (const handlers of waiting.splice(0)) await handlers();
    if (closed) host.takeErrors();
  }

  /** A run: its request and base are synced into the ledger before the model hears of it, and its end before it reports. */
  async function start(run: number, text: string, origin: Origin, signal: AbortSignal): Promise<void> {
    const at = new Date().toISOString();
    const written = (async () => {
      writer.append({ type: "request", run, text, origin, at, base: await base(options.cwd) });
      writer.sync();
    })();
    recorded = written.catch(() => undefined);
    await written;
    await host.input({ type: "input", text, source: origin }, signal);
    add({ role: "user", content: text, timestamp: Date.parse(at) });
    let generation = 0;
    let continuations = 0;
    for (;;) {
      const ended = await turns(run, signal, generation > 0);
      settling = true;
      emit({ type: "state", state: "settling" });
      const decided = await settle(run, generation, ended, continuations, signal).finally(release);
      if (decided.next === "continue") {
        generation += 1;
        if (decided.automatic) continuations += 1;
        emit({ type: "state", state: "working" });
        continue;
      }
      outcome = decided.outcome;
      emit({ type: "ended", outcome: decided.outcome });
      return;
    }
  }

  /**
   * Input during a run: an amendment, synced into the ledger after its
   * request and queued; its input handlers run at once, or after the
   * settlement in progress, so no verification sees half of it.
   */
  async function amend(run: number, text: string, behavior: Behavior, origin: Origin, signal: AbortSignal | undefined): Promise<void> {
    await recorded;
    if (closed) throw new Error("The run ended before this input arrived; send it as a new prompt.");
    const id = ++amendments;
    writer.append({ type: "amendment", run, id, behavior, origin, text, at: new Date().toISOString() });
    writer.sync();
    queue.push({ id, behavior, text });
    const handlers = () => host.input({ type: "input", text, source: origin, streamingBehavior: behavior }, signal);
    if (settling) { waiting.push(handlers); return; }
    const running = handlers();
    handling.add(running);
    try { await running; } finally { handling.delete(running); }
  }

  return {
    async prompt(text, { streamingBehavior, source = "interactive" } = {}) {
      await started;
      if (running !== undefined) {
        if (streamingBehavior === undefined) throw new Error("A prompt is already running; steer it, queue a follow-up, abort it or wait.");
        await amend(runs, text, streamingBehavior, source, controller?.signal);
        return;
      }
      controller = new AbortController();
      queue = [];
      waiting = [];
      closed = false;
      emit({ type: "state", state: "working" });
      const current = start(++runs, text, source, controller.signal);
      running = current;
      try {
        await current;
      } catch (error) {
        outcome = "error";
        throw error;
      } finally {
        running = undefined;
      }
    },
    async abort() {
      controller?.abort();
      await running?.catch(() => undefined);
    },
    messages: () => history.map(conversationMessage),
    history: () => history,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    lastAssistantText: () => {
      const last = history.findLast((message): message is AssistantMessage => message.role === "assistant");
      return last?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    },
    stats: () => ({ tokens: { ...tokens } }),
    outcome: () => outcome,
    dispose: () => disposed ??= (async () => {
      controller?.abort();
      await running?.catch(() => undefined);
      writer.close();
      if (spoolFolder !== undefined) rmSync(spoolFolder, { recursive: true, force: true, maxRetries: 3 });
    })(),
  };
}
