import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Base } from "./base.ts";
import type { PromptOptions, SessionOutcome } from "./contract.ts";

/**
 * Tesota's session format (#437): one JSON Lines file per session, written
 * by one writer and only appended to. Its first line is the header; the
 * rest are entries, in the order they happened. The request ledger is the
 * `request` and `amendment` entries: written, and synced, before the model
 * hears of them, and never rewritten.
 */
export const sessionFormat = "tesota-session";
export const sessionVersion = 1;

export interface SessionHeader {
  readonly type: "session";
  readonly format: typeof sessionFormat;
  readonly version: typeof sessionVersion;
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: string;
}

/** Where input came from, as Pi's input event says; an extension's text is never the operator's request. */
export type Origin = NonNullable<PromptOptions["source"]>;

/** Input that arrives while a run is going: a steer enters after the current calls, a follow-up when the run would end. */
export type Behavior = NonNullable<PromptOptions["streamingBehavior"]>;

/** How recovery repaired a call that has no result: it may have run, or it never started. */
export type Repair = "outcome_unknown" | "not_run";

export type SessionEntry =
  /** The operator's request, which starts run `run`, and the base it is measured against. */
  | { readonly type: "request"; readonly run: number; readonly text: string; readonly origin: Origin; readonly at: string;
    readonly base: Base }
  /** Input accepted while run `run` was going. */
  | { readonly type: "amendment"; readonly run: number; readonly id: number; readonly behavior: Behavior;
    readonly origin: Origin; readonly text: string; readonly at: string }
  /** An amendment entered the conversation. */
  | { readonly type: "delivered"; readonly run: number; readonly amendment: number }
  | { readonly type: "assistant"; readonly run: number; readonly message: AssistantMessage }
  /** A call is about to run; recorded, and synced, first. */
  | { readonly type: "call_intent"; readonly run: number; readonly callId: string }
  /** A call's result: the one the model saw, of a call that ran or was refused. */
  | { readonly type: "tool_result"; readonly run: number; readonly message: ToolResultMessage }
  /** Recovery's repair of call `callId` of reply `reply` (counted from 0 in its run), which has no result. */
  | { readonly type: "reconciliation"; readonly run: number; readonly reply: number; readonly callId: string;
    readonly toolName: string; readonly repair: Repair }
  | { readonly type: "run_end"; readonly run: number; readonly outcome: SessionOutcome };

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
const origins = new Set(["interactive", "rpc", "extension"]);

/** What each entry must hold besides its run, as far as reading it back depends on. */
const shapes: Record<SessionEntry["type"], (entry: Record<string, unknown>) => boolean> = {
  request: (entry) => isText(entry["text"]) && origins.has(entry["origin"] as string) && isText(entry["at"])
    && isObject(entry["base"]) && Array.isArray(entry["base"]["units"]),
  amendment: (entry) => isCount(entry["id"]) && (entry["behavior"] === "steer" || entry["behavior"] === "followUp")
    && origins.has(entry["origin"] as string) && isText(entry["text"]) && isText(entry["at"]),
  delivered: (entry) => isCount(entry["amendment"]),
  assistant: (entry) => isObject(entry["message"]) && entry["message"]["role"] === "assistant" && Array.isArray(entry["message"]["content"]),
  call_intent: (entry) => isText(entry["callId"]),
  tool_result: (entry) => isObject(entry["message"]) && entry["message"]["role"] === "toolResult",
  reconciliation: (entry) => Number.isInteger(entry["reply"]) && isText(entry["callId"]) && isText(entry["toolName"])
    && (entry["repair"] === "outcome_unknown" || entry["repair"] === "not_run"),
  run_end: (entry) => isText(entry["outcome"]),
};

/**
 * An entry read back, checked against what came before it: a request opens
 * the next run, and every other entry belongs to a run already opened.
 */
function entryAt(value: unknown, runs: number): SessionEntry | undefined {
  if (!isObject(value) || typeof value["type"] !== "string" || !(value["type"] in shapes)) return undefined;
  const type = value["type"] as SessionEntry["type"];
  const run = value["run"];
  const placed = type === "request" ? run === runs + 1 : isCount(run) && (run as number) <= runs;
  return placed && shapes[type](value) ? value as unknown as SessionEntry : undefined;
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
  const end = bytes.lastIndexOf(0x0a);
  const lines = end < 0 ? [] : bytes.subarray(0, end).toString("utf8").split("\n");
  const [first, ...rest] = lines;
  if (first === undefined) throw new SessionFileError(path, "has no session header.");
  const header = headerOf(parsed(first), path);
  const entries: SessionEntry[] = [];
  let runs = 0;
  /** Takes the line as the next entry, when it is one. */
  const take = (line: string): boolean => {
    const entry = entryAt(parsed(line), runs);
    if (entry === undefined) return false;
    if (entry.type === "request") runs = entry.run;
    entries.push(entry);
    return true;
  };
  for (const [index, line] of rest.entries()) {
    if (!take(line)) throw new SessionFileError(path, `has a broken entry on line ${index + 2}.`);
  }
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
