import type { ToolCall } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import type { Base } from "./base.ts";
import type { ExtensionAPI } from "../../../src/contract.ts";
import { branchOf } from "./branch.ts";
import { compactedHead, createLoop, type HistoryMessage, type LoopOptions, type LoopSession, type LoopState, toolResult } from "./loop.ts";
import { noEffect, notRun, outcomeUnknown, repairs } from "./reconcile-rule.ts";
import {
  type Behavior, createSessionFile, type Origin, readSessionFile, type Repair, type SessionEntry, sessionFormat, sessionVersion,
  sessionWriter, type SessionWriter,
} from "./session-file.ts";
import { lockSession } from "./session-lock.ts";
import { outputPrefix } from "./tools/shell.ts";
import { keepTail, maxBytes } from "./truncate.ts";
import { bindWorkspace, reopenWorkspace, type Workspace } from "./workspace.ts";
import { clarificationText, type Clarification, type RequestInput } from "../../../src/clarification.ts";

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
  /** Every accepted request input in the order it entered the durable journal. */
  readonly inputs: readonly RequestInput[];
}

/** A session of the engine: the contract's, plus its file and its request ledger. */
export interface EngineSession extends LoopSession {
  /** The session's file, to open it again. */
  readonly file: string;
  /** The requests, read from the session's ledger entries alone. */
  ledger(): readonly LedgerRequest[];
  /** Where the session works (#453): its checkout, or a worktree of it. */
  readonly workspace: Pick<Workspace, "cwd" | "checkout" | "worktree" | "branch">;
  /** Once disposed, where its kept work is, when its worktree changed and so stays. */
  kept(): string | undefined;
}

/**
 * What verifies a session's runs (#439): it registers like an extension,
 * and reads the running request from the ledger, so what it verifies is
 * what was recorded before any tool ran, not what it captured itself.
 */
export type Verifier = (pi: ExtensionAPI, request: () => LedgerRequest | undefined) => void;

export type SessionOptions = Omit<LoopOptions, "writer" | "resumed" | "verifier" | "branch" | "outputFolder"> & {
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
const outputOf = (file: string): string => file.replace(/\.jsonl$/u, ".output");

/** What recovery tells the model about a call it repaired. */
export const repairText: Record<Repair, string> = {
  outcome_unknown: "Outcome unknown: the session ended while this call was running. It may or may not have finished, "
    + "and anything it started may still be running. It was not run again.",
  not_run: "Not run: the session ended before this call started.",
  no_effect: "Interrupted: the session ended while this call was running. It only reads, so it changed nothing. "
    + "It was not run again; run it again if you need its result.",
};

/** The repair's text in both the conversation and the extension's branch. */
export function reconciliationText(entry: Extract<SessionEntry, { readonly type: "reconciliation" }>): string {
  const text = repairText[entry.repair];
  if (entry.output === undefined || entry.path === undefined) return text;
  const kept = keepTail(entry.output === "" ? [] : entry.output.split("\n"));
  return `${text}\n\nWhat it printed before the session ended (the last ${kept.lines} lines; full output: ${entry.path}):\n${kept.text}`;
}

/** Reads only the end of a call's file, dropping the first partial line when cut. */
function interruptedOutput(folder: string, callId: string): { output: string; path: string } | undefined {
  if (!existsSync(folder)) return undefined;
  const prefix = outputPrefix(callId);
  const latest = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => {
      const path = join(folder, entry.name);
      return { path, modified: statSync(path).mtimeMs };
    }).sort((a, b) => b.modified - a.modified)[0];
  if (latest === undefined) return undefined;
  const { path } = latest;
  const file = openSync(path, "r");
  try {
    const size = fstatSync(file).size;
    if (size === 0) return undefined;
    const start = Math.max(0, size - 2 * maxBytes);
    const bytes = Buffer.alloc(size - start);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(file, bytes, read, bytes.length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    const lines = bytes.subarray(0, read).toString("utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return { output: keepTail(start > 0 && lines.length > 1 ? lines.slice(1) : lines).text, path };
  } finally {
    closeSync(file);
  }
}

/** One reply of a run, with what was recorded about each of its calls. */
interface Reply {
  readonly run: number;
  readonly index: number;
  readonly calls: readonly ToolCall[];
  readonly intended: Map<string, "read" | "write" | "run">;
  readonly seen: Set<string>;
  readonly repaired: Set<string>;
  readonly clarifications: Map<string, Clarification>;
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
      const reply: Reply = { run: entry.run, index, intended: new Map(), seen: new Set(), repaired: new Set(), clarifications: new Map(),
        calls: entry.message.content.filter((part): part is ToolCall => part.type === "toolCall") };
      replies.push(reply);
      latest.set(entry.run, reply);
      byIndex.set(`${entry.run}:${index}`, reply);
    } else if (entry.type === "call_intent") latest.get(entry.run)?.intended.set(entry.callId, entry.access);
    else if (entry.type === "tool_result") latest.get(entry.run)?.seen.add(entry.message.toolCallId);
    else if (entry.type === "clarification") byIndex.get(`${entry.run}:${entry.clarification.reply}`)?.clarifications.set(entry.clarification.callId,
      entry.clarification);
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
export function recovery(entries: readonly SessionEntry[], output: (callId: string) => { output: string; path: string } | undefined): SessionEntry[] {
  const added: SessionEntry[] = [];
  for (const reply of repliesOf(entries)) {
    for (const call of reply.calls) {
      const clarification = reply.clarifications.get(call.id);
      if (clarification === undefined || call.name !== "ask_user" || reply.seen.has(call.id)) continue;
      added.push({ type: "tool_result", run: reply.run, message: toolResult(call,
        { text: clarificationText(clarification), isError: false }) });
      reply.seen.add(call.id);
    }
    const kinds = repairs(reply.calls.map((call) => reply.seen.has(call.id)), reply.calls.map((call) => reply.intended.has(call.id)),
      reply.calls.map((call) => reply.repaired.has(call.id)), reply.calls.map((call) => reply.intended.get(call.id) === "read"));
    reply.calls.forEach((call, at) => {
      const kind = kinds[at];
      if (kind !== outcomeUnknown && kind !== notRun && kind !== noEffect) return;
      added.push({ type: "reconciliation", run: reply.run, reply: reply.index, callId: call.id, toolName: call.name,
        repair: kind === noEffect ? "no_effect" : kind === outcomeUnknown ? "outcome_unknown" : "not_run",
        ...kind === outcomeUnknown ? output(call.id) : {} });
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
 * settle handlers added; their data stays outside it. A compaction replaces
 * what came before its kept messages, as the loop did (#451); with the
 * conversation come the last run's request and amendments, and the last
 * compaction.
 */
function conversation(entries: readonly SessionEntry[]): Pick<LoopState, "history" | "ledger" | "compacted"> {
  const history: HistoryMessage[] = [];
  let ledger: HistoryMessage[] = [];
  let compacted: LoopState["compacted"];
  const amendments = new Map<number, { readonly text: string; readonly order: number }>();
  /** Where each of the ledger's messages came among the request's input, as the loop keeps it. */
  const inputOrder = new Map<HistoryMessage, number>();
  /** Each submitted answer's place in the input, by its run and call, until that call's result carries it. */
  const answered = new Map<string, number>();
  const toLedger = (message: HistoryMessage, order: number): void => {
    ledger.push(message);
    inputOrder.set(message, order);
    ledger.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
  };
  const deliver = (entry: Extract<SessionEntry, { readonly type: "delivered" }>, order: number): void => {
    const amendment = amendments.get(entry.amendment);
    const delivered: HistoryMessage = { role: "user", content: amendment?.text ?? "", timestamp: 0 };
    toLedger(delivered, amendment?.order ?? order);
    history.push(delivered);
  };
  /** A call's result; a submitted answer entered the conversation once, in it, and the ledger keeps that message. */
  const result = (entry: Extract<SessionEntry, { readonly type: "tool_result" }>): void => {
    history.push(entry.message);
    const key = `${entry.run}:${entry.message.toolCallId}`;
    const answer = answered.get(key);
    if (answer !== undefined) { answered.delete(key); toLedger(entry.message, answer); }
  };
  /** Each reply by its run and its place in the run, so a repair written later finds it. */
  const replies = new Map<string, HistoryMessage>();
  const counts = new Map<number, number>();
  for (const [order, entry] of entries.entries()) {
    if (entry.type === "request") {
      const asked: HistoryMessage = { role: "user", content: entry.text, timestamp: Date.parse(entry.at) };
      ledger = [asked];
      inputOrder.set(asked, order);
      history.push(asked);
    } else if (entry.type === "amendment") amendments.set(entry.id, { text: entry.text, order });
    else if (entry.type === "delivered") deliver(entry, order);
    else if (entry.type === "clarification") answered.set(`${entry.run}:${entry.clarification.callId}`, order);
    else if (entry.type === "reconciliation") {
      // A repair goes after the other results of its reply, in the order repairs were written: a compaction
      // written before it kept what the session held then, and a reply it summarized takes its repair with it.
      const reply = replies.get(`${entry.run}:${entry.reply}`);
      const at = reply === undefined ? -1 : history.indexOf(reply);
      if (at < 0) continue;
      let after = at + 1;
      while (history[after]?.role === "toolResult") after += 1;
      history.splice(after, 0,
        toolResult({ id: entry.callId, name: entry.toolName }, { text: reconciliationText(entry), isError: true }, 0));
    } else if (entry.type === "compaction") {
      const files = { read: entry.read, changed: entry.changed };
      const cut = Math.max(0, history.length - entry.kept);
      history.splice(0, cut, compactedHead(ledger, entry.summary, files, history.slice(cut)));
      compacted = { summary: entry.summary, files, counted: history.length };
    } else if (entry.type === "assistant") {
      const index = counts.get(entry.run) ?? 0;
      counts.set(entry.run, index + 1);
      replies.set(`${entry.run}:${index}`, entry.message);
      history.push(entry.message);
    } else if (entry.type === "tool_result") result(entry);
    else if (entry.type === "custom_message") {
      const { customType, content, display, details } = entry;
      history.push({ role: "custom", customType, content, display, ...details === undefined ? {} : { details }, timestamp: 0 });
    }
  }
  return { history, ledger, ...compacted === undefined ? {} : { compacted } };
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
    inputs: entries.flatMap((input): RequestInput[] => (input.type === "active_tools" || input.run !== entry.run) ? []
      : input.type === "amendment" ? [{ kind: "amendment", origin: input.origin, text: input.text }]
        : input.type === "clarification" ? [{ kind: "clarification", clarification: input.clarification }] : []),
  }]);
}

/** Where a session read back stands. */
function stateOf(entries: readonly SessionEntry[]): LoopState {
  const tokens = { input: 0, output: 0, total: 0 };
  for (const entry of entries) {
    if (entry.type === "summary_usage") {
      tokens.input += entry.input;
      tokens.output += entry.output;
      tokens.total += entry.total;
    }
    if (entry.type !== "assistant") continue;
    tokens.input += entry.message.usage.input;
    tokens.output += entry.message.usage.output;
    tokens.total += entry.message.usage.totalTokens;
  }
  const ends = entries.flatMap((entry) => entry.type === "run_end" ? [entry.outcome] : []);
  const tools = entries.findLast((entry) => entry.type === "active_tools");
  return {
    ...tools === undefined ? {} : { activeTools: tools.names },
    ...conversation(entries), tokens, outcome: ends.at(-1),
    runs: entries.filter((entry) => entry.type === "request").length,
    amendments: entries.filter((entry) => entry.type === "amendment").length,
  };
}

/**
 * The loop over a session file whose lock is held, keeping its entries for
 * the ledger; the lock goes when it is disposed. A session opened again
 * resumes from its entries; a new one starts empty.
 */
function engineSession(file: string, release: () => void, entries: SessionEntry[], options: OpenOptions, workspace: Workspace,
  opened: boolean): EngineSession {
  const written = sessionWriter(file);
  const staged: SessionEntry[] = [];
  let poisoned: Error | undefined;
  const fail = (error: unknown): never => {
    poisoned ??= error instanceof Error ? error : new Error(String(error));
    throw poisoned;
  };
  const recording: SessionWriter = {
    append: (entry) => {
      if (poisoned !== undefined) throw poisoned;
      try { written.append(entry); staged.push(entry); } catch (error) { return fail(error); }
    },
    sync: () => {
      if (poisoned !== undefined) throw poisoned;
      try { written.sync(); entries.push(...staged.splice(0)); } catch (error) { return fail(error); }
    },
    close: () => { written.close(); },
  };
  const request = (): LedgerRequest | undefined => ledgerOf(entries).at(-1);
  let loop: LoopSession;
  try {
    loop = createLoop({ ...options, cwd: workspace.cwd, sessionId: basename(file, ".jsonl"), verifier: (pi) => { options.verifier(pi, request); }, branch: () => branchOf(entries),
      writer: options.writer?.(recording) ?? recording, outputFolder: outputOf(file), ...opened ? { resumed: stateOf(entries) } : {} });
  } catch (error) {
    // An extension or the verifier that throws as it registers leaves nothing open.
    written.close();
    throw error;
  }
  let disposed: Promise<void> | undefined;
  let kept: string | undefined;
  const { cwd, checkout, worktree, branch } = workspace;
  return {
    ...loop,
    file,
    ledger: () => ledgerOf(entries),
    workspace: { cwd, checkout, ...worktree === undefined ? {} : { worktree }, ...branch === undefined ? {} : { branch } },
    kept: () => kept,
    prompt: async (text, prompt) => {
      if (poisoned !== undefined) throw poisoned;
      return await loop.prompt(text, prompt);
    },
    compact: async () => {
      if (poisoned !== undefined) throw poisoned;
      return await loop.compact();
    },
    dispose: () => disposed ??= loop.dispose().finally(() => {
      release();
      kept = workspace.release();
    }),
  };
}

/**
 * A new session opened in `options.cwd`, bound to its workspace (#453),
 * its file created with its header and locked by this writer. Its sessions
 * folder is the checkout's, whichever workspace it works in.
 */
export function createSession(options: SessionOptions): EngineSession {
  const folder = options.folder ?? sessionsFolder(options.cwd);
  mkdirSync(folder, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const file = join(folder, `${id}.jsonl`);
  const lock = lockSession(lockOf(file));
  let workspace: Workspace | undefined;
  try {
    workspace = bindWorkspace(options.cwd, id);
    const { cwd, checkout, worktree, branch, base } = workspace;
    createSessionFile(file, { type: "session", format: sessionFormat, version: sessionVersion, id, cwd, createdAt, checkout,
      ...worktree === undefined ? {} : { worktree }, ...branch === undefined ? {} : { branch }, ...base === undefined ? {} : { base } });
    return engineSession(file, () => { lock.release(); }, [], options, workspace, false);
  } catch (error) {
    workspace?.release();
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
  let workspace: Workspace | undefined;
  try {
    const { header, entries } = readSessionFile(file);
    workspace = reopenWorkspace({ cwd: header.cwd, checkout: header.checkout ?? header.cwd,
      ...header.worktree === undefined ? {} : { worktree: header.worktree }, ...header.branch === undefined ? {} : { branch: header.branch },
      ...header.base === undefined ? {} : { base: header.base } });
    const added = recovery(entries, (callId) => interruptedOutput(outputOf(file), callId));
    if (added.length > 0) {
      const writer = sessionWriter(file);
      try {
        for (const entry of added) writer.append(entry);
        writer.sync();
      } finally {
        writer.close();
      }
    }
    return engineSession(file, () => { lock.release(); }, [...entries, ...added], options, workspace, true);
  } catch (error) {
    workspace?.release();
    lock.release();
    throw error;
  }
}

