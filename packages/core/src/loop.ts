import {
  type Api, type AssistantMessage, type JsonValue, type Message, type Model, type Models, type ModelThinkingLevel, type ToolCall, type ToolResultMessage,
  isContextOverflow, validateToolArguments,
} from "@earendil-works/pi-ai";
import { observeProviderError, providerFailure, providerFetch, providerRetryType, type RetryEvidence } from "./provider-retry.ts";
import { retryProviderCall } from "./provider-retry-rule.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Base, captureBase } from "./base.ts";
import type { BranchEntry, EntryDraft, ExtensionFactory, PromptOptions, RunOutcome, Session, SessionOutcome, ToolDefinition } from "../../../src/contract.ts";
import { contextUsage, estimateTokens } from "../../../src/context-usage.js";
import { conversationMessage } from "./conversation.ts";
import { createHost, type DrawingSurface, type PhaseResult } from "./extensions.ts";
import type { Behavior, Origin, SessionWriter, SettlePhase } from "./session-file.ts";
import { afterExtensions, afterVerifier, continuationLimit } from "./settle-rule.ts";
import { cutPoint, shouldCompact } from "./compact-rule.ts";
import { type FilesTouched, filesTouched, summarize, summaryMessage } from "./compaction.ts";
import { type Hooks, runHooks } from "./hooks.ts";
import {
  contextFiles, instructionsText, type Skill, skillCatalog, skills, startable, type StartedSkill, startedSkill,
} from "./instructions.ts";
import { judge, type Mode, type Rules, type Verdict } from "./permissions.ts";
import { type Access, afterRefusal } from "./permission-rule.ts";

import type { EngineTool, ToolOutput } from "./tool.ts";
import { codingTools } from "./tools/index.ts";
import { type AskHost, isNativeAskTool } from "./tools/ask.ts";
import { askQuestions, blockingProseQuestion, type QuestionResponder } from "./questions.ts";
import { askAccepted, questionRepair } from "./questions-rule.ts";
import { clarificationText, type Clarification, type ClarificationAnswer, type ClarificationQuestion } from "../../../src/clarification.ts";

/** Who decided whether a call runs, as the session records it (#449, #622). */
type Decider = Verdict["by"] | "operator" | "session" | "hook" | "after_floor";

export interface LoopOptions {
  /** The session's folder: tools resolve paths and run commands from here. */
  readonly cwd: string;
  readonly models: Models;
  readonly model: Model<Api>;
  readonly systemPrompt?: string;
  /** The instructions and skills after the default prompt; the operator's and the project's (#457) when not given. */
  readonly instructions?: string;
  /** The tools the model may call; the file tools and platform's shell when not given. */
  readonly tools?: (spool: () => string, cwd: string, env?: Readonly<Record<string, string>>) => readonly EngineTool[];
  /** What every process the session starts adds to Tesota's environment (#619). */
  readonly env?: Readonly<Record<string, string>>;
  /** Where the session's entries go. */
  readonly writer: SessionWriter;
  /** The durable output folder beside the session's file, created on first use. */
  readonly outputFolder: string;
  /** The session's scratch folder (#653), where file tools may write besides `cwd`; none when not given. */
  readonly scratch?: string;
  /** The durable session file whose directory owns verification artifacts. */
  readonly sessionFile?: string;
  /** What a resumed session already holds; a new session starts empty. */
  readonly resumed?: LoopState;
  /** The base of a request; the gate's units (`captureBase`) when not given. */
  readonly captureBase?: (cwd: string, signal: AbortSignal) => Promise<Base>;
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
  /**
   * Who may allow what (#449): the mode, the rules, and how to ask the
   * operator; with no one to ask, a call that would ask is refused. Full
   * access with no rules when not given; the floor holds either way.
   */
  readonly permissions?: Permissions;
  /**
   * When to compact (#451): before a request, once the conversation passes the
   * context window less `reserve` tokens, keeping at least the last `keep`
   * verbatim. Pi's 16,384 and 20,000 when not given.
   */
  readonly compaction?: { readonly reserve: number; readonly keep: number };
  /**
   * The command hooks each call passes (#457), read when it is made, so
   * hooks trusted while the session runs apply from then on; none when not
   * given. They run after the permission check, so they can only refuse more.
   */
  readonly hooks?: () => Hooks;
  /** The session's id, which a hook is told. */
  readonly sessionId?: string;
  /** The MCP servers' tools (#459), read before each request; none when not given or while it gives none. */
  readonly mcp?: () => McpTools | undefined;
  /** The terminal's explicit operator-question bridge; absent in print and headless runs. */
  readonly questions?: QuestionResponder;
  /** Tools whose calls start jobs of the run (#525), such as `agent`; none when not given. */
  readonly jobTools?: (jobs: Jobs) => readonly EngineTool[];
}

/**
 * What a job is recorded with before it runs (#525): the call that starts
 * it, what it is, whether it runs in the background, the session an agent
 * job runs as, and what the shell shows of it.
 */
export interface JobStart {
  readonly callId: string;
  readonly kind: "agent";
  readonly description: string;
  readonly background: boolean;
  readonly session: string;
  readonly details: JsonValue;
}

/** How a job ended: its outcome, what the model reads, and its report for the shell and the receipt. */
export interface JobEnd {
  readonly outcome: string;
  readonly text: string;
  readonly details: JsonValue;
}

/**
 * The jobs of a session's runs (#525, built once for #524's background
 * commands): work a call starts that goes on beside the run. A job is
 * recorded, and synced, before it runs; it stops when its run stops or the
 * session closes. A background job's end reaches the run as input, in the
 * order the jobs ended; the call waits for one that is not in the background.
 * A run never settles while one runs.
 */
export interface Jobs {
  /**
   * Starts a job of the running run, which `begin` prepares under its id:
   * what it is recorded with, its work, and how to let go of what it
   * prepared if it cannot be recorded. Resolves at once with its id in the
   * background, else with its end.
   */
  start(begin: (job: string) => PreparedJob): Promise<{ readonly job: string; readonly end?: JobEnd }>;
}

/** A job ready to run: what it is recorded with, and its work, which stops on `signal`. */
export interface PreparedJob {
  readonly start: JobStart;
  readonly work: (signal: AbortSignal) => Promise<JobEnd>;
  readonly discard: () => Promise<void>;
}

/** The tools of the MCP servers a session reaches (#459). */
export interface McpTools {
  /** Their tools as the servers offer them now; a long result's whole text goes under `spool()`. */
  tools(spool: () => string): readonly EngineTool[];
  /** Resolves once the servers that started with them connected or failed, or a while after they started, or on `signal`. */
  ready(signal: AbortSignal): Promise<void>;
}

/** How a session decides what its calls may do (#449). */
export interface Permissions {
  mode(): Mode;
  readonly rules: Rules;
  /** Asks the operator about `call`, saying why; absent when no one is present to answer. */
  ask?(call: ToolCall, reason: string): Promise<"once" | "session" | "deny">;
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
  /** The loop's pending input changed; read it with `pendingMessages`. */
  | { readonly type: "pending" }
  | { readonly type: "reply"; readonly partial: AssistantMessage }
  | { readonly type: "call"; readonly call: ToolCall }
  | { readonly type: "state"; readonly state: "working" | "settling" }
  /** The conversation is being compacted (#451), and then was, from about `tokensBefore` tokens to `tokensAfter`. */
  /** A line for the operator from outside the conversation: a hook's message or failure (#457). */
  | { readonly type: "note"; readonly text: string }
  /** A model-call retry's cancellable wait; zero clears the countdown. */
  | { readonly type: "retry"; readonly attempt: number; readonly delayMs: number }
  | { readonly type: "compacting" }
  | { readonly type: "compacted"; readonly tokensBefore: number; readonly tokensAfter: number }
  /** A job the run started (#525), from its call: running, then ended, with what the shell shows of it. */
  | { readonly type: "job"; readonly job: string; readonly callId: string; readonly state: "running" | "ended"; readonly details: JsonValue }
  | { readonly type: "ended"; readonly outcome: SessionOutcome; readonly reason?: string };

/** The `custom` entry that links a run to the one it continues (#651), recorded with its request. */
export const continuesType = "tesota.continues";

/**
 * The earlier run a request continues (#651), one that ended on an
 * unresolved question: the new run is measured from that run's base, and
 * the operator's answer is its clarification, never permission.
 */
export interface Continuation {
  readonly run: number;
  readonly base: Base;
  readonly clarification: Clarification;
}

/** The engine's session as the loop runs it: the contract's, its conversation, and its events. */
export interface LoopSession extends Session {
  /** The contract's prompt; `continues` starts a run that continues an earlier one (#651) instead of taking a new base. */
  prompt(text: string, options?: PromptOptions & { readonly continues?: Continuation }): Promise<void>;
  /** The conversation in order, as the model and the shell see it. */
  history(): readonly HistoryMessage[];
  /** Input not yet taken by the model, in arrival order. */
  pendingMessages(): readonly PendingMessage[];
  /** Atomically withdraws input the loop has not taken; delivered input is never returned. */
  withdrawPendingMessages(): readonly PendingMessage[];
  /** Tells `listener` what happens from now on; the returned function stops it. */
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /** Compacts the conversation between runs (#451); rejects, saying why, while a run goes or when it cannot. */
  compact(): Promise<void>;
  /** The skills the operator may start by name, `/name` at the start of a request (#540), read as the session started. */
  skills(): readonly Skill[];
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
  /** The last run's request, its delivered amendments and its submitted answers, as the messages that brought them. */
  readonly ledger?: readonly HistoryMessage[];
  /** The last compaction (#451): its summary, the files summarized so far, and where replies count toward usage again. */
  readonly compacted?: { readonly summary: string; readonly files: FilesTouched; readonly counted: number };
}

const skillType = "tesota.skill";

/** A background job's end as it enters the conversation (#525): the model reads it as the operator's, and the shell shows it. */
export const jobType = "tesota.job";

/** A background job's end as a message, in the conversation as the run took it in. */
export const jobMessage = (text: string, details: unknown, timestamp: number): CustomMessage =>
  ({ role: "custom", customType: jobType, content: text, display: true, ...details === undefined ? {} : { details }, timestamp });

/**
 * The instructions of a skill the operator started by name (#540): the model
 * reads them after the request, as the operator's; the shell does not show
 * them, and neither the ledger's request nor verification reads them.
 */
export const skillMessage = (skill: StartedSkill, timestamp: number): CustomMessage =>
  ({ role: "custom", customType: skillType, content: skill.instructions, display: false, timestamp });

/**
 * What a compacted conversation starts with (#451): the run's request, the
 * skill it started (#540), its amendments and the operator's answers exactly
 * as given, which no summary replaces, then the summary. It is context the
 * model reads as the operator's; the shell does not show it.
 */
export function compactedHead(ledger: readonly HistoryMessage[], summary: string, files: FilesTouched,
  tail: readonly HistoryMessage[]): CustomMessage {
  // What the tail still holds is not repeated. An answer enters the conversation in its call's result, which can
  // come after an amendment given before it, so the ledger is not in the conversation's order: each is looked for.
  const given = ledger.flatMap((message, index) => tail.includes(message) ? [] : [(index === 0
    ? ["The operator's request, exactly as given:"] : message.role === "toolResult" ? ["The operator answered your question:"]
      : message.role === "custom" && message.customType === skillType ? ["The skill the operator started:"]
        : ["Added while you worked:"]).concat(conversationMessage(message).text ?? "")]);
  const content = [...given.flat(), summaryMessage(summary, files)].join("\n\n");
  return { role: "custom", customType: "tesota.compaction", content, display: false, timestamp: Date.now() };
}

/**
 * The engine's system prompt in `cwd` with the active tools: what each
 * that has one says of itself, and their rules, trimmed and each once, in
 * Pi's form (#441); and the session's `scratch` folder, when it has one (#653).
 */
export function defaultPrompt(cwd: string, active: readonly EngineTool[], scratch?: string): string {
  const listed = active.flatMap(({ name, promptSnippet }) => promptSnippet === undefined || promptSnippet.trim() === "" ? []
    : [`- ${name}: ${promptSnippet.replace(/\s+/gu, " ").trim()}`]);
  const rules = [...new Set(active.flatMap(({ promptGuidelines }) => promptGuidelines ?? []).map((rule) => rule.trim())
    .filter((rule) => rule !== ""))].map((rule) => `- ${rule}`);
  const explorers = active.filter(({ name }) => name === "ls" || name === "find" || name === "grep").map(({ name }) => name);
  return [`You are a coding agent working in ${cwd}. Use the tools to read, change and run what the request needs.`,
    ...scratch === undefined ? [] : [`Write temporary files, such as a commit message, a probe script or a fixture, in ${scratch}: `
      + "the session's own scratch folder, removed when the session ends and never part of the change. "
      + `File tools may write only there and in ${cwd}; other writes are refused.`],
    ...explorers.length > 0 ? [`Use ${explorers.join(", ")} to explore.`
      + (active.some(({ name }) => name === "bash" || name === "powershell") ? " Use the shell to run commands." : "")] : [],
    ...listed.length > 0 ? [`Available tools:\n${listed.join("\n")}`] : [],
    ...rules.length > 0 ? [`Guidelines:\n${rules.join("\n")}`] : []].join("\n\n");
}

/** The instructions given, or the operator's and the project's and the catalog of `available` skills (#457). */
const instructionsOf = (options: LoopOptions, available: readonly Skill[]): string => options.instructions
  ?? instructionsText(contextFiles(options.cwd), skillCatalog(available, options.model.contextWindow));

/** A call's result as the model sees it, with an extension tool's details. */
export const toolResult = (call: Pick<ToolCall, "id" | "name">, output: ToolOutput, timestamp: number = Date.now()): ToolResultMessage => ({
  role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output.text }],
  ...output.details === undefined ? {} : { details: output.details }, isError: output.isError, timestamp,
});

/** The conversation as the model reads it: a settle handler's message is context from the operator's side. */
export const modelContext = (history: readonly HistoryMessage[]): Message[] => history.map((message) =>
  message.role === "custom" ? { role: "user", content: message.content, timestamp: message.timestamp } : message);

/**
 * Runs one tool call: an unknown or inactive tool, invalid arguments or an
 * exception become a failed call the model sees.
 */
/** The operator's answer as a decision and its reason; none when the run was stopped before they answered. */
function operatorDecision(answer: "once" | "session" | "deny" | undefined): { decision: "allow" | "deny"; reason: string } {
  if (answer === undefined) return { decision: "deny", reason: "The run was stopped before the operator answered." };
  if (answer === "deny") return { decision: "deny", reason: "The operator refused it." };
  return { decision: "allow", reason: answer === "session" ? "The operator allowed it for this session." : "The operator allowed it once." };
}

/** What `promise` gives, or nothing once `signal` stops first, which interrupts the wait. */
async function untilStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  const exit = await Effect.runPromiseExit(Effect.promise(() => promise), { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) return undefined;
  throw Cause.squash(exit.cause);
}

/** How long work the operator's stop interrupted gets to finish and report on its own before the run goes on without it. */
const stopGraceMs = 2_000;

/**
 * Waits for `work` as a step the operator's stop interrupts, as Codex stops
 * a turn. `record` is told once what the work gave, before anything can
 * interrupt the step again: its result; or, once a stop interrupted the
 * wait, what it gave within `stopGraceMs` of being told by the run's signal,
 * or nothing, with how long it ran. The run then goes on without it, and
 * `left` tells the work so, so it reports nothing more. A promise cannot be
 * ended, so work that ignores the signal settles unobserved; a process it
 * started is stopped by its own runner (`process.ts`).
 */
function step<A>(work: (left: AbortSignal) => Promise<A>, record: (given: Option.Option<A>, ms: number) => void): Effect.Effect<A> {
  return Effect.uninterruptibleMask((restore) => Effect.suspend(() => {
    const begun = Date.now();
    const leaving = new AbortController();
    const running = work(leaving.signal);
    const awaited = Effect.callback<A>((resume) => {
      running.then((value) => { resume(Effect.succeed(value)); }, (error: unknown) => { resume(Effect.die(error)); });
    });
    const recorded = (given: Option.Option<A>) => Effect.sync(() => {
      if (Option.isNone(given)) leaving.abort();
      record(given, Date.now() - begun);
    });
    return restore(awaited).pipe(
      Effect.onInterrupt(() => Effect.timeoutOption(awaited, stopGraceMs).pipe(Effect.flatMap(recorded))),
      Effect.tap((value) => recorded(Option.some(value))));
  }));
}

/** How the model's turns that `exit` gave ended: aborted when the stop interrupted them; a failure is rethrown. */
function endedBy(exit: Exit.Exit<Ended>): Ended {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "aborted", reason: stoppedReason };
  throw Cause.squash(exit.cause);
}

async function execute(tools: readonly EngineTool[], call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) return { text: `Tool "${call.name}" not found.`, isError: true };
  let args: unknown;
  try {
    args = validateToolArguments(tool, call);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
  if (isNativeAskTool(tool)) return await tool.execute(args as never, signal, call.id);
  try { return await tool.execute(args as never, signal, call.id); } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/** An extension's tool as the engine runs it: its text parts joined, its details kept, and a returned `isError` a failure (#441). */
function extensionTool(tool: ToolDefinition, context: (signal: AbortSignal) => Parameters<ToolDefinition["execute"]>[4]): EngineTool {
  const { name, description, parameters, promptSnippet, promptGuidelines, access } = tool;
  return {
    name, description, parameters, ...access === undefined ? {} : { access },
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

/** A call the stop interrupted that did not report in time, `ms` after it began. */
const stoppedAfter = (ms: number): ToolOutput => ({ text: `Stopped: the operator stopped the agent ${(ms / 1000).toFixed(1)} s into this call, `
  + "before it reported; what it changed is not known.", isError: true });

const stoppedReason = "the operator stopped the run";
const disposedReason = "The session is closed; start or resume one to go on.";

/** Compaction as a loop starts (#451): its margins, Pi's when not given, and what a resumed session last held. */
function compactionAtStart(options: LoopOptions): {
  readonly margins: { readonly reserve: number; readonly keep: number };
  readonly ledger: HistoryMessage[];
  readonly compacted: LoopState["compacted"];
} {
  return { margins: options.compaction ?? { reserve: 16_384, keep: 20_000 }, ledger: [...options.resumed?.ledger ?? []],
    compacted: options.resumed?.compacted };
}

/** Why a compaction did not happen when the recent messages alone already reach the tail it keeps. */
const nothingToSummarize = "the recent messages alone fill the part kept verbatim";

/**
 * A session's tools and which the model may call, in the order they came
 * (#441), as Pi keeps them. An extension's tool is active unless it says
 * otherwise. Setting the active tools ignores unknown names and repeats and
 * takes effect from the next model request. Each request records the tools
 * it offers when they changed, so a resumed session restores what the model
 * last had; a restored tool registered only later becomes active then,
 * unless a change that dropped a tool came first.
 */
function toolbox(given: EngineTool[], writer: SessionWriter) {
  let tools = given;
  let active = tools.map(({ name }) => name);
  /** Restored tools not registered yet; once restored, only these become active as they register. */
  let pending = new Set<string>();
  let restored = false;
  /** The tools the last request offered, as recorded. */
  let offered: string | undefined;
  /** The names of the MCP servers' tools in `tools` (#459). */
  let external = new Set<string>();
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
    /**
     * Keeps the MCP servers' tools as they offer them now (#459): a new one
     * joins the active tools, one withdrawn goes, and none takes the
     * name of a tool the session already has.
     */
    offer(current: readonly EngineTool[]): void {
      const names = new Set(current.map(({ name }) => name));
      tools = tools.filter(({ name }) => !external.has(name) || names.has(name));
      active = active.filter((name) => !external.has(name) || names.has(name));
      for (const tool of current) {
        const at = tools.findIndex(({ name }) => name === tool.name);
        if (at >= 0) {
          if (external.has(tool.name)) tools[at] = tool; else names.delete(tool.name);
          continue;
        }
        // A server's tool is offered whenever the server is: one configured after the session last ran joins it too.
        tools.push(tool);
        pending.delete(tool.name);
        active.push(tool.name);
      }
      external = names;
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

/** A session's own tools: those given, or the file tools, the platform's shell and `ask_user`; then those that start jobs (#525). */
const sessionTools = (options: LoopOptions, spool: () => string, questions: AskHost, jobs: Jobs): EngineTool[] =>
  [...options.tools?.(spool, options.cwd, options.env) ?? codingTools(options.cwd, spool, undefined, questions, options.env),
    ...options.jobTools?.(jobs) ?? []];

/** What the model is told of a tool. */
const declaration = ({ name, description, parameters }: EngineTool) => ({ name, description, parameters });

/** The thinking level the provider is asked for: the session's for a model that reasons, `off` otherwise. */
const thinkingOf = (model: Model<Api>, level: ModelThinkingLevel | undefined): ModelThinkingLevel =>
  model.reasoning ? level ?? "off" : "off";

/** An amendment waiting to enter the conversation. */
export interface PendingMessage {
  readonly id: number;
  readonly behavior: Behavior;
  readonly text: string;
}

interface Queued extends PendingMessage {
  readonly order: number;
  /** The skill it starts by name (#540), whose instructions enter the conversation after it. */
  readonly skill?: StartedSkill;
}

/** How the model's turns of a run ended, and why when they failed. */
interface Ended {
  readonly outcome: RunOutcome;
  readonly reason?: string;
  readonly incomplete?: boolean;
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
  /** Set when an answer could not be saved or its form released: the operator may think it was given, so nothing runs after. */
  let questionFailure: Error | undefined;
  const spool = (): string => { mkdirSync(options.outputFolder, { recursive: true }); return options.outputFolder; };
  let activeQuestion: { readonly run: number; readonly reply: number; readonly callId: string } | undefined;
  /** Request-scoped attempts and the one shared repair, independent of conversation compaction. */
  let asked = { run: 0, times: 0, repaired: false, repairing: false,
    decision: undefined as string | undefined, unresolved: undefined as string | undefined };
  const questionState = (run: number): typeof asked => {
    if (asked.run !== run) asked = { run, times: 0, repaired: false, repairing: false, decision: undefined, unresolved: undefined };
    return asked;
  };
  const questionHost = {
    ask: async (questions: readonly ClarificationQuestion[], signal: AbortSignal, callId: string) => {
      const active = activeQuestion;
      if (active === undefined || active.callId !== callId) throw new Error("The question call is no longer active.");
      try {
        return await askQuestions(questions, options.questions, signal, (answers: readonly ClarificationAnswer[]) => {
          if (signal.aborted) throw new Error("The run was stopped before this answer could be saved.");
          const clarification: Clarification = { reply: active.reply, callId, at: new Date().toISOString(), questions, answers };
          writer.append({ type: "clarification", run: active.run, clarification });
          writer.sync();
          answered.set(callId, { order: nextInputOrder++, text: clarificationText(clarification) });
        });
      } catch (error) {
        questionFailure = error instanceof Error ? error : new Error(String(error));
        throw questionFailure;
      }
    },
  };
  /** The jobs running now (#525), each stopped by its own controller, and the background ones that ended, waiting to enter the conversation. */
  const jobs = new Map<string, { readonly controller: AbortController; readonly done: Promise<void> }>();
  const finishedJobs: { readonly job: string; readonly end: JobEnd }[] = [];
  /** How many times something a run waiting on its jobs wakes for happened: a job's end or new input. */
  let changes = 0;
  const wakers = new Set<() => void>();
  const changed = (): void => {
    changes += 1;
    const waking = [...wakers];
    wakers.clear();
    for (const wake of waking) wake();
  };
  /** Waits until something happened after `seen`; the operator's stop interrupts the wait. */
  const change = (seen: number): Effect.Effect<void> => Effect.callback<void>((resume) => {
    if (changes !== seen) { resume(Effect.void); return; }
    const wake = (): void => { resume(Effect.void); };
    wakers.add(wake);
    return Effect.sync(() => { wakers.delete(wake); });
  });
  const jobHost: Jobs = {
    start: async (begin) => {
      const signal = controller?.signal;
      if (signal === undefined || running === undefined || closed) throw new Error("A job starts only during a run.");
      const run = runs;
      const job = randomUUID().slice(0, 8);
      const { start, work, discard } = begin(job);
      try {
        writer.append({ type: "job_start", run, job, callId: start.callId, kind: start.kind, description: start.description,
          background: start.background, session: start.session, details: start.details });
        writer.sync();
      } catch (error) {
        await discard();
        throw error;
      }
      const stopper = new AbortController();
      const stop = (): void => { stopper.abort(); };
      if (signal.aborted) stopper.abort(); else signal.addEventListener("abort", stop, { once: true });
      emit({ type: "job", job, callId: start.callId, state: "running", details: start.details });
      const finished = work(stopper.signal).catch((error: unknown): JobEnd => ({ outcome: "error", details: start.details,
        text: `The job failed: ${error instanceof Error ? error.message : String(error)}` })).then((end) => {
        signal.removeEventListener("abort", stop);
        jobs.delete(job);
        // A background job's end waits for the run to take it in; the call that waited for one carries it in its result.
        if (start.background) finishedJobs.push({ job, end });
        else {
          writer.append({ type: "job_end", run, job, outcome: end.outcome, text: end.text, details: end.details });
          writer.sync();
        }
        emit({ type: "job", job, callId: start.callId, state: "ended", details: end.details });
        changed();
        return end;
      });
      jobs.set(job, { controller: stopper, done: finished.then(() => undefined, () => undefined) });
      return start.background ? { job } : { job, end: await finished };
    },
  };
  /** Stops the jobs still running, as their run ends, and waits for each to end. */
  const stopJobs = async (): Promise<void> => {
    const stopping = [...jobs.values()];
    for (const { controller: stopper } of stopping) stopper.abort();
    await Promise.all(stopping.map(({ done }) => done));
  };
  const tools = toolbox(sessionTools(options, spool, questionHost, jobHost), writer);
  const thinkingLevel = thinkingOf(options.model, options.thinkingLevel);
  const base = options.captureBase ?? captureBase;
  /** The operator's and the project's skills, read once as the session starts, from its own folder (#457). */
  const available = skills(options.cwd);
  const instructions = options.systemPrompt === undefined ? instructionsOf(options, available) : "";
  const promptFor = (): string => options.systemPrompt
    ?? [defaultPrompt(options.cwd, tools.activeTools(), options.scratch), instructions].filter((part) => part !== "").join("\n\n");
  const resumedCompaction = compactionAtStart(options);
  const margins = resumedCompaction.margins;
  /** The current run's request and delivered amendments, which a compaction keeps as given. */
  let ledger = resumedCompaction.ledger;
  /** Where each of the ledger's messages came among the request's input: an amendment is delivered, and an answer reaches
   * the conversation in its call's result, after input that came later may have. */
  const inputOrder = new Map(ledger.map((message, index) => [message, index]));
  let nextInputOrder = ledger.length;
  /** Each submitted answer's place in the input and its words, by its call, until that call's result carries it into the conversation. */
  const answered = new Map<string, { readonly order: number; readonly text: string }>();
  const toLedger = (message: HistoryMessage, order: number): void => {
    ledger.push(message);
    inputOrder.set(message, order);
    ledger.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
  };
  let compacted = resumedCompaction.compacted;
  /** Set when a compaction left the conversation past the margin: until another brings it under, only an overflow compacts. */
  let stuck = false;
  /** A compaction `/compact` started between runs, which a prompt waits for and stopping stops. */
  let compacting: { readonly done: Promise<void>; readonly controller: AbortController } | undefined;
  const usage = () => contextUsage(history, promptFor(), tools.activeTools().map(declaration), options.model.contextWindow,
    compacted?.counted ?? 0);
  const host = createHost({
    cwd: options.cwd, mode: options.mode ?? "print", models: options.models, model: options.model, thinkingLevel,
    ...options.env === undefined ? {} : { env: options.env },
    ...options.flags === undefined ? {} : { flags: options.flags },
    tools: { register: (tool) => { tools.register(tool, (signal) => host.context(signal)); }, active: tools.active,
      setActive: tools.setActive },
    branch: options.branch,
    ...options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile },
    contextUsage: usage,
    ...options.surface === undefined ? {} : { surface: options.surface },
  }, options.extensions ?? [], options.verifier);
  tools.restore(options.resumed?.activeTools);
  /** Stops when the session is disposed: what started with the session, its startup handlers, is told. */
  const lifetime = new AbortController();
  const started = host.sessionStart({ type: "session_start", reason: options.resumed === undefined ? "startup" : "resume" },
    lifetime.signal);
  /** Prompts waiting for startup or manual compaction, which a stop refuses before they become runs. */
  const admitting = new Set<AbortController>();
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  const replyIndexes = new Map<number, number>();
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
   * Streams one reply, shown as it comes until the run goes on without it
   * (`left`); a provider that throws ends the turns as an error, as one that
   * returns its error does.
   */
  async function streamedOnce(signal: AbortSignal, left: AbortSignal, offered: readonly EngineTool[], evidence: RetryEvidence): Promise<AssistantMessage | Ended> {
    try {
      const stream = options.models.streamSimple(options.model,
        { systemPrompt: promptFor(), messages: modelContext(history), tools: offered.map(declaration) },
        // Claude Code reads metadata.cwd for its query and transient transcript; never the shell's folder.
        // The session's id is the provider's prompt-cache key and session affinity, as Pi passed it (`prompt_cache_key` for OpenAI).
        { signal, maxRetries: 0,
          // Google's SDK adapters explicitly reject a custom fetch; other adapters can expose failed HTTP headers here.
          ...options.model.api === "google-generative-ai" || options.model.api === "google-vertex" ? {} : { fetch: providerFetch(evidence) },
          onResponse: (response) => { observeProviderError(evidence, response); }, metadata: { cwd: options.cwd }, ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
          ...thinkingLevel === "off" ? {} : { reasoning: thinkingLevel } });
      for await (const event of stream) if ("partial" in event && !left.aborted) emit({ type: "reply", partial: event.partial });
      return await stream.result();
    } catch (error) {
      observeProviderError(evidence, error);
      if (signal.aborted) return { outcome: "aborted", reason: stoppedReason };
      return { role: "assistant", content: [], api: options.model.api, model: options.model.id, provider: options.model.provider,
        stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    }
  }

  async function streamed(run: number, signal: AbortSignal, left: AbortSignal, offered: readonly EngineTool[]): Promise<AssistantMessage | Ended> {
    let started: number | undefined;
    let retries = 0;
    for (;;) {
      const evidence: RetryEvidence = { status: 0, delayMs: 0, types: [] };
      const message = await streamedOnce(signal, left, offered, evidence);
      if (!("role" in message) || message.stopReason !== "error" || signal.aborted || left.aborted
        || isContextOverflow(message, options.model.contextWindow)) return message;
      started ??= performance.now();
      const failure = providerFailure(message, evidence);
      const delay = Math.max(1000 * 2 ** retries, evidence.delayMs);
      if (!retryProviderCall(failure.terminal, failure.transient, failure.status, retries,
        Math.ceil(performance.now() - started), delay)) return message;
      retries++;
      writer.append({ type: "custom", run, customType: providerRetryType, data: { attempt: retries, delayMs: delay, message } });
      countUsage(message);
      writer.sync();
      // Close the failed stream in the shell, but never feed it back to the model or execute its partial calls.
      emit({ type: "message", message });
      emit({ type: "note", text: `Retry ${retries}/3 in ${Math.ceil(delay / 1000)}s…` });
      emit({ type: "retry", attempt: retries, delayMs: delay });
      try { await Effect.runPromise(Effect.sleep(delay), { signal }); }
      catch (error) {
        if (!signal.aborted) throw error;
        return { outcome: "aborted", reason: stoppedReason };
      } finally { emit({ type: "retry", attempt: retries, delayMs: 0 }); }
      if (signal.aborted || left.aborted) return { outcome: "aborted", reason: stoppedReason };
      if (performance.now() - started >= 120_000) return { outcome: "error", reason: message.errorMessage ?? "the provider failed" };
    }
  }

  /** Records a reply and counts its usage once, partial usage included when it failed; a failed write rejects. */
  function replied(run: number, message: AssistantMessage): void {
    writer.append({ type: "assistant", run, message });
    replyIndexes.set(run, (replyIndexes.get(run) ?? 0) + 1);
    add(message);
    countUsage(message);
  }

  function countUsage(message: AssistantMessage): void {
    tokens.input += message.usage.input;
    tokens.output += message.usage.output;
    tokens.total += message.usage.totalTokens;
  }

  /** One reply, recorded; a stop interrupts it, and what the provider gives in time is still recorded (`step`). */
  const reply = (run: number, signal: AbortSignal, offered: readonly EngineTool[]): Effect.Effect<AssistantMessage | Ended> =>
    step((left) => streamed(run, signal, left, offered), (given) => { if (Option.isSome(given) && "role" in given.value) replied(run, given.value); });

  /** Moves the queued amendments of the given behaviors into the conversation, in the order they came. */
  function deliver(run: number, behaviors: readonly Behavior[]): boolean {
    const due = queue.filter((amendment) => behaviors.includes(amendment.behavior));
    queue = queue.filter((amendment) => !behaviors.includes(amendment.behavior));
    if (due.length > 0) emit({ type: "pending" });
    for (const { id, text, order, skill } of due) {
      writer.append({ type: "delivered", run, amendment: id });
      const delivered: HistoryMessage = { role: "user", content: text, timestamp: Date.now() };
      toLedger(delivered, order);
      add(delivered);
      if (skill === undefined) continue;
      const instructed = skillMessage(skill, delivered.timestamp);
      toLedger(instructed, order);
      add(instructed);
    }
    // The background jobs that ended come after, in the order they ended (#525); they are no request input, so not in the ledger.
    const reported = finishedJobs.splice(0);
    for (const { job, end } of reported) {
      writer.append({ type: "job_end", run, job, outcome: end.outcome, text: end.text, details: end.details });
      add(jobMessage(end.text, end.details, Date.now()));
    }
    if (reported.length > 0) writer.sync();
    return due.length > 0 || reported.length > 0;
  }

  /** Calls the operator allowed for the rest of the session, by tool and what they were about. */
  const allowedForSession = new Set<string>();
  /** Why the last call `permitted` refused was refused, by its id. */
  const refusals = new Map<string, string>();
  /** Why a call is asked, or refused, after the floor refused one in its request (#622). */
  const afterFloor = "Tesota's floor refused a call earlier in this request, so it asks before any other command or file change.";
  /** The runs in which Tesota's floor refused a call (#622). */
  const floorRefused = new Set<number>();
  /**
   * What the model is told after the floor refuses: the refusal covers the
   * effect, not the command, and no one can lift it; with no one to answer
   * a question, as for a subagent, its final reply is where it says so.
   */
  const effectRefused = (offered: readonly EngineTool[]): string =>
    "No one can allow it, the operator included: don't reach the same effect another way, through another tool, a script, an "
    + "interpreter or a subagent. If the work needs it, say so in your final reply"
    + `${options.questions !== undefined && offered.some(isNativeAskTool) ? ", or ask the operator what they want instead" : ""}. `
    + "Until this request ends, Tesota asks before any other command or file change.";
  const refusedCall = (call: ToolCall): ToolOutput =>
    ({ text: `Not run: ${refusals.get(call.id) ?? "it was not allowed."}`, isError: true });

  /**
   * Whether `call` may run (#449): the floor, the mode and the rules decide
   * (`judge`), and the operator answers what they leave to them, once or for
   * the session. Every decision is recorded before the call runs, or instead.
   */
  async function permitted(run: number, call: ToolCall, offered: readonly EngineTool[], signal: AbortSignal): Promise<boolean> {
    const permissions = options.permissions;
    const access = offered.find((tool) => tool.name === call.name)?.access ?? "run";
    const key = `${call.name}\n${JSON.stringify(call.arguments)}`;
    const present = permissions?.ask !== undefined;
    const verdict = heightened(judge(call, access, options.cwd, permissions?.mode() ?? "full", permissions?.rules ?? [], present,
      options.scratch),
      access, run, present);
    let decision: "allow" | "deny" = verdict.decision === "deny" ? "deny" : "allow";
    let by: Decider = verdict.by;
    let reason = verdict.reason;
    if (verdict.decision === "ask" && by !== "after_floor" && allowedForSession.has(key)) {
      by = "session";
      reason = "The operator allowed it for this session.";
    } else if (verdict.decision === "ask") {
      // A stop while the operator is asked ends the wait: the run does not wait for an answer that no longer matters.
      const answer = await untilStopped(permissions?.ask?.(call, verdict.reason) ?? Promise.resolve("deny" as const), signal);
      ({ decision, reason } = operatorDecision(answer));
      by = "operator";
      if (answer === "session") allowedForSession.add(key);
    }
    writer.append({ type: "permission", run, callId: call.id, decision, by, reason });
    if (by === "floor") floorRefused.add(run);
    if (decision === "deny") refusals.set(call.id, by === "floor" ? `${reason} ${effectRefused(offered)}` : reason);
    return decision === "allow";
  }

  /**
   * `verdict` once the floor refused a call in run `run` (#622): what it
   * would allow beyond reading is asked instead, or refused with no one to
   * ask (`afterRefusal`), for the floor's own reason, not the mode's.
   */
  function heightened(verdict: Verdict, access: Access, run: number, present: boolean): Omit<Verdict, "by"> & { by: Decider } {
    const decision = afterRefusal(verdict.decision, access, floorRefused.has(run), present);
    return decision === verdict.decision ? verdict : { decision, by: "after_floor", reason: afterFloor };
  }

  /**
   * Runs `call`, allowed, with its intent on disk first; a run stopped while
   * the operator was asked does not run it. Once the run goes on without
   * the call (`left`), its events reach no more handlers (`ExtensionHost`).
   */
  async function runCall(run: number, call: ToolCall, signal: AbortSignal, left: AbortSignal, offered: readonly EngineTool[],
    reply: number): Promise<ToolOutput> {
    if (signal.aborted) return stoppedCall;
    const selected = offered.find((tool) => tool.name === call.name);
    const nativeQuestion = selected !== undefined && isNativeAskTool(selected);
    const readOnly = options.permissions?.mode() === "read";
    writer.append({ type: "call_intent", run, callId: call.id, access: selected?.access ?? "run",
      tool: { name: call.name, nativeQuestion, readOnly } });
    writer.sync();
    emit({ type: "call", call });
    await host.toolStart({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments, nativeQuestion,
      readOnly }, signal, left);
    if (signal.aborted) return stoppedCall;
    activeQuestion = nativeQuestion ? { run, reply, callId: call.id } : undefined;
    let output: ToolOutput;
    try { output = await execute(offered, call, signal); } finally { activeQuestion = undefined; }
    await host.toolResult({ type: "tool_result", toolCallId: call.id, toolName: call.name, input: call.arguments,
      isError: output.isError }, signal, left);
    return output;
  }

  /**
   * Runs an allowed call between its hooks (#457): `PreToolUse` hooks may
   * still refuse it, recorded as the hook's decision; `PostToolUse` hooks
   * see its result, and one that blocks has its reason added for the model.
   * What hooks say for the operator is a note.
   */
  async function hooked(run: number, call: ToolCall, signal: AbortSignal, left: AbortSignal, offered: readonly EngineTool[],
    reply: number): Promise<ToolOutput> {
    const hooks = options.hooks?.();
    if (hooks === undefined) return await runCall(run, call, signal, left, offered, reply);
    const asked = { session_id: options.sessionId ?? "", cwd: options.cwd, tool_name: call.name, tool_input: call.arguments };
    const before = await runHooks(hooks, { ...asked, hook_event_name: "PreToolUse" }, signal);
    for (const text of before.notes) emit({ type: "note", text });
    if (before.blocked !== undefined) {
      const reason = `A hook refused it: ${before.blocked}`;
      writer.append({ type: "permission", run, callId: call.id, decision: "deny", by: "hook", reason });
      return { text: `Not run: ${reason}`, isError: true };
    }
    const output = await runCall(run, call, signal, left, offered, reply);
    if (left.aborted) return output;
    const after = await runHooks(hooks, { ...asked, hook_event_name: "PostToolUse",
      tool_response: { output: output.text, isError: output.isError } }, signal);
    for (const text of after.notes) emit({ type: "note", text });
    return after.blocked === undefined ? output : { ...output, text: `${output.text}\n\nA hook says: ${after.blocked}` };
  }

  /** Rejected native attempts share the prose repair allowance; skipped sibling calls do not. */
  function questionReturned(run: number, call: ToolCall, output: ToolOutput): ToolOutput {
    const state = questionState(run);
    if (!output.isError || output.details === "cancelled") { state.repairing = false; return output; }
    if (questionRepair(true, options.questions !== undefined, state.repaired, state.times) === "incomplete") {
      state.unresolved ??= `Unresolved question: ${JSON.stringify(call.arguments)}. ${output.text}`;
      return output;
    }
    state.repaired = true;
    state.repairing = true;
    return { ...output, text: `${output.text}\nUse your one question repair to call ask_user with a valid, available question, or clarify that no decision is needed. Unrelated tools will not run.` };
  }

  /** Counts at the call boundary, even when provider truncation prevents argument validation. */
  function questionAttempt(run: number, call: ToolCall, question: boolean): ToolOutput | undefined {
    const state = questionState(run);
    if (state.repairing && !question) {
      state.unresolved = `Unresolved question: ${state.decision}. The question repair did not use ask_user.`;
      return { isError: true, text: "Not run: " + state.unresolved };
    }
    if (question) {
      state.decision = JSON.stringify(call.arguments);
      if (!askAccepted(state.times)) {
        // Named as every unresolved question is, so the operator's reply answers it and continues the request (#713).
        state.unresolved = `Unresolved question: ${JSON.stringify(call.arguments)}. This request already asked the operator three times.`;
        return { isError: true, details: "question-limit", text: state.unresolved + " The operator sees this question and a reply continues the work. Generation ends incomplete; do not ask in plain text." };
      }
      state.times++;
    }
    return undefined;
  }

  /** What one allowed or refused call gives, asked about first; a call made after the stop does not run. */
  async function outcomeOf(run: number, call: ToolCall, signal: AbortSignal, left: AbortSignal, offered: readonly EngineTool[],
    reply: number): Promise<ToolOutput> {
    if (signal.aborted) return stoppedCall;
    const native = offered.find((tool) => tool.name === call.name);
    const question = native !== undefined && isNativeAskTool(native);
    const refused = questionAttempt(run, call, question);
    if (refused !== undefined) return refused;
    const output = !await permitted(run, call, offered, signal) ? signal.aborted ? stoppedCall : refusedCall(call)
      : await hooked(run, call, signal, left, offered, reply);
    return question ? questionReturned(run, call, output) : output;
  }

  /**
   * Runs the reply's calls in order. Each call's intent is synced before it
   * runs, with everything appended before it, so a call that may have
   * changed files is never missing from the session. Every call ends with a
   * result, as Codex gives each one: once the stop interrupts them, the call
   * running has what it reported in time or says it was stopped, and the
   * rest were not run.
   */
  function runCalls(run: number, reply: number, message: AssistantMessage, calls: readonly ToolCall[], signal: AbortSignal,
    offered: readonly EngineTool[]): Effect.Effect<void> {
    return Effect.suspend(() => {
      let next = 0;
      let questionBoundary = false;
      // A call whose id an earlier one in the reply took neither runs nor has a result: an answer, a result,
      // the transcript and recovery all name a call by its id, so the id keeps its first call's one outcome.
      const answeredIds = new Set<string>();
      const answer = (output: ToolOutput): void => {
        const call = calls[next] as ToolCall;
        const result = toolResult(call, output);
        writer.append({ type: "tool_result", run, message: result });
        add(result);
        // A submitted answer enters the conversation once, in its call's result, and the ledger keeps that message.
        const given = answered.get(call.id);
        if (given !== undefined) { answered.delete(call.id); toLedger(result, given.order); }
        answeredIds.add(call.id);
        next += 1;
        const native = offered.find((tool) => tool.name === call.name);
        if (native !== undefined && isNativeAskTool(native)) questionBoundary = true;
      };
      const repeated = (): boolean => answeredIds.has((calls[next] as ToolCall).id);
      // A question answered and saved before the stop keeps its answer, though what ran after it did not report in time.
      const saved = (call: ToolCall): ToolOutput | undefined => {
        const given = answered.get(call.id);
        return given === undefined ? undefined : { isError: false, text: given.text };
      };
      const each = Effect.gen(function* () {
        while (next < calls.length) {
          const call = calls[next] as ToolCall;
          if (repeated()) next += 1;
          else if (questionBoundary || questionState(run).unresolved !== undefined) answer({ isError: true, text: "Not run: reconsider this call after reading the question's outcome." });
          else if (message.stopReason === "length") {
            const native = offered.find((tool) => tool.name === call.name);
            const question = native !== undefined && isNativeAskTool(native);
            const output = questionAttempt(run, call, question) ?? truncatedCall(call);
            answer(question ? questionReturned(run, call, output) : output);
          }
          else yield* step((left) => outcomeOf(run, call, signal, left, offered, reply), (given, ms) => { answer(Option.isSome(given) ? given.value : saved(call) ?? stoppedAfter(ms)); });
        }
      });
      return each.pipe(Effect.onInterrupt(() => Effect.sync(() => {
        while (next < calls.length) { if (repeated()) next += 1; else answer(stoppedCall); }
      })));
    });
  }

  /**
   * Compacts the conversation (#451): everything before the verbatim tail
   * (`cutPoint`) is summarized by the session's model, merged into the
   * previous summary, and replaced by the run's request and amendments as
   * given followed by the summary. A failed summary is tried once more; one
   * larger than what it replaced ends it. Returns why it did not compact, or
   * nothing once it did. A stop interrupts the summary; its usage, when the
   * model reports it in time, is still counted.
   */
  const compact = (run: number, signal: AbortSignal): Effect.Effect<string | undefined> => Effect.gen(function* () {
    const head = compacted === undefined ? 0 : 1;
    const sizes = history.map(estimateTokens);
    const cut = cutPoint(sizes, history.map((message, index) => index >= head && message.role !== "toolResult"), margins.keep);
    if (cut <= head) return nothingToSummarize;
    const older = history.slice(head, cut);
    const touched = filesTouched(older);
    const files = {
      changed: [...new Set([...compacted?.files.changed ?? [], ...touched.changed])],
      read: [...new Set([...compacted?.files.read ?? [], ...touched.read])],
    };
    const tokensBefore = usage()?.tokens ?? sizes.reduce((sum, size) => sum + size, 0);
    const replaced = sizes.slice(0, cut).reduce((sum, size) => sum + size, 0);
    emit({ type: "compacting" });
    const counted = (result: Awaited<ReturnType<typeof summarize>>): void => {
      if (result.usage === undefined) return;
      tokens.input += result.usage.input;
      tokens.output += result.usage.output;
      tokens.total += result.usage.totalTokens;
      writer.append({ type: "summary_usage", run, input: result.usage.input, output: result.usage.output,
        total: result.usage.totalTokens });
    };
    let failure = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* step(() => summarize({ cwd: options.cwd, models: options.models, model: options.model, previous: compacted?.summary,
        messages: older, files, signal }), (given) => { if (Option.isSome(given)) counted(given.value); });
      if (signal.aborted) return stoppedReason;
      if ("error" in result) { failure = result.error; continue; }
      const head = compactedHead(ledger, result.summary, files, history.slice(cut));
      if (estimateTokens(head) >= replaced) return "compaction failed: the summary came out larger than what it replaced";
      const kept = history.length - cut;
      history.splice(0, cut, head);
      compacted = { summary: result.summary, files, counted: history.length };
      const tokensAfter = usage()?.tokens ?? 0;
      stuck = shouldCompact(tokensAfter, options.model.contextWindow ?? 0, margins.reserve);
      writer.append({ type: "compaction", run, summary: result.summary, kept, read: files.read, changed: files.changed,
        tokensBefore, tokensAfter });
      writer.sync();
      emit({ type: "compacted", tokensBefore, tokensAfter });
      return undefined;
    }
    return `compaction failed twice: ${failure}`;
  });

  /**
   * Compacts before a request once the conversation is past the margin, or
   * after the provider rejected it as too long (`overflow`). Past the margin
   * with nothing old enough to summarize the request goes as it is; after an
   * overflow that ends the turns. Returns how they end, or nothing.
   */
  const compactFor = (run: number, signal: AbortSignal, overflow: boolean): Effect.Effect<Ended | undefined> => Effect.gen(function* () {
    const used = usage();
    if (!overflow && (stuck || used?.tokens == null || !shouldCompact(used.tokens, used.contextWindow, margins.reserve))) {
      return undefined;
    }
    const failed = yield* compact(run, signal);
    if (signal.aborted) return { outcome: "aborted", reason: stoppedReason };
    if (failed === undefined || (!overflow && failed === nothingToSummarize)) return undefined;
    return { outcome: "error", reason: failed };
  });

  /**
   * Whether input came for a run whose model stopped, delivered: what waited,
   * or, while its jobs still run, the next job's end or input, which it waits
   * for (#525). None once nothing waits and no job runs.
   */
  const awaitInput = (run: number): Effect.Effect<boolean> => Effect.gen(function* () {
    for (let seen = changes; !deliver(run, ["steer", "followUp"]); seen = changes) {
      if (jobs.size === 0) return false;
      yield* change(seen);
    }
    return true;
  });

  /** One lexical repair at the normal tool-free end, after queued input has had its turn. */
  function repairQuestion(run: number, message: AssistantMessage, offered: readonly EngineTool[]): Ended | "repair" | undefined {
    const question = blockingProseQuestion(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"));
    const state = questionState(run);
    const action = questionRepair(question !== undefined, options.questions !== undefined && offered.some(isNativeAskTool), state.repaired, state.times);
    if (action === "incomplete") return { outcome: "completed", incomplete: true, reason: `Unresolved question: ${question}` };
    if (action !== "repair") { state.repairing = false; return undefined; }
    state.repaired = true;
    state.repairing = true;
    state.decision = question;
    record(run, [{ type: "custom_message", customType: "question-repair", display: false,
      content: `Put this blocking decision through ask_user, preserving its meaning: ${question}\nOnly call ask_user, or clarify that no decision is needed. Do not change files or answer on the operator's behalf.` }]);
    return "repair";
  }

  const toolFreeEnd = (run: number, message: AssistantMessage, offered: readonly EngineTool[]): Effect.Effect<Ended | "continue"> => Effect.gen(function* () {
    if (yield* awaitInput(run)) { questionState(run).repairing = false; return "continue"; }
    const repair = repairQuestion(run, message, offered);
    return repair === "repair" ? "continue" : repair ?? { outcome: "completed" };
  });

  function afterCalls(run: number, signal: AbortSignal): Ended | undefined {
    if (signal.aborted) return { outcome: "aborted", reason: stoppedReason };
    const unresolved = questionState(run).unresolved;
    return unresolved === undefined ? undefined : { outcome: "completed", incomplete: true, reason: unresolved };
  }

  /**
   * The model's turns, until it answers without calling a tool and no input
   * waits, fails, or is stopped. After settlement sent the run back, the run
   * is at the boundary where follow-ups enter, so they enter with the steers.
   * The operator's stop interrupts them (`turnsOf`).
   */
  const turns = (run: number, signal: AbortSignal, settled: boolean): Effect.Effect<Ended> => Effect.gen(function* () {
    let boundary = settled;
    let overflowed = false;
    for (;;) {
      deliver(run, boundary ? ["steer", "followUp"] : ["steer"]);
      boundary = false;
      const due = yield* compactFor(run, signal, false);
      if (due !== undefined) return due;
      tools.offer(options.mcp?.()?.tools(spool) ?? []);
      // A reply's calls run with the tools its request offered, whatever extensions change meanwhile.
      const offered = tools.forRequest();
      const message = yield* reply(run, signal, offered);
      if (!("role" in message)) return message;
      // A provider that rejects the conversation as too long gets it once more, compacted.
      if (message.stopReason === "error" && !overflowed && isContextOverflow(message, options.model.contextWindow)) {
        overflowed = true;
        const ended = yield* compactFor(run, signal, true);
        if (ended !== undefined) return ended;
        continue;
      }
      if (message.stopReason === "error") return { outcome: "error", reason: message.errorMessage ?? "the provider failed" };
      overflowed = false;
      if (message.stopReason === "aborted" || signal.aborted) return { outcome: "aborted", reason: stoppedReason };
      const calls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
      if (calls.length === 0) {
        const end = yield* toolFreeEnd(run, message, offered);
        if (end === "continue") continue;
        return end;
      }
      const replyIndex = (replyIndexes.get(run) ?? 1) - 1;
      yield* runCalls(run, replyIndex, message, calls, signal, offered);
      const ended = afterCalls(run, signal);
      if (ended !== undefined) return ended;
    }
  });

  /**
   * Runs the model's turns as a fiber the run's signal interrupts, also
   * when the stop comes while the fiber's first steps run synchronously: a
   * run already stopped takes no turn, and one interrupted ends aborted with
   * every step it was in recorded.
   */
  async function turnsOf(run: number, signal: AbortSignal, settled: boolean): Promise<Ended> {
    if (signal.aborted) return { outcome: "aborted", reason: stoppedReason };
    return endedBy(await Effect.runPromiseExit(turns(run, signal, settled), { signal }));
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
      continuationLimit, ended.incomplete === true);
    if (first === "continue") return { next: "continue", automatic: true };
    const verifying = first === "verify";
    const question = ended.incomplete === true ? `; ${ended.reason}` : "";
    const why = signal.aborted ? stoppedReason : ordinary.errors.length > 0 ? `a settle handler failed: ${ordinary.errors.join("; ")}${question}`
      : ended.incomplete === true ? ended.reason : ordinary.continued ? `settlement sent the run back ${continuationLimit} times` : ended.reason;
    const told: RunOutcome = signal.aborted ? "aborted" : verifying ? "completed" : ended.outcome === "completed" ? "error" : ended.outcome;
    const returned = await phase(run, generation, "verifier", told, signal, verifying ? ended.reason : why);
    const verdict = settled(run, generation, "verifier", returned);
    const errors = [...ordinary.errors, ...verdict.errors];
    const next = afterVerifier(ended.outcome, verifying, signal.aborted, errors.length > 0, verdict.registered, verdict.continued,
      queue.length > 0 || finishedJobs.length > 0, jobs.size > 0, continuations, continuationLimit, ended.incomplete === true);
    if (next === "continue") return { next: "continue", automatic: verdict.continued };
    const reason = next === "completed" ? undefined : next === "aborted" ? stoppedReason
      : errors.length > 0 ? `a settle handler failed: ${errors.join("; ")}${question}`
        : !verdict.registered ? "the verifier has no settle handler"
          : ended.incomplete === true ? why : verdict.continued ? `settlement sent the run back ${continuationLimit} times` : why;
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
  async function start(run: number, text: string, origin: Origin, signal: AbortSignal, skill: StartedSkill | undefined,
    continues: Continuation | undefined): Promise<void> {
    const at = new Date().toISOString();
    const asked: HistoryMessage = { role: "user", content: text, timestamp: Date.parse(at) };
    const instructed = skill === undefined ? undefined : skillMessage(skill, Date.parse(at));
    // A run exists once its request is in the file: one whose base could not be captured is no run, so its
    // number is given again and the input that waited for it is refused, as the file reader requires.
    const written = (async () => {
      let captured: Base;
      try { captured = continues?.base ?? await base(options.cwd, signal); } catch (error) { closed = true; throw error; }
      writer.append({ type: "request", run, text, origin, at, base: captured, ...skill === undefined ? {} : { skill } });
      // The run it continues and the answer go in with the request, before anything runs.
      if (continues !== undefined) {
        writer.append({ type: "custom", run, customType: continuesType, data: { run: continues.run, clarification: continues.clarification } });
      }
      runs = run;
      // The run's input is counted from its request and its skill on, before input that came while it starts takes its place.
      ledger = instructed === undefined ? [asked] : [asked, instructed];
      inputOrder.clear();
      ledger.forEach((message, index) => inputOrder.set(message, index));
      nextInputOrder = ledger.length;
      answered.clear();
      writer.sync();
    })();
    recorded = written.catch(() => undefined);
    await written;
    await host.input({ type: "input", text, source: origin }, signal);
    // The MCP servers starting with the session get a while to connect before the model hears of the request (#459).
    await options.mcp?.()?.ready(signal);
    add(asked);
    if (instructed !== undefined) add(instructed);
    let generation = 0;
    let continuations = 0;
    for (;;) {
      const ended = await turnsOf(run, signal, generation > 0);
      // A run's jobs end with it (#525): those still running are stopped, and their ends enter the conversation before it settles.
      if (jobs.size > 0) {
        await stopJobs();
        deliver(run, []);
      }
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
      emit({ type: "ended", outcome: decided.outcome, ...ended.reason === undefined ? {} : { reason: ended.reason } });
      return;
    }
  }

  /**
   * Input during a run: an amendment, synced into the ledger after its
   * request and queued; its input handlers run at once, or after the
   * settlement in progress, so no verification sees half of it.
   */
  async function amend(text: string, behavior: Behavior, origin: Origin, signal: AbortSignal | undefined,
    skill: StartedSkill | undefined): Promise<void> {
    await recorded;
    if (closed) throw new Error("The run ended before this input arrived; send it as a new prompt.");
    const run = runs;
    const id = ++amendments;
    writer.append({ type: "amendment", run, id, behavior, origin, text, at: new Date().toISOString(), ...skill === undefined ? {} : { skill } });
    writer.sync();
    queue.push({ id, behavior, text, order: nextInputOrder++, ...skill === undefined ? {} : { skill } });
    emit({ type: "pending" });
    changed();
    const handlers = () => host.input({ type: "input", text, source: origin, streamingBehavior: behavior }, signal);
    if (settling) { waiting.push(handlers); return; }
    const running = handlers();
    handling.add(running);
    try { await running; } finally { handling.delete(running); }
  }

  return {
    async prompt(text, { streamingBehavior, source = "interactive", continues } = {}) {
      if (questionFailure !== undefined) throw questionFailure;
      if (disposed !== undefined) throw new Error(disposedReason);
      const admission = new AbortController();
      admitting.add(admission);
      const refused = () => {
        if (questionFailure !== undefined) throw questionFailure;
        if (disposed !== undefined) throw new Error(disposedReason);
        if (admission.signal.aborted) throw new Error(stoppedReason);
      };
      try {
        // Startup is awaited directly, so a prompt asked before `/compact` claims the session first; a stop interrupts the
        // wait for a compaction.
        await started;
        refused();
        // Checked again after each wait, with no wait between the last check and the run's start, so a compaction
        // asked for meanwhile cannot start under it.
        while (compacting !== undefined) {
          await untilStopped(compacting.done.catch(() => undefined), admission.signal);
          refused();
        }
      } finally { admitting.delete(admission); }
      // Only the operator starts a skill by name; an extension's text is never their request.
      const skill = source === "extension" ? undefined : startedSkill(text, available);
      if (running !== undefined) {
        if (streamingBehavior === undefined || continues !== undefined) throw new Error("A prompt is already running; steer it, queue a follow-up, abort it or wait.");
        // A skill started during a run waits for the run's turns to end, as a follow-up; it never steers them.
        await amend(text, skill === undefined ? streamingBehavior : "followUp", source, controller?.signal, skill);
        return;
      }
      controller = admission;
      queue = [];
      waiting = [];
      closed = false;
      emit({ type: "state", state: "working" });
      const run = runs + 1;
      const current = start(run, text, source, controller.signal, skill, continues);
      running = current;
      try {
        await current;
      } catch (error) {
        // Only a request in the file failed as a run; one that never became a run leaves the session's outcome as it was.
        if (runs === run) outcome = "error";
        // A failed run never settles, so its input handlers still running are stopped and finish here, as settlement's would.
        admission.abort();
        await Promise.all(handling);
        throw error;
      } finally {
        running = undefined;
      }
    },
    async abort() {
      // The signal both tells what runs cooperatively and interrupts the turns and a compaction; waiting for them waits
      // for what their interruption records.
      for (const admission of admitting) admission.abort();
      controller?.abort();
      compacting?.controller.abort();
      await running?.catch(() => undefined);
      await compacting?.done.catch(() => undefined);
    },
    async compact() {
      if (questionFailure !== undefined) throw questionFailure;
      if (disposed !== undefined) throw new Error(disposedReason);
      await started;
      if (questionFailure !== undefined) throw questionFailure;
      if (disposed !== undefined) throw new Error(disposedReason);
      if (running !== undefined) throw new Error("A run is going; wait for it to end, or stop it, then compact.");
      if (compacting !== undefined) throw new Error("The conversation is already being compacted.");
      if (runs === 0) throw new Error("There is nothing to compact yet.");
      const stopper = new AbortController();
      const done = (async () => {
        // It starts once `compacting` names it, so a stop from its own `compacting` event reaches it.
        await Promise.resolve();
        const exit = await Effect.runPromiseExit(compact(runs, stopper.signal), { signal: stopper.signal });
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
        const failed = Exit.isSuccess(exit) ? exit.value : stoppedReason;
        if (failed !== undefined) throw new Error(failed === nothingToSummarize ? `Nothing to compact: ${failed}.` : failed);
      })();
      compacting = { done, controller: stopper };
      try { await done; } finally { compacting = undefined; }
    },
    skills: () => available.filter((skill) => startable(skill, "operator")),
    messages: () => history.map(conversationMessage),
    history: () => history,
    pendingMessages: () => queue.map(({ id, behavior, text }) => ({ id, behavior, text })),
    withdrawPendingMessages: () => {
      const withdrawn = queue;
      for (const { id } of withdrawn) writer.append({ type: "withdrawn", run: runs, amendment: id });
      if (withdrawn.length > 0) writer.sync();
      queue = [];
      emit({ type: "pending" });
      changed();
      return withdrawn.map(({ id, behavior, text }) => ({ id, behavior, text }));
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    lastAssistantText: () => {
      const last = history.findLast((message): message is AssistantMessage => message.role === "assistant");
      return last?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    },
    stats: () => ({ tokens: { ...tokens } }),
    outcome: () => outcome,
    dispose: () => disposed ??= (async () => {
      lifetime.abort();
      for (const admission of admitting) admission.abort();
      controller?.abort();
      compacting?.controller.abort();
      // Its startup handlers finish before the session's file and lock go, so none runs on after it.
      await started;
      await running?.catch(() => undefined);
      await compacting?.done.catch(() => undefined);
      writer.close();
    })(),
  };
}
