import type { ToolCall } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import type { Base } from "./base.ts";
import type { ExtensionAPI, Session } from "./contract.ts";
import { createLoop, type HistoryMessage, type LoopOptions, type LoopState, toolResult } from "./loop.ts";
import { notRun, outcomeUnknown, repairs } from "./reconcile-rule.ts";
import {
  type Behavior, createSessionFile, type Origin, readSessionFile, type Repair, type SessionEntry, sessionFormat, sessionVersion,
  sessionWriter, type SessionWriter,
} from "./session-file.ts";
import { lockSession } from "./session-lock.ts";

/** An amendment as the ledger keeps it; `delivered` once it entered the conversation. */
export interface LedgerAmendment {
  readonly id: number;
  readonly behavior: Behavior;
  readonly origin: Origin;
  readonly text: string;
  readonly at: string;
  readonly delivered: boolean;
}

/** A request as the ledger keeps it: exactly as it came, with its base and every amendment. */
export interface LedgerRequest {
  readonly run: number;
  readonly text: string;
  readonly origin: Origin;
  readonly at: string;
  readonly base: Base;
  readonly amendments: readonly LedgerAmendment[];
}

/** A session of the engine: the contract's, plus its file and its request ledger. */
export interface EngineSession extends Session {
  /** The session's file, to open it again. */
  readonly file: string;
  /** The requests, read from the session's ledger entries alone. */
  ledger(): readonly LedgerRequest[];
}

/**
 * What verifies a session's runs (#439): it registers like an extension,
 * and reads the running request from the ledger, so what it verifies is
 * what was recorded before any tool ran, not what it captured itself.
 */
export type Verifier = (pi: ExtensionAPI, request: () => LedgerRequest | undefined) => void;

export type SessionOptions = Omit<LoopOptions, "writer" | "resumed" | "verifier"> & {
  readonly verifier: Verifier;
  /** Where the session's file goes; `~/.tesota/sessions/<project>` when not given. */
  readonly folder?: string;
  /** Wraps the file's writer; tests use it to fail a write. */
  readonly writer?: (writer: SessionWriter) => SessionWriter;
};

export type OpenOptions = Omit<SessionOptions, "cwd" | "folder">;

/** The folder for the sessions of the project at `cwd`: its name, then a hash of its full path. */
export function sessionsFolder(cwd: string): string {
  const at = resolve(cwd);
  return join(tesotaHome(), "sessions", `${basename(at) || "root"}-${createHash("sha256").update(at).digest("hex").slice(0, 12)}`);
}

const lockOf = (file: string): string => file.replace(/\.jsonl$/u, ".lock");

/** What recovery tells the model about a call it repaired. */
const repairText: Record<Repair, string> = {
  outcome_unknown: "Outcome unknown: the session ended while this call was running. It may or may not have finished, "
    + "and anything it started may still be running. It was not run again.",
  not_run: "Not run: the session ended before this call started.",
};

/** One reply of a run, with what was recorded about each of its calls. */
interface Reply {
  readonly run: number;
  readonly index: number;
  readonly calls: readonly ToolCall[];
  readonly intended: Set<string>;
  readonly seen: Set<string>;
  readonly repaired: Set<string>;
}

/** The replies of every run, with their calls' intents, results and repairs. */
function repliesOf(entries: readonly SessionEntry[]): Reply[] {
  const replies: Reply[] = [];
  const counts = new Map<number, number>();
  const latest = new Map<number, Reply>();
  const byIndex = new Map<string, Reply>();
  for (const entry of entries) {
    if (entry.type === "assistant") {
      const index = counts.get(entry.run) ?? 0;
      counts.set(entry.run, index + 1);
      const reply: Reply = { run: entry.run, index, intended: new Set(), seen: new Set(), repaired: new Set(),
        calls: entry.message.content.filter((part): part is ToolCall => part.type === "toolCall") };
      replies.push(reply);
      latest.set(entry.run, reply);
      byIndex.set(`${entry.run}:${index}`, reply);
    } else if (entry.type === "call_intent") latest.get(entry.run)?.intended.add(entry.callId);
    else if (entry.type === "tool_result") latest.get(entry.run)?.seen.add(entry.message.toolCallId);
    else if (entry.type === "reconciliation") byIndex.get(`${entry.run}:${entry.reply}`)?.repaired.add(entry.callId);
  }
  return replies;
}

/**
 * The entries recovery adds to a session read back (#437): a repair for
 * each call with no result (`repairs`, proved), and the end of a run the
 * process never finished, as `interrupted`. Nothing is replayed, and a run
 * already ended or a call already answered gets nothing, so recovering
 * twice adds nothing the second time.
 */
export function recovery(entries: readonly SessionEntry[]): SessionEntry[] {
  const added: SessionEntry[] = [];
  for (const reply of repliesOf(entries)) {
    const kinds = repairs(reply.calls.map((call) => reply.seen.has(call.id)), reply.calls.map((call) => reply.intended.has(call.id)),
      reply.calls.map((call) => reply.repaired.has(call.id)));
    reply.calls.forEach((call, at) => {
      const kind = kinds[at];
      if (kind !== outcomeUnknown && kind !== notRun) return;
      added.push({ type: "reconciliation", run: reply.run, reply: reply.index, callId: call.id, toolName: call.name,
        repair: kind === outcomeUnknown ? "outcome_unknown" : "not_run" });
    });
  }
  const runs = entries.filter((entry) => entry.type === "request").length;
  if (runs > 0 && !entries.some((entry) => entry.type === "run_end" && entry.run === runs)) {
    added.push({ type: "run_end", run: runs, outcome: "interrupted" });
  }
  return added;
}

/**
 * The conversation the entries hold: requests and delivered amendments as
 * the operator's messages, replies, results, each repair as a failed
 * result placed after the other results of its reply, and the messages
 * settle handlers added; their data stays outside it.
 */
function conversation(entries: readonly SessionEntry[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  const amendments = new Map<number, string>();
  const repaired = new Map<string, HistoryMessage[]>();
  const counts = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type !== "reconciliation") continue;
    const key = `${entry.run}:${entry.reply}`;
    repaired.set(key, [...repaired.get(key) ?? [],
      toolResult({ id: entry.callId, name: entry.toolName }, { text: repairText[entry.repair], isError: true }, 0)]);
  }
  /** Each reply's repairs follow its last result, which is where the next reply or run starts. */
  let pending: HistoryMessage[] = [];
  const flush = () => { history.push(...pending); pending = []; };
  for (const entry of entries) {
    if (entry.type === "request") { flush(); history.push({ role: "user", content: entry.text, timestamp: Date.parse(entry.at) }); }
    else if (entry.type === "amendment") amendments.set(entry.id, entry.text);
    else if (entry.type === "delivered") { flush(); history.push({ role: "user", content: amendments.get(entry.amendment) ?? "", timestamp: 0 }); }
    else if (entry.type === "assistant") {
      flush();
      const index = counts.get(entry.run) ?? 0;
      counts.set(entry.run, index + 1);
      history.push(entry.message);
      pending = repaired.get(`${entry.run}:${index}`) ?? [];
    } else if (entry.type === "tool_result") history.push(entry.message);
    else if (entry.type === "custom_message") {
      flush();
      const { customType, content, display, details } = entry;
      history.push({ role: "custom", customType, content, display, ...details === undefined ? {} : { details }, timestamp: 0 });
    }
  }
  flush();
  return history;
}

/** The ledger: each request with its amendments, from the ledger entries and the deliveries alone. */
function ledgerOf(entries: readonly SessionEntry[]): LedgerRequest[] {
  const delivered = new Set(entries.flatMap((entry) => entry.type === "delivered" ? [entry.amendment] : []));
  return entries.flatMap((entry) => entry.type !== "request" ? [] : [{
    run: entry.run, text: entry.text, origin: entry.origin, at: entry.at, base: entry.base,
    amendments: entries.flatMap((amendment) => amendment.type !== "amendment" || amendment.run !== entry.run ? [] : [{
      id: amendment.id, behavior: amendment.behavior, origin: amendment.origin, text: amendment.text, at: amendment.at,
      delivered: delivered.has(amendment.id),
    }]),
  }]);
}

/** Where a session read back stands. */
function stateOf(entries: readonly SessionEntry[]): LoopState {
  const tokens = { input: 0, output: 0, total: 0 };
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    tokens.input += entry.message.usage.input;
    tokens.output += entry.message.usage.output;
    tokens.total += entry.message.usage.totalTokens;
  }
  const ends = entries.flatMap((entry) => entry.type === "run_end" ? [entry.outcome] : []);
  return {
    history: conversation(entries), tokens, outcome: ends.at(-1),
    runs: entries.filter((entry) => entry.type === "request").length,
    amendments: entries.filter((entry) => entry.type === "amendment").length,
  };
}

/**
 * The loop over a session file whose lock is held, keeping its entries for
 * the ledger; the lock goes when it is disposed. A session opened again
 * resumes from its entries; a new one starts empty.
 */
function engineSession(file: string, release: () => void, entries: SessionEntry[], options: OpenOptions & { readonly cwd: string },
  opened: boolean): EngineSession {
  const written = sessionWriter(file);
  const recording: SessionWriter = {
    append: (entry) => { written.append(entry); entries.push(entry); },
    sync: () => { written.sync(); },
    close: () => { written.close(); },
  };
  const request = (): LedgerRequest | undefined => ledgerOf(entries).at(-1);
  let loop: Session;
  try {
    loop = createLoop({ ...options, verifier: (pi) => { options.verifier(pi, request); },
      writer: options.writer?.(recording) ?? recording, ...opened ? { resumed: stateOf(entries) } : {} });
  } catch (error) {
    // An extension or the verifier that throws as it registers leaves nothing open.
    written.close();
    throw error;
  }
  let disposed: Promise<void> | undefined;
  return {
    ...loop,
    file,
    ledger: () => ledgerOf(entries),
    dispose: () => disposed ??= loop.dispose().finally(release),
  };
}

/** A new session in `options.cwd`, its file created with its header and locked by this writer. */
export function createSession(options: SessionOptions): EngineSession {
  const folder = options.folder ?? sessionsFolder(options.cwd);
  mkdirSync(folder, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const file = join(folder, `${id}.jsonl`);
  const lock = lockSession(lockOf(file));
  try {
    createSessionFile(file, { type: "session", format: sessionFormat, version: sessionVersion, id, cwd: resolve(options.cwd), createdAt });
    return engineSession(file, () => { lock.release(); }, [], options, false);
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * The session in `file`, resumed by this writer: its lock is taken first,
 * then the file is read (`readSessionFile`) and recovered (`recovery`),
 * and the repairs are synced before anything runs.
 */
export function openSession(file: string, options: OpenOptions): EngineSession {
  const lock = lockSession(lockOf(file));
  try {
    const { header, entries } = readSessionFile(file);
    const added = recovery(entries);
    if (added.length > 0) {
      const writer = sessionWriter(file);
      try {
        for (const entry of added) writer.append(entry);
        writer.sync();
      } finally {
        writer.close();
      }
    }
    return engineSession(file, () => { lock.release(); }, [...entries, ...added], { ...options, cwd: header.cwd }, true);
  } catch (error) {
    lock.release();
    throw error;
  }
}

