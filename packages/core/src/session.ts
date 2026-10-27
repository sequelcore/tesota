import type { ToolCall } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { entryReceipt, type FloorRefusal, interruptedReceipt, isReceipt, type ReceiptChild, receiptEntry } from "../../../src/receipt.ts";
import { toolMayChangeFiles } from "../../../src/verification/gate-rule.ts";
import manifest from "../package.json" with { type: "json" };
import type { Base } from "./base.ts";
import type { ExtensionAPI } from "../../../src/contract.ts";
import { type AgentType, agentTypes } from "./agents.ts";
import { branchOf } from "./branch.ts";
import { agentHost, type AgentTree, defaultAgentLimit, maxDepth } from "./children.ts";
import type { GuardSetting } from "./agent-rule.ts";
import { providerRetryTokens, providerRetryType } from "./provider-retry.ts";
import type { StartedSkill } from "./instructions.ts";
import {
  compactedHead, type Continuation, continuesType, createLoop, type HistoryMessage, jobMessage, type LoopOptions, type LoopSession, type LoopState, skillMessage,
  toolResult,
} from "./loop.ts";
import { agentTool } from "./tools/agent.ts";
import { noEffect, notRun, outcomeUnknown, repairs } from "./reconcile-rule.ts";
import {
  type Behavior, createSessionFile, floorRefusals, type Origin, readSessionFile, type Repair, type SessionEntry, sessionFormat, sessionVersion,
  type SessionHeader, sessionWriter, type SessionWriter,
} from "./session-file.ts";
import { lockSession, SessionLockedError } from "./session-lock.ts";
import { unverifiedFrom } from "../../../src/verification/request-context-rule.js";
import { outputPrefix } from "./tools/shell.ts";
import { keepTail, maxBytes } from "./truncate.ts";
import { bindWorkspace, outsideChange, reopenWorkspace, type Workspace } from "./workspace.ts";
import { clarificationText, type Clarification, type ClarificationQuestion, type RequestInput } from "../../../src/clarification.ts";
import { validateQuestions } from "./questions-schema.ts";

/** An amendment as the ledger keeps it; `delivered` once it entered the conversation. */
export interface LedgerAmendment {
  readonly id: number;
  readonly behavior: Behavior;
  readonly origin: Origin;
  readonly text: string;
  readonly at: string;
  readonly delivered: boolean;
  readonly withdrawn: boolean;
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
  /** The subagents the run started and how each ended (#525), in the order they ended. */
  readonly children: readonly ReceiptChild[];
  /** The calls Tesota's floor refused in the run (#622), in order. */
  readonly refusals: readonly FloorRefusal[];
  /**
   * The earlier run this one continues (#651), and what the verifier saved as
   * that run ended on its question (`requestStartType`), for it to restore.
   */
  readonly continues?: { readonly run: number; readonly start?: unknown };
  /**
   * The earlier requests whose changes were never verified, that this one
   * follows (#627, `unverifiedFrom`), oldest
   * first, without one a later of them, or this one, continues (#651), whose
   * text and inputs it already holds.
   */
  readonly unverifiedRequests: readonly Pick<LedgerRequest, "run" | "text" | "inputs">[];
}

/** What makes a session a child of another (#525): its parent, where it works, the tree it counts in, its types and instructions. */
export interface ChildSession {
  readonly parent: NonNullable<SessionHeader["parent"]>;
  readonly bind: (id: string) => Workspace;
  readonly tree: AgentTree;
  readonly types: readonly AgentType[];
  /** Its instructions, in the folder it works in, on its branch when it has one. */
  readonly instructions: (cwd: string, branch: string | undefined) => string;
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
  /** The agent types its subagents start with (#525). */
  readonly types: readonly AgentType[];
  /** Its scratch folder (#653), removed when it is disposed; none when that place could enter its change. */
  readonly scratch: string | undefined;
  /**
   * The operator's reply to where the session stands (#651): when its last
   * run ended on an unresolved question, the answer to it, which starts a run
   * that continues that request (`continuation`); otherwise a follow-up, a
   * new request as the shell sends one.
   */
  reply(text: string): Promise<void>;
}

/**
 * What verifies a session's runs (#439): it registers like an extension,
 * and reads the running request from the ledger, so what it verifies is
 * what was recorded before any tool ran, not what it captured itself.
 */
export type Verifier = (pi: ExtensionAPI, request: () => LedgerRequest | undefined) => void;

export type SessionOptions = Omit<LoopOptions, "writer" | "resumed" | "verifier" | "branch" | "outputFolder" | "scratch"> & {
  readonly verifier: Verifier;
  /** Where the session's file goes; `~/.tesota/sessions/<project>` when not given. */
  readonly folder?: string;
  /** Wraps the file's writer; tests use it to fail a write. */
  readonly writer?: (writer: SessionWriter) => SessionWriter;
  /** How many subagents may run at once across the session's tree (#525); 4 when not given. */
  readonly agentLimit?: number;
  /** Whether a writing subagent's branch is guarded by Git (#619): required, warned about when this Git can't, or off. */
  readonly branchGuard?: GuardSetting;
  /** Given when the session is another's subagent (#525). */
  readonly child?: ChildSession;
};

export type OpenOptions = Omit<SessionOptions, "cwd" | "folder">;

/** The folder for the sessions of the project at `cwd`: its name, then a hash of its full path. */
export function sessionsFolder(cwd: string): string {
  const at = resolve(cwd);
  return join(tesotaHome(), "sessions", `${basename(at) || "root"}-${createHash("sha256").update(at).digest("hex").slice(0, 12)}`);
}

const lockOf = (file: string): string => file.replace(/\.jsonl$/u, ".lock");
const outputOf = (file: string): string => file.replace(/\.jsonl$/u, ".output");

/**
 * The scratch folder of the session in `file`, working in `cwd` (#653),
 * made as it opens: beside its file, so a subagent, a session of its own,
 * gets its own. A sessions folder is under Tesota's home, outside the
 * project and never the system's shared temporary folder; one inside the
 * repository's tree is used only when Git ignores it, so nothing in it
 * enters the change. None otherwise.
 */
function scratchOf(file: string, cwd: string): string | undefined {
  // Made first, so that Git matches a pattern for folders against it, and named by its real name once, so a link put
  // in its place later moves nothing the floor allows.
  mkdirSync(file.replace(/\.jsonl$/u, ".scratch"), { recursive: true });
  const scratch = realpathSync.native(file.replace(/\.jsonl$/u, ".scratch"));
  if (outsideChange(scratch, cwd)) return scratch;
  removeScratch(scratch);
  return undefined;
}

/** Removes a scratch folder; one a process still holds stays, and holds nothing of the change. */
function removeScratch(scratch: string | undefined): void {
  if (scratch === undefined) return;
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* what a process still holds stays, outside the change */ }
}

/** What recovery tells the model about a job the session was running when it ended (#525). */
const unknownJobText = (description: string, session: string): string => `Outcome unknown: the session ended while subagent `
  + `"${description}" ran. Its own session, ${session}, ended with it, and it was not run again. Anything it wrote stays in its `
  + "own worktree.";

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
  // A job the session was running when it ended (#525) ends "outcome unknown", like a call; nothing runs it again.
  const jobsEnded = new Set(entries.flatMap((entry) => entry.type === "job_end" ? [entry.job] : []));
  for (const entry of entries) {
    if (entry.type !== "job_start" || jobsEnded.has(entry.job)) continue;
    added.push({ type: "job_end", run: entry.run, job: entry.job, outcome: "unknown", text: unknownJobText(entry.description, entry.session),
      ...typeof entry.details === "object" && entry.details !== null ? { details: { ...entry.details, outcome: "unknown" } } : {} });
  }
  const runs = entries.filter((entry) => entry.type === "request").length;
  if (runs > 0 && !entries.some((entry) => entry.type === "run_end" && entry.run === runs)) {
    const unsettled = unsettledReceipt(entries, runs);
    if (unsettled !== undefined) added.push(unsettled);
    added.push({ type: "run_end", run: runs, outcome: "interrupted" });
  }
  return added;
}

/**
 * The receipt of run `run`, which the process left without one (#599): once
 * a call that may change files was about to run, as the gate decides it
 * (`toolMayChangeFiles`), a receipt that says nothing verified it and what
 * changed is unknown, since no inventory was saved. A call an older file
 * recorded without its tool may have. Nothing when the run settled with a
 * receipt, or every call it started only read.
 */
function unsettledReceipt(entries: readonly SessionEntry[], run: number): SessionEntry | undefined {
  const mine = entries.filter((entry) => "run" in entry && entry.run === run);
  const request = ledgerOf(entries).find((entry) => entry.run === run);
  if (request === undefined || !mine.some((entry) => entry.type === "call_intent"
    && (entry.tool === undefined || toolMayChangeFiles(entry.tool.name, entry.tool.nativeQuestion, entry.tool.readOnly)))
    || mine.some((entry) => (entry.type === "custom" || entry.type === "custom_message") && entry.customType === "tesota-receipt")) {
    return undefined;
  }
  const units = request.base.units;
  const only = units.length === 1 && units[0]?.folder === "" ? units[0] : undefined;
  const clarifications = request.inputs.flatMap((input) => input.kind === "clarification" ? [input.clarification] : []);
  const receipt = interruptedReceipt({ repository: units.some(({ kind }) => kind === "commit"),
    base: only === undefined || only.kind === "refused" ? null : only.commit, startedAt: request.at, settledAt: new Date().toISOString(),
    engine: manifest.version, ...clarifications.length === 0 ? {} : { clarifications },
    ...request.children.length === 0 ? {} : { children: request.children },
    ...request.refusals.length === 0 ? {} : { floorRefusals: request.refusals } });
  return { run, ...receiptEntry(undefined, receipt) };
}

/**
 * The conversation the entries hold: requests and delivered amendments as
 * the operator's messages, each followed by the skill it started (#540),
 * replies, results, each repair as a failed result placed after
 * the other results of its reply, and the messages settle handlers added;
 * their data stays outside it. A compaction replaces
 * what came before its kept messages, as the loop did (#451); with the
 * conversation come the last run's request and amendments, and the last
 * compaction.
 */
function conversation(entries: readonly SessionEntry[]): Pick<LoopState, "history" | "ledger" | "compacted"> {
  const history: HistoryMessage[] = [];
  let ledger: HistoryMessage[] = [];
  let compacted: LoopState["compacted"];
  const amendments = new Map<number, { readonly text: string; readonly order: number; readonly skill: StartedSkill | undefined }>();
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
    if (amendment?.skill === undefined) return;
    const instructed = skillMessage(amendment.skill, 0);
    toLedger(instructed, amendment.order);
    history.push(instructed);
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
  /** Whether each job ran in the background, by its id. */
  const background = new Map<string, boolean>();
  /**
   * A repair goes after the other results of its reply, in the order repairs were written: a compaction
   * written before it kept what the session held then, and a reply it summarized takes its repair with it.
   */
  const repair = (entry: Extract<SessionEntry, { readonly type: "reconciliation" }>): void => {
    const reply = replies.get(`${entry.run}:${entry.reply}`);
    const at = reply === undefined ? -1 : history.indexOf(reply);
    if (at < 0) return;
    let after = at + 1;
    while (history[after]?.role === "toolResult") after += 1;
    history.splice(after, 0,
      toolResult({ id: entry.callId, name: entry.toolName }, { text: reconciliationText(entry), isError: true }, 0));
  };
  const counts = new Map<number, number>();
  for (const [order, entry] of entries.entries()) {
    if (entry.type === "request") {
      const asked: HistoryMessage = { role: "user", content: entry.text, timestamp: Date.parse(entry.at) };
      ledger = entry.skill === undefined ? [asked] : [asked, skillMessage(entry.skill, Date.parse(entry.at))];
      for (const message of ledger) {
        inputOrder.set(message, order);
        history.push(message);
      }
    } else if (entry.type === "amendment") amendments.set(entry.id, { text: entry.text, order, skill: entry.skill });
    else if (entry.type === "delivered") deliver(entry, order);
    else if (entry.type === "clarification") answered.set(`${entry.run}:${entry.clarification.callId}`, order);
    else if (entry.type === "reconciliation") repair(entry);
    else if (entry.type === "compaction") {
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
    else if (entry.type === "job_start") background.set(entry.job, entry.background);
    // A background job's end entered the conversation as the run took it in; a waited one's is its call's result (#525).
    else if (entry.type === "job_end") { if (background.get(entry.job) === true) history.push(jobMessage(entry.text, entry.details, 0)); }
    else if (entry.type === "custom_message") {
      const { customType, content, display, details } = entry;
      history.push({ role: "custom", customType, content, display, ...details === undefined ? {} : { details }, timestamp: 0 });
    }
  }
  return { history, ledger, ...compacted === undefined ? {} : { compacted } };
}

/**
 * The ledger: each request with its amendments, from the ledger entries and
 * the deliveries alone. A request that continues an earlier one (#651) holds
 * that one's amendments and clarifications first, since it is the same
 * request, then its own. Each holds the earlier requests it is judged with
 * (#627): those since the last request with a non-stopped receipt.
 */
function ledgerOf(entries: readonly SessionEntry[]): LedgerRequest[] {
  const ledger = ownLedgerOf(entries);
  const inputs = new Map<number, readonly RequestInput[]>();
  // A completed answer without a receipt verified no changes. A stopped receipt is only an inventory.
  const verified = verifiedRequests(entries);
  const merged: LedgerRequest[] = [];
  for (const request of ledger) {
    const all = [...request.continues === undefined ? [] : inputs.get(request.continues.run) ?? [], ...request.inputs];
    inputs.set(request.run, all);
    const earlier = merged.slice(unverifiedFrom(merged.map(({ run }) => verified.has(run))));
    const continued = new Set([...earlier, request].flatMap(({ continues }) => continues === undefined ? [] : [continues.run]));
    merged.push({ ...request, inputs: all, unverifiedRequests: earlier.filter(({ run }) => !continued.has(run))
      .map(({ run, text, inputs: given }) => ({ run, text, inputs: given })) });
  }
  return merged;
}

/** A receipt is a verification boundary only once its verifier settled successfully; an inventory is not verification. */
function verifiedRequests(entries: readonly SessionEntry[]): ReadonlySet<number> {
  const receipts = new Map<number, boolean>();
  const verified = new Set<number>();
  for (const [index, entry] of entries.entries()) {
    const receipt = entryReceipt(entry);
    if ("run" in entry && isReceipt(receipt)) receipts.set(entry.run, receipt.stopped === undefined);
    if (entry.type !== "run_end" || (entry.outcome !== "completed" && entry.outcome !== "incomplete")) continue;
    const last = entries[index - 1];
    if (last?.type === "settled" && last.run === entry.run && last.phase === "verifier"
      && last.registered && !last.continued && last.errors.length === 0 && receipts.get(entry.run) === true) verified.add(entry.run);
  }
  return verified;
}

/** Each request with only the amendments and clarifications given in its own run. */
function ownLedgerOf(entries: readonly SessionEntry[]): Omit<LedgerRequest, "unverifiedRequests">[] {
  const withdrawn = new Set(entries.flatMap((entry) => entry.type === "withdrawn" ? [entry.amendment] : []));
  const delivered = new Set(entries.flatMap((entry) => entry.type === "delivered" ? [entry.amendment] : []));
  return entries.flatMap((entry) => entry.type !== "request" ? [] : [{
    run: entry.run, text: entry.text, origin: entry.origin, at: entry.at, base: entry.base,
    amendments: entries.flatMap((amendment) => amendment.type !== "amendment" || amendment.run !== entry.run ? [] : [{
      id: amendment.id, behavior: amendment.behavior, origin: amendment.origin, text: amendment.text, at: amendment.at,
      delivered: delivered.has(amendment.id), withdrawn: withdrawn.has(amendment.id),
    }]),
    inputs: entries.flatMap((input): RequestInput[] => (input.type === "active_tools" || input.run !== entry.run) ? []
      : input.type === "amendment" ? withdrawn.has(input.id) ? [] : [{ kind: "amendment", origin: input.origin, text: input.text }]
        : input.type === "clarification" ? [{ kind: "clarification", clarification: input.clarification }]
          : input.type === "custom" ? continuedFrom(input).map(({ clarification }): RequestInput => ({ kind: "clarification", clarification })) : []),
    children: entries.flatMap((ended) => ended.type === "job_end" && ended.run === entry.run ? childOf(ended.details) : []),
    refusals: floorRefusals(entries, entry.run),
    ...continuesOf(entries, entry.run),
  }]);
}

/**
 * What the gate records as a run ends on an unresolved question (#651): the
 * start fingerprints it measures the request from, its own data, which the
 * run that continues it restores.
 */
const requestStartType = "tesota-request-start";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The run a `tesota.continues` entry names and the answer it carries (#651); none for any other entry. */
function continuedFrom(entry: SessionEntry): { run: number; clarification: Clarification }[] {
  if (entry.type !== "custom" || entry.customType !== continuesType || !isRecord(entry.data)) return [];
  const { run, clarification } = entry.data;
  return typeof run === "number" && Number.isInteger(run) && isRecord(clarification) && Number.isInteger(clarification["reply"])
    && typeof clarification["callId"] === "string" && typeof clarification["at"] === "string" && Array.isArray(clarification["questions"])
    && Array.isArray(clarification["answers"]) ? [{ run, clarification: clarification as unknown as Clarification }] : [];
}

/** The earlier run that run `run` continues, and what the gate saved as that run ended (#651); nothing for a run that continues none. */
function continuesOf(entries: readonly SessionEntry[], run: number): Pick<LedgerRequest, "continues"> {
  const linked = entries.flatMap((entry) => entry.type === "custom" && entry.run === run ? continuedFrom(entry) : [])[0];
  if (linked === undefined) return {};
  const saved = entries.findLast((entry) => entry.type === "custom" && entry.run === linked.run && entry.customType === requestStartType);
  return { continues: { run: linked.run, ...saved?.type === "custom" && saved.data !== undefined ? { start: saved.data } : {} } };
}

const unresolvedPrefix = "Unresolved question: ";

/**
 * The question the session's last run ended on (#599), and the batch an
 * answer settles (#651): the `ask_user` call the end reason names, or, for a
 * question asked in prose, a batch of that one question, without options or
 * a call. None when the last run ended otherwise.
 */
export function pendingQuestion(entries: readonly SessionEntry[]):
  Pick<Clarification, "reply" | "callId" | "questions"> & { readonly run: number } | undefined {
  const run = entries.filter((entry) => entry.type === "request").length;
  const end = entries.findLast((entry) => entry.type === "run_end");
  if (run === 0 || end?.type !== "run_end" || end.run !== run || end.reason?.startsWith(unresolvedPrefix) !== true) return undefined;
  const reason = end.reason;
  const replies = entries.flatMap((entry) => entry.type === "assistant" && entry.run === run ? [entry.message] : []);
  for (let reply = replies.length - 1; reply >= 0; reply -= 1) {
    const call = replies[reply]?.content.findLast((part) => part.type === "toolCall" && part.name === "ask_user"
      && reason.startsWith(`${unresolvedPrefix}${JSON.stringify(part.arguments)}`));
    const questions = call?.type === "toolCall" && isRecord(call.arguments) ? call.arguments["questions"] : undefined;
    if (call?.type === "toolCall" && validateQuestions(questions) === undefined) {
      return { run, reply, callId: call.id, questions: questions as unknown as readonly ClarificationQuestion[] };
    }
  }
  return { run, reply: Math.max(0, replies.length - 1), callId: "", questions: [{ question: reason.slice(unresolvedPrefix.length), options: [] }] };
}

/**
 * The run that `answer` starts when the session's last run ended on an
 * unresolved question (#651): the earlier request's text, its base, and the
 * answer as the operator's clarification of the pending batch, the same
 * text for each of its questions. It qualifies the request and grants
 * nothing: every permission and the floor stay as they are. None when no
 * question is pending.
 */
export function continuation(entries: readonly SessionEntry[], answer: string):
  { readonly text: string; readonly continues: Continuation } | undefined {
  const pending = pendingQuestion(entries);
  const request = pending === undefined ? undefined : ledgerOf(entries).find(({ run }) => run === pending.run);
  if (pending === undefined || request === undefined) return undefined;
  const { run, reply, callId, questions } = pending;
  const clarification: Clarification = { reply, callId, at: new Date().toISOString(), questions,
    answers: questions.map(() => ({ selected: [], text: answer })) };
  return { text: `${request.text}\n\nTesota: this continues request ${run}, which ended on an unresolved question, from the same base. `
    + `The operator's answer follows; it clarifies the request and grants no permission.\n\n${clarificationText(clarification)}`,
  continues: { run, base: request.base, clarification } };
}

/** The first request of the session in `file`, to name it in `/resume`; none for a session never asked anything. */
export function firstRequest(file: string): string | undefined {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const entry = JSON.parse(line) as { type?: string; text?: string };
      if (entry.type === "request" && typeof entry.text === "string") return entry.text.split("\n")[0] ?? "";
    }
  } catch { /* a session being written, or not one */ }
  return undefined;
}

/** The sessions in `folder` that were asked something, newest first, each with its first request: those `/resume` and `tesota -p -c` choose from. */
export function askedSessions(folder: string): { readonly file: string; readonly request: string }[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort().reverse().map((name) => join(folder, name))
    .flatMap((file) => { const request = firstRequest(file); return request === undefined ? [] : [{ file, request }]; });
}


/** A subagent as a receipt lists it (#525), from its job's report; none when the report says too little. */
function childOf(details: unknown): ReceiptChild[] {
  if (typeof details !== "object" || details === null) return [];
  const { description, type, model, writes, outcome, verification, session, branch, unguarded, floorRefusals: refused } =
    details as Record<string, unknown>;
  if (typeof description !== "string" || typeof outcome !== "string" || typeof session !== "string") return [];
  return [{ description, outcome, session, writes: writes === true, ...typeof type === "string" ? { type } : {},
    ...typeof model === "string" ? { model } : {},
    // Receipt v2 stores these three only (#668): an unverified child, or one that changed nothing, claims no standing.
    ...verification === "verified" || verification === "incomplete" || verification === "failed" ? { verification } : {},
    ...typeof branch === "string" ? { branch } : {}, ...unguarded === true ? { unguarded } : {},
    ...typeof refused === "number" && refused > 0 ? { floorRefusals: refused } : {} }];
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
    if (entry.type === "custom" && entry.customType === providerRetryType) {
      const retry = providerRetryTokens(entry.data);
      if (retry !== undefined) { tokens.input += retry.input; tokens.output += retry.output; tokens.total += retry.total; }
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
  opened: boolean, depth: number): EngineSession {
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
  const id = basename(file, ".jsonl");
  const scratch = scratchOf(file, workspace.cwd);
  // A session starts subagents while it is less than two below its top session (#525), counted across the top session's tree.
  const types = options.child?.types ?? agentTypes(workspace.cwd);
  const tree = options.child?.tree ?? { running: 0, limit: options.agentLimit ?? defaultAgentLimit };
  const host = depth < maxDepth ? agentHost({ id, folder: dirname(file), depth, workspace, options, types, tree, create: createSession })
    : undefined;
  let loop: LoopSession;
  try {
    loop = createLoop({ ...options, cwd: workspace.cwd, ...workspace.env === undefined ? {} : { env: workspace.env }, sessionId: id, verifier: (pi) => { options.verifier(pi, request); }, branch: () => branchOf(entries),
      writer: options.writer?.(recording) ?? recording, outputFolder: outputOf(file), sessionFile: file, ...opened ? { resumed: stateOf(entries) } : {},
      ...scratch === undefined ? {} : { scratch },
      ...host === undefined ? {} : { jobTools: (jobs) => [agentTool(host, jobs)] },
      ...options.child === undefined ? {} : { instructions: options.child.instructions(workspace.cwd, workspace.branch) } });
  } catch (error) {
    // An extension or the verifier that throws as it registers leaves nothing open.
    written.close();
    removeScratch(scratch);
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
    types,
    scratch,
    prompt: async (text, prompt) => {
      if (poisoned !== undefined) throw poisoned;
      return await loop.prompt(text, prompt);
    },
    reply: async (text) => {
      if (poisoned !== undefined) throw poisoned;
      const continued = continuation(entries, text);
      return await (continued === undefined ? loop.prompt(text) : loop.prompt(continued.text, { continues: continued.continues }));
    },
    compact: async () => {
      if (poisoned !== undefined) throw poisoned;
      return await loop.compact();
    },
    dispose: () => disposed ??= loop.dispose().finally(() => {
      removeScratch(scratch);
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
    workspace = options.child?.bind(id) ?? bindWorkspace(options.cwd, id);
    const { cwd, checkout, worktree, branch, base } = workspace;
    createSessionFile(file, { type: "session", format: sessionFormat, version: sessionVersion, id, cwd, createdAt, checkout,
      ...worktree === undefined ? {} : { worktree }, ...branch === undefined ? {} : { branch }, ...base === undefined ? {} : { base },
      ...options.child === undefined ? {} : { parent: options.child.parent } });
    return engineSession(file, () => { lock.release(); }, [], options, workspace, false, options.child?.parent.depth ?? 0);
  } catch (error) {
    workspace?.release();
    lock.release();
    throw error;
  }
}

/**
 * What recovery adds to the session in `file`, whose lock is held, synced
 * before anything runs; each child whose job it found running is recovered
 * too (#525), so it ends `interrupted` with its parent.
 */
function recovered(file: string, entries: readonly SessionEntry[]): SessionEntry[] {
  const added = recovery(entries, (callId) => interruptedOutput(outputOf(file), callId));
  if (added.length === 0) return added;
  const writer = sessionWriter(file);
  try {
    for (const entry of added) writer.append(entry);
    writer.sync();
  } finally {
    writer.close();
  }
  const unknown = new Set(added.flatMap((entry) => entry.type === "job_end" ? [entry.job] : []));
  for (const entry of entries) if (entry.type === "job_start" && unknown.has(entry.job)) recoverChild(entry.session);
  return added;
}

/** Recovers a child's session as opening it would, without opening it; one another writer holds, or that cannot be read, is left as it is. */
function recoverChild(file: string): void {
  let lock: { release(): void };
  try { lock = lockSession(lockOf(file)); } catch (error) {
    if (error instanceof SessionLockedError) return;
    throw error;
  }
  try { recovered(file, readSessionFile(file).entries); } catch { /* the parent opens whatever its child's file holds */ } finally {
    lock.release();
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
    const added = recovered(file, entries);
    return engineSession(file, () => { lock.release(); }, [...entries, ...added], options, workspace, true, header.parent?.depth ?? 0);
  } catch (error) {
    workspace?.release();
    lock.release();
    throw error;
  }
}

