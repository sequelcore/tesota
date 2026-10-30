import type { AssistantMessage, SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Base } from "./base.ts";
import type { Clarification } from "../../../src/clarification.ts";
import type { FloorRefusal } from "../../../src/receipt.ts";
import type { StartedSkill } from "./instructions.ts";
import { validateAnswers, validateQuestions } from "./questions-schema.ts";
import { floorNotice } from "./permissions.ts";
import type { PromptOptions, RunOutcome, SessionOutcome } from "../../../src/contract.ts";

/**
 * Tesota's session format (#437): one JSON Lines file per session, written
 * by one writer and only appended to. Its first line is the header; the
 * rest are entries, in the order they happened. The request ledger is the
 * `request`, `amendment` and `clarification` entries: written, and synced, before the model
 * hears of them, and never rewritten. Version 2 (#439) records each run's
 * settlement, and a run ends `completed` only after its verifier's. Version 3
 * (#520) records submitted native questions as attributed request input.
 * Version 4 (#541) records each call's declared access and keeps an interrupted call's output.
 * Version 5 (#525) records the jobs a run starts and how each ended, and a
 * child session names its parent in its header. Version 6 (#606) records
 * withdrawal of pending amendments without erasing the original input.
 * Version 7 (#779) records the system prompt and tools as the model has them:
 * a leading system message, then each change appended, in place of the
 * active tools' names.
 */
export const sessionFormat = "tesota-session";
export const sessionVersion = 7;

export interface SessionHeader {
  readonly type: "session";
  readonly format: typeof sessionFormat;
  readonly version: typeof sessionVersion;
  readonly id: string;
  /** The folder the session works in: its checkout, or the same folder inside its worktree (#453). */
  readonly cwd: string;
  readonly createdAt: string;
  /** Where the session was opened, and its worktree, branch and starting commit when it has one (#453). */
  readonly checkout?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly base?: string;
  /** A child session's parent (#525): its session's id, the job that started this one, and how far below the top session it is. */
  readonly parent?: { readonly session: string; readonly job: string; readonly depth: number };
}

/** Where input came from, as Pi's input event says; an extension's text is never the operator's request. */
export type Origin = NonNullable<PromptOptions["source"]>;

/** Input that arrives while a run is going: a steer enters after the current calls, a follow-up when the run would end. */
export type Behavior = NonNullable<PromptOptions["streamingBehavior"]>;

/** How recovery repaired a call that has no result: its outcome is unknown, it never started, or it only reads. */
export type Repair = "outcome_unknown" | "not_run" | "no_effect";

/** Who settles in a phase: the ordinary extensions, then the verifier. */
export type SettlePhase = "extensions" | "verifier";

export type SessionEntry =
  /**
   * The operator's request, which starts run `run`, and the base it is
   * measured against. A request that starts a skill by name (#540) keeps the
   * line the operator typed as `text` and the skill's instructions apart, so
   * only the model reads them.
   */
  | { readonly type: "request"; readonly run: number; readonly text: string; readonly origin: Origin; readonly at: string;
    readonly base: Base; readonly skill?: StartedSkill }
  /** Input accepted while run `run` was going; one that starts a skill by name keeps it apart, as a request does (#540). */
  | { readonly type: "amendment"; readonly run: number; readonly id: number; readonly behavior: Behavior;
    readonly origin: Origin; readonly text: string; readonly at: string; readonly skill?: StartedSkill }
  /** A submitted native answer. Its batch is immutable and belongs to one assistant reply and call. */
  | { readonly type: "clarification"; readonly run: number; readonly clarification: Clarification }
  /** An amendment entered the conversation. */
  | { readonly type: "delivered"; readonly run: number; readonly amendment: number }
  /** Pending input returned to the operator, no longer part of the request. */
  | { readonly type: "withdrawn"; readonly run: number; readonly amendment: number }
  | { readonly type: "assistant"; readonly run: number; readonly message: AssistantMessage }
  /**
   * A call is about to run; recorded, and synced, first. `tool` is what the
   * gate is told as it starts, from which recovery decides, by the gate's
   * rule, whether it may have changed files (#599); an older file has none.
   */
  | { readonly type: "call_intent"; readonly run: number; readonly callId: string; readonly access: "read" | "write" | "run";
    readonly tool?: { readonly name: string; readonly nativeQuestion: boolean; readonly readOnly: boolean } }
  /** A call's result: the one the model saw, of a call that ran or was refused. */
  | { readonly type: "tool_result"; readonly run: number; readonly message: ToolResultMessage }
  /** Recovery's repair of call `callId` of reply `reply` (counted from 0 in its run), which has no result. */
  | { readonly type: "reconciliation"; readonly run: number; readonly reply: number; readonly callId: string;
    readonly toolName: string; readonly repair: Repair; readonly output?: string; readonly path?: string }
  /**
   * A settlement phase of run `run` starts, in its `generation`: how many
   * times settlement sent the run back to the model before. `outcome` is
   * what the phase's handlers are told about the run.
   */
  | { readonly type: "settle"; readonly run: number; readonly generation: number; readonly phase: SettlePhase;
    readonly outcome: RunOutcome }
  /** A message a settle handler added: it enters the conversation as context for the model. */
  | { readonly type: "custom_message"; readonly run: number; readonly customType: string; readonly content: string;
    readonly display: boolean; readonly details?: unknown }
  /** Data a settle handler recorded outside the conversation. */
  | { readonly type: "custom"; readonly run: number; readonly customType: string; readonly data?: unknown }
  /**
   * The conversation was compacted during or after run `run` (#451): from
   * then on it holds the run's request and amendments as given, `summary` in
   * place of everything before the last `kept` messages, and those messages.
   * `read` and `changed` are the files the summarized messages touched.
   */
  /** What a compaction's summary request used (#451), so the session's usage counts it after a resume. */
  | { readonly type: "summary_usage"; readonly run: number; readonly input: number; readonly output: number; readonly total: number }
  | { readonly type: "compaction"; readonly run: number; readonly summary: string; readonly kept: number;
    readonly read: readonly string[]; readonly changed: readonly string[]; readonly tokensBefore: number;
    readonly tokensAfter: number }
  /**
   * The phase's result, after the entries it added: whether it sent the run
   * back, what its handlers threw, and for the verifier whether it had a
   * settle handler at all.
   */
  | { readonly type: "settled"; readonly run: number; readonly generation: number; readonly phase: SettlePhase;
    readonly continued: boolean; readonly errors: readonly string[]; readonly registered: boolean }
  /**
   * Whether call `callId` of run `run` may run, and who decided it (#449):
   * the floor, the mode, a rule, the operator asked once or for the session,
   * or, with no one to ask, the floor's refusal of an earlier call in the
   * same request (`after_floor`, #622).
   */
  | { readonly type: "permission"; readonly run: number; readonly callId: string; readonly decision: "allow" | "deny";
    readonly by: "floor" | "mode" | "rule" | "operator" | "session" | "hook" | "after_floor"; readonly reason: string }
  /**
   * The system prompt and tools the model has from here on (#779): the
   * session's leading system message, or a change to it appended after the
   * conversation so far. A compaction starts them over with a new leading one.
   */
  | { readonly type: "system"; readonly message: SystemMessage }
  /**
   * Job `job` of run `run` starts (#525), recorded and synced before it
   * runs: an agent job's child session, in `session`, from call `callId`. A
   * background job's end comes as input; the call waits for one that is not.
   */
  | { readonly type: "job_start"; readonly run: number; readonly job: string; readonly callId: string; readonly kind: "agent";
    readonly description: string; readonly background: boolean; readonly session: string; readonly details?: unknown }
  /**
   * How job `job` ended: what the model reads of it (`text`, which enters the
   * conversation for a background job, when the run took it in) and its
   * report (`details`); `unknown` when the process ended while it ran.
   */
  | { readonly type: "job_end"; readonly run: number; readonly job: string; readonly outcome: string; readonly text: string;
    readonly details?: unknown }
  /** How run `run` ended, and why when it did not complete. */
  | { readonly type: "run_end"; readonly run: number; readonly outcome: SessionOutcome; readonly reason?: string };

/** The file is not a session Tesota can read safely; nothing in it is skipped or guessed. */
export class SessionFileError extends Error {
  constructor(path: string, problem: string) {
    super(`${path} ${problem}`);
    this.name = "SessionFileError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): boolean => typeof value === "string";
const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 1;
const isFlag = (value: unknown): boolean => typeof value === "boolean";
/** A started skill, when the entry has one (#540). */
const isSkill = (value: unknown): boolean => value === undefined
  || (isObject(value) && isText(value["name"]) && isText(value["path"]) && isText(value["instructions"]));
const origins = new Set(["interactive", "rpc", "extension"]);
const phases = new Set(["extensions", "verifier"]);

/** What each entry must hold besides its run, as far as reading it back depends on. */
const shapes: Record<SessionEntry["type"], (entry: Record<string, unknown>) => boolean> = {
  request: (entry) => isText(entry["text"]) && origins.has(entry["origin"] as string) && isText(entry["at"])
    && isObject(entry["base"]) && Array.isArray(entry["base"]["units"]) && isSkill(entry["skill"]),
  amendment: (entry) => isCount(entry["id"]) && (entry["behavior"] === "steer" || entry["behavior"] === "followUp")
    && origins.has(entry["origin"] as string) && isText(entry["text"]) && isText(entry["at"]) && isSkill(entry["skill"]),
  clarification: (entry) => isObject(entry["clarification"]) && Number.isInteger(entry["clarification"]["reply"])
    && isText(entry["clarification"]["callId"]) && isText(entry["clarification"]["at"])
    && Array.isArray(entry["clarification"]["questions"]) && Array.isArray(entry["clarification"]["answers"]),
  delivered: (entry) => isCount(entry["amendment"]),
  withdrawn: (entry) => isCount(entry["amendment"]),
  assistant: (entry) => isObject(entry["message"]) && entry["message"]["role"] === "assistant" && Array.isArray(entry["message"]["content"]),
  call_intent: (entry) => isText(entry["callId"]) && ["read", "write", "run"].includes(entry["access"] as string)
    && (entry["tool"] === undefined || isObject(entry["tool"]) && isText(entry["tool"]["name"]) && isFlag(entry["tool"]["nativeQuestion"])
      && isFlag(entry["tool"]["readOnly"])),
  tool_result: (entry) => isObject(entry["message"]) && entry["message"]["role"] === "toolResult",
  reconciliation: (entry) => Number.isInteger(entry["reply"]) && isText(entry["callId"]) && isText(entry["toolName"])
    && ["outcome_unknown", "not_run", "no_effect"].includes(entry["repair"] as string)
    && (entry["output"] === undefined || isText(entry["output"])) && (entry["path"] === undefined || isText(entry["path"])),
  settle: (entry) => Number.isInteger(entry["generation"]) && phases.has(entry["phase"] as string) && isText(entry["outcome"]),
  custom_message: (entry) => isText(entry["customType"]) && isText(entry["content"]) && isFlag(entry["display"]),
  custom: (entry) => isText(entry["customType"]),
  summary_usage: (entry) => Number.isFinite(entry["input"]) && Number.isFinite(entry["output"]) && Number.isFinite(entry["total"]),
  compaction: (entry) => isText(entry["summary"]) && Number.isInteger(entry["kept"]) && (entry["kept"] as number) >= 0
    && Array.isArray(entry["read"]) && entry["read"].every(isText) && Array.isArray(entry["changed"]) && entry["changed"].every(isText)
    && Number.isInteger(entry["tokensBefore"]) && Number.isInteger(entry["tokensAfter"]),
  settled: (entry) => Number.isInteger(entry["generation"]) && phases.has(entry["phase"] as string) && isFlag(entry["continued"])
    && Array.isArray(entry["errors"]) && entry["errors"].every(isText) && isFlag(entry["registered"]),
  system: (entry) => isObject(entry["message"]) && entry["message"]["role"] === "system",
  permission: (entry) => isText(entry["callId"]) && (entry["decision"] === "allow" || entry["decision"] === "deny")
    && ["floor", "mode", "rule", "operator", "session", "hook", "after_floor"].includes(entry["by"] as string) && isText(entry["reason"]),
  job_start: (entry) => isText(entry["job"]) && isText(entry["callId"]) && entry["kind"] === "agent" && isText(entry["description"])
    && isFlag(entry["background"]) && isText(entry["session"]),
  job_end: (entry) => isText(entry["job"]) && isText(entry["outcome"]) && isText(entry["text"]),
  run_end: (entry) => isText(entry["outcome"]) && (entry["reason"] === undefined || isText(entry["reason"])),
};

/** Whether `entry` is a verifier's settlement that lets its run complete: it had a settle handler, which neither threw nor sent the run back. */
const verifiedBy = (entry: SessionEntry | undefined): boolean => entry?.type === "settled" && entry.phase === "verifier"
  && entry.registered && !entry.continued && entry.errors.length === 0;

/**
 * An entry read back, checked against what came before it: a request opens
 * the next run, every other entry belongs to a run already opened, and a
 * run ends `completed` only right after its verifier's settlement allowed it.
 */
function entryAt(value: unknown, runs: number, previous: SessionEntry | undefined): SessionEntry | undefined {
  if (!isObject(value) || typeof value["type"] !== "string" || !(value["type"] in shapes)) return undefined;
  const type = value["type"] as SessionEntry["type"];
  const run = value["run"];
  // The system prompt belongs to the session, not to a run: an extension may change it before the first.
  const placed = type === "request" ? run === runs + 1
    : type === "system" ? run === undefined : isCount(run) && (run as number) <= runs;
  const completes = type === "run_end" && value["outcome"] === "completed";
  return placed && shapes[type](value) && (!completes || (previous?.type === "settled" && verifiedBy(previous) && previous.run === run))
    ? value as unknown as SessionEntry : undefined;
}

/** A retained answer is trusted only when it names an earlier native call and its immutable offered batch. */
function linkedClarification(entry: Extract<SessionEntry, { readonly type: "clarification" }>, entries: readonly SessionEntry[]): boolean {
  const clarification = entry.clarification;
  if (clarification.reply < 0 || validateQuestions(clarification.questions) !== undefined
    || validateAnswers(clarification.questions, clarification.answers) !== undefined) return false;
  const replies = entries.filter((prior): prior is Extract<SessionEntry, { readonly type: "assistant" }> => prior.type === "assistant" && prior.run === entry.run);
  if (clarification.reply !== replies.length - 1) return false;
  const message = replies.at(-1)?.message;
  const call = message?.content.find((part) => part.type === "toolCall" && part.id === clarification.callId);
  if (call?.type !== "toolCall" || call.name !== "ask_user") return false;
  const priorReply = entries.lastIndexOf(replies.at(-1) as SessionEntry);
  const invocation = entries.slice(priorReply + 1);
  if (!invocation.some((prior) => prior.type === "call_intent" && prior.callId === clarification.callId)) return false;
  if (invocation.some((prior) => prior.type === "clarification" && prior.clarification.callId === clarification.callId
    || prior.type === "tool_result" && prior.message.toolCallId === clarification.callId
    || prior.type === "run_end")) return false;
  const argumentsOf = (call.arguments ?? {}) as Record<string, unknown>;
  return JSON.stringify(argumentsOf["questions"]) === JSON.stringify(clarification.questions)
    && clarification.answers.length === clarification.questions.length;
}

function headerOf(value: unknown, path: string): SessionHeader {
  if (!isObject(value) || value["type"] !== "session" || value["format"] !== sessionFormat) {
    throw new SessionFileError(path, "is not a Tesota session: its first line is not a session header.");
  }
  if (value["version"] !== sessionVersion) {
    throw new SessionFileError(path, `is a version ${String(value["version"])} session; this Tesota reads version ${sessionVersion}.`);
  }
  if (!isText(value["id"]) || !isText(value["cwd"]) || !isText(value["createdAt"])) {
    throw new SessionFileError(path, "has a session header without its id, folder or creation time.");
  }
  return value as unknown as SessionHeader;
}

const parsed = (line: string): unknown => {
  try { return JSON.parse(line); } catch { return undefined; }
};

/** What reading a session found, and what it had to repair at the end of the file. */
export interface ReadSession {
  readonly header: SessionHeader;
  readonly entries: readonly SessionEntry[];
  /** `torn`: an incomplete last line, removed; `unterminated`: a whole last entry without its newline, kept. */
  readonly tail: "whole" | "torn" | "unterminated";
}

/**
 * A session read back for its one writer, which holds its lock. The header
 * is checked first; then every line must be a whole entry in its place, or
 * the session does not open: no line is skipped, as Pi and Codex skip
 * them. Only the end of the file is repaired, where an interrupted write
 * leaves it: a last line without its newline is kept when it is a whole
 * entry and cut off otherwise, and the repair is synced.
 */
export function readSessionFile(path: string): ReadSession {
  const bytes = readFileSync(path);
  const { header, entries, take, end } = wholeLines(path, bytes);
  const remainder = bytes.subarray(end + 1);
  if (remainder.length === 0) return { header, entries, tail: "whole" };
  const fd = openSync(path, "r+");
  try {
    const whole = take(remainder.toString("utf8"));
    if (whole) writeSync(fd, "\n", bytes.length);
    else ftruncateSync(fd, end + 1);
    fsyncSync(fd);
    return { header, entries, tail: whole ? "unterminated" : "torn" };
  } finally {
    closeSync(fd);
  }
}

/**
 * A session read by someone other than its writer, as `tesota receipt`
 * reads one (#463): its whole lines only, and the file left as it is, since
 * its writer may be appending the last line now.
 */
export function peekSessionFile(path: string): Omit<ReadSession, "tail"> {
  const { header, entries } = wholeLines(path, readFileSync(path));
  return { header, entries };
}

/** The header and entries of a session's whole lines, `take` to read one more entry, and where the last whole line ends. */
function wholeLines(path: string, bytes: Buffer): { header: SessionHeader; entries: SessionEntry[]; take: (line: string) => boolean; end: number } {
  const end = bytes.lastIndexOf(0x0a);
  const lines = end < 0 ? [] : bytes.subarray(0, end).toString("utf8").split("\n");
  const [first, ...rest] = lines;
  if (first === undefined) throw new SessionFileError(path, "has no session header.");
  const header = headerOf(parsed(first), path);
  const entries: SessionEntry[] = [];
  let runs = 0;
  /** Takes the line as the next entry, when it is one. */
  const take = (line: string): boolean => {
    const entry = entryAt(parsed(line), runs, entries.at(-1));
    if (entry === undefined || (entry.type === "clarification" && !linkedClarification(entry, entries))) return false;
    if (entry.type === "withdrawn") {
      if (!entries.some((prior) => prior.type === "amendment" && prior.run === entry.run && prior.id === entry.amendment)
        || entries.some((prior) => (prior.type === "delivered" || prior.type === "withdrawn") && prior.amendment === entry.amendment)) return false;
    }
    if (entry.type === "request") runs = entry.run;
    entries.push(entry);
    return true;
  };
  for (const [index, line] of rest.entries()) {
    if (!take(line)) throw new SessionFileError(path, `has a broken entry on line ${index + 2}.`);
  }
  return { header, entries, take, end };
}

/** Where a session's entries go: appended in order, and made durable at each `sync`. */
export interface SessionWriter {
  append(entry: SessionEntry): void;
  /** Flushes everything appended so far to the disk; throws when the system cannot. */
  sync(): void;
  close(): void;
}

/** Writes all of `text`, however many writes the system takes. */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
}

/** Syncs a folder so a file just renamed into it stays there; Windows has no handle for that and journals it. */
function syncFolder(folder: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(folder, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Appends entries to the session file at `path`. */
export function sessionWriter(path: string): SessionWriter {
  const fd = openSync(path, "a");
  return {
    append: (entry) => { writeAll(fd, `${JSON.stringify(entry)}\n`); },
    sync: () => { fsyncSync(fd); },
    close: () => { closeSync(fd); },
  };
}

/** Creates the session file at `path` with its header, whole or not at all: written beside it, synced, then renamed. */
export function createSessionFile(path: string, header: SessionHeader): void {
  const draft = `${path}.new`;
  const fd = openSync(draft, "wx");
  try {
    writeAll(fd, `${JSON.stringify(header)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(draft, path);
  syncFolder(dirname(path));
}

/** What a call names, on one line and cut short: the command a shell runs, or the path another tool reads or changes. */
function subjectOf(said: unknown): string {
  const { command, path } = typeof said === "object" && said !== null ? said as Record<string, unknown> : {};
  const subject = (typeof command === "string" ? command : typeof path === "string" ? path : "").replace(/\s+/gu, " ").trim();
  return subject.length > 80 ? `${subject.slice(0, 79)}…` : subject;
}

/** The calls Tesota's floor refused in run `run`, or in every run, from the session's permission entries and the calls they decided (#622). */
export function floorRefusals(entries: readonly SessionEntry[], run?: number): FloorRefusal[] {
  const calls = new Map(entries.flatMap((entry) => entry.type !== "assistant" ? []
    : entry.message.content.flatMap((part) => part.type === "toolCall" ? [[part.id, part] as const] : [])));
  return entries.flatMap((entry) => entry.type !== "permission" || entry.by !== "floor" || entry.decision !== "deny"
    || (run !== undefined && entry.run !== run) ? [] : [{ tool: calls.get(entry.callId)?.name ?? "a tool",
      subject: subjectOf(calls.get(entry.callId)?.arguments), reason: entry.reason }]);
}

/** What the operator sees of Tesota's floor at the end of the session's last request (`floorNotice`), its subagents' included. */
export function lastFloorNotice(entries: readonly SessionEntry[]): string | undefined {
  const run = entries.findLast((entry) => entry.type === "request")?.run;
  if (run === undefined) return undefined;
  const children = entries.reduce((count, entry) => {
    const refused = entry.type === "job_end" && entry.run === run && typeof entry.details === "object" && entry.details !== null
      ? (entry.details as Record<string, unknown>)["floorRefusals"] : undefined;
    return count + (typeof refused === "number" ? refused : 0);
  }, 0);
  return floorNotice(floorRefusals(entries, run), children);
}
