import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import type { AccountRow } from "./accounts.ts";
import { filledSegments, remainingHundredths, usageReader } from "./usage-rule.ts";

/**
 * How much each account has left (#184, #260): the plan's limit windows as
 * Claude Code's own usage report and Codex's usage endpoint give them. Only
 * these two providers have a source; saved readings hold meters and notes,
 * bound to a one-way fingerprint of whom they were read for, never a token,
 * a credential, an email or an account ID.
 */

/** One limit window of an account: the share left, in hundredths of a percent (10000 is all of it), and when it resets (milliseconds since the epoch). */
export interface UsageMeter {
  readonly label: string;
  readonly hundredthsLeft: number;
  readonly resetsAt?: number;
}

/** What a provider reported about an account: its plan, its windows, and facts that have no total to draw. */
export interface UsageReading {
  readonly plan?: string;
  readonly meters: readonly UsageMeter[];
  readonly notes: readonly string[];
}

/**
 * An account's usage: read now, the last reading of the past hour when this
 * read failed, why there is none, or being read with the saved reading, if
 * any, shown meanwhile. An account on the same underlying account as an
 * earlier one shows that account's reading, and names it.
 */
export type AccountUsage = { readonly id: string; readonly sameAccountAs?: string } & (
  | { readonly state: "read"; readonly reading: UsageReading }
  | { readonly state: "last_known"; readonly reading: UsageReading; readonly readAt: number; readonly problem: string }
  | { readonly state: "unavailable"; readonly problem: string }
  | { readonly state: "reading"; readonly last?: { readonly reading: UsageReading; readonly readAt: number } });

/** The accounts a reading needs to know about: which, of what provider, signed in to whom. */
export type UsageAccount = Pick<AccountRow, "id" | "provider" | "signedIn" | "identity" | "folder">;

/** ChatGPT's answer to a usage request. */
export interface UsageResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Where readings come from. Neither returns or shows a credential: Claude
 * Code's report is Claude Code's own, and ChatGPT's request carries the
 * account's token only on its way to OpenAI. Each stops, and lets go of what
 * it started, when `signal` aborts.
 */
export interface UsageSources {
  /** Claude Code's usage report for the account in this folder, the default one when undefined. */
  readonly claudeCode: (folder: string | undefined, signal: AbortSignal) => Promise<unknown>;
  /** The usage endpoint's answer for a ChatGPT account, or undefined when it has no credential. */
  readonly chatgpt: (id: string, signal: AbortSignal) => Promise<UsageResponse | undefined>;
}

/** How long a reading stands in for a failed read, as Claude Code's last-known usage does. */
export const LAST_KNOWN_MS: number = 60 * 60 * 1000;

/** How long one read may take before it counts as failed. */
export const READ_LIMIT_MS = 20_000;

/** What the readings rest on, said once under the table. */
export const USAGE_SOURCES_NOTE = "Claude's usage comes from Claude Code's experimental usage report, which may change.";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string): unknown => isRecord(value) ? value[name] : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const instant = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A window's label from its own length: 5h, week, 30 days. */
export function windowLabel(seconds: number): string {
  if (seconds === 7 * 86_400) return "week";
  if (seconds >= 86_400 && seconds % 86_400 === 0) return seconds === 86_400 ? "day" : `${seconds / 86_400} days`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * A reported percent used, in whole hundredths for the meter's rules: none
 * only when none is used, all only when all is, and the nearest hundredth
 * between, so a fraction is never rounded onto either edge.
 */
export function usedHundredths(percent: number): number {
  if (percent <= 0) return 0;
  if (percent >= 100) return 10_000;
  return Math.min(9_999, Math.max(1, Math.round(percent * 100)));
}

function usedWindow(label: string, used: number, resetsAt: number | undefined): UsageMeter {
  return { label, hundredthsLeft: remainingHundredths(usedHundredths(used)), ...resetsAt === undefined ? {} : { resetsAt } };
}

/**
 * A source's reply: a reading; limits the sign-in genuinely does not have,
 * which no earlier reading stands in for; or a reply of the wrong shape,
 * which counts as a failed read.
 */
export type ParsedUsage = { readonly reading: UsageReading } | { readonly none: string } | { readonly unreadable: string };

const claudeWindows = [["five_hour", "5h"], ["seven_day", "week"], ["seven_day_opus", "week, Opus"], ["seven_day_sonnet", "week, Sonnet"]] as const;
const claudeUnreadable = { unreadable: "Claude Code's usage report was not understood" } as const;

/**
 * Claude Code's usage report: the plan's 5-hour and weekly windows. A sign-in
 * Claude Code says has no plan limits (an API key) has none; a report whose
 * limits or one of whose windows is of the wrong shape is unreadable. A window
 * that is absent is left out; other windows are ignored.
 */
export function claudeCodeUsage(report: unknown): ParsedUsage {
  if (!isRecord(report)) return claudeUnreadable;
  const limits = report["rate_limits"];
  if (limits === undefined || limits === null) {
    return report["rate_limits_available"] === false ? { none: "Claude Code reports no plan limits for this sign-in" } : claudeUnreadable;
  }
  if (!isRecord(limits)) return claudeUnreadable;
  const meters: UsageMeter[] = [];
  for (const [name, label] of claudeWindows) {
    const window = limits[name];
    if (window === undefined || window === null) continue;
    const used = finite(field(window, "utilization"));
    if (used === undefined) return claudeUnreadable;
    meters.push(usedWindow(label, used, instant(field(window, "resets_at"))));
  }
  const plan = text(report["subscription_type"]);
  return { reading: { ...plan === undefined ? {} : { plan }, meters, notes: [] } };
}

const codexUnreadable = { unreadable: "ChatGPT's usage reply was not understood" } as const;

/**
 * Codex's `wham/usage`: each window with its length and reset, and the credit
 * balance. A reply whose `rate_limit` is absent or null has no limits; one
 * whose `rate_limit` or one of whose windows is of the wrong shape is unreadable.
 */
export function codexUsage(body: unknown): ParsedUsage {
  if (!isRecord(body)) return codexUnreadable;
  const limits = body["rate_limit"];
  if (limits === undefined || limits === null) return { none: "ChatGPT reports no limits for this sign-in" };
  if (!isRecord(limits)) return codexUnreadable;
  const meters: UsageMeter[] = [];
  for (const window of [limits["primary_window"], limits["secondary_window"]]) {
    if (window === undefined || window === null) continue;
    const used = finite(field(window, "used_percent"));
    const seconds = finite(field(window, "limit_window_seconds"));
    if (used === undefined || seconds === undefined || seconds <= 0) return codexUnreadable;
    const reset = finite(field(window, "reset_at"));
    meters.push(usedWindow(windowLabel(seconds), used, reset === undefined ? undefined : reset * 1000));
  }
  const credits = body["credits"];
  const balance = text(field(credits, "balance")) ?? finite(field(credits, "balance"))?.toString();
  const notes = field(credits, "unlimited") === true ? ["unlimited credits"]
    : field(credits, "has_credits") === true && balance !== undefined ? [`${balance} credits`] : [];
  const plan = text(body["plan_type"]);
  return { reading: { ...plan === undefined ? {} : { plan }, meters, notes } };
}

/** An account's reading, or why it has none; a thrown error is a failed read, which the last reading may cover. */
type Outcome = { readonly reading: UsageReading } | { readonly none: string };

const settled = (parsed: ParsedUsage): Outcome => {
  if ("unreadable" in parsed) throw new Error(parsed.unreadable);
  return parsed;
};

async function readAccount(account: UsageAccount, sources: UsageSources, signal: AbortSignal): Promise<Outcome> {
  if (!account.signedIn) return { none: "not signed in" };
  if (account.provider === "claude-code") return settled(claudeCodeUsage(await sources.claudeCode(account.folder, signal)));
  if (account.provider === "openai-codex") {
    const response = await sources.chatgpt(account.id, signal);
    if (response === undefined) return { none: "not signed in" };
    if (response.status === 401 || response.status === 403) throw new Error(`sign-in refused (HTTP ${response.status})`);
    if (response.status !== 200) throw new Error(`usage request failed (HTTP ${response.status})`);
    return settled(codexUsage(response.body));
  }
  return { none: "reports no limits" };
}

/** Where readings are saved: under Tesota's home. */
export const usageFile = (): string => join(tesotaHome(), "usage.json");

/**
 * Whom an account's reading is for, as a one-way fingerprint of its provider
 * and identity; undefined while the identity is unknown, when no saved
 * reading may stand for it.
 */
export function usageFingerprint(account: UsageAccount): string | undefined {
  if (!account.signedIn || account.identity === undefined) return undefined;
  return createHash("sha256").update(`tesota usage\0${account.provider}\0${account.identity.toLowerCase()}`).digest("hex");
}

/** A reading saved with its time and the fingerprint of whom it was read for. */
interface Saved { readonly readAt: number; readonly who: string; readonly reading: UsageReading }
type SavedUsage = Readonly<Record<string, Saved>>;

function savedReading(value: unknown): Saved | undefined {
  const readAt = finite(field(value, "readAt"));
  const who = field(value, "who");
  const reading = field(value, "reading");
  const meters = field(reading, "meters");
  const notes = field(reading, "notes");
  if (readAt === undefined || typeof who !== "string" || !/^[0-9a-f]{64}$/u.test(who) || !Array.isArray(meters) || !Array.isArray(notes)) return undefined;
  const kept: UsageMeter[] = [];
  for (const meter of meters as unknown[]) {
    const label = text(field(meter, "label"));
    const hundredthsLeft = finite(field(meter, "hundredthsLeft"));
    if (label === undefined || hundredthsLeft === undefined || !Number.isInteger(hundredthsLeft) || hundredthsLeft < 0 || hundredthsLeft > 10_000) return undefined;
    const resetsAt = finite(field(meter, "resetsAt"));
    kept.push({ label, hundredthsLeft, ...resetsAt === undefined ? {} : { resetsAt } });
  }
  const plan = text(field(reading, "plan"));
  return { readAt, who, reading: { ...plan === undefined ? {} : { plan }, meters: kept,
    notes: (notes as unknown[]).filter((note): note is string => typeof note === "string") } };
}

function readSaved(path: string): SavedUsage {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      const saved = savedReading(value);
      return saved === undefined ? [] : [[id, saved]];
    }));
  } catch { return {}; }
}

function save(path: string, saved: SavedUsage): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Whether a reading taken at `readAt` may stand in at `now`: read within the past hour, and not after now, so a clock that moved back never stretches it. */
export const recentEnough = (readAt: number, now: number): boolean => 0 <= now - readAt && now - readAt <= LAST_KNOWN_MS;

/** The saved reading that may stand for `account`: read for whom it is signed in to now, within the past hour. */
function standIn(saved: Saved | undefined, account: UsageAccount, now: number): Saved | undefined {
  const who = usageFingerprint(account);
  return saved !== undefined && who !== undefined && saved.who === who && recentEnough(saved.readAt, now) ? saved : undefined;
}

const failure = (error: unknown): string => error instanceof Error && error.message.length > 0 ? error.message : "usage read failed";

/** Where readings are saved, the clock, how long a read may take, what stops the round, and who hears of each account's usage as it arrives. */
export interface UsageOptions {
  readonly path?: string;
  readonly now?: () => number;
  readonly limitMs?: number;
  readonly signal?: AbortSignal;
  readonly onEach?: (usage: AccountUsage) => void;
}

/**
 * `read` with a signal of its own, which aborts after `ms` or when `outer`
 * does, so the source stops and lets go of what it started; the read then
 * fails at once, whether or not the source heeds it.
 */
async function within<T>(read: (signal: AbortSignal) => Promise<T>, ms: number, outer: AbortSignal | undefined): Promise<T> {
  const stop = new AbortController();
  let fail = (_error: Error): void => undefined;
  const stopped = new Promise<never>((_, reject) => { fail = reject; });
  const abort = (error: Error): void => { fail(error); stop.abort(error); };
  const timer = setTimeout(() => { abort(new Error("the read took too long")); }, ms);
  const onOuter = (): void => { abort(new Error("the read was stopped")); };
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    if (outer?.aborted === true) onOuter();
    return await Promise.race([read(stop.signal), stopped]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

/** These accounts as being read, each with the saved reading of the past hour that was read for whom it is signed in to now, so a panel has something to show at once. */
export function pendingUsage(accounts: readonly UsageAccount[], { path = usageFile(), now = Date.now }: UsageOptions = {}): AccountUsage[] {
  const saved = readSaved(path);
  const at = now();
  return accounts.map((account) => {
    const last = standIn(saved[account.id], account, at);
    return last === undefined ? { id: account.id, state: "reading" } : { id: account.id, state: "reading", last: { readAt: last.readAt, reading: last.reading } };
  });
}

/** The accounts' identities as `usageReader` takes them: the provider and whom it is signed in to, or empty when unknown. */
export const identities = (accounts: readonly UsageAccount[]): string[] =>
  accounts.map(({ provider, signedIn, identity }) => signedIn && identity !== undefined ? `${provider}/${identity.toLowerCase()}` : "");

/**
 * Reads these accounts' usage at once, each underlying account once: an
 * account on the same one as an earlier account shows that account's reading,
 * so their meters cannot disagree. Each reading is saved with its time and
 * whom it was read for under every account on it; a failed or late read shows
 * the account's last saved reading of the past hour for the same sign-in, or
 * why there is none. A round `signal` stops reports nothing more and saves
 * nothing.
 */
export async function readUsage(accounts: readonly UsageAccount[], sources: UsageSources,
  { path = usageFile(), now = Date.now, limitMs = READ_LIMIT_MS, signal, onEach }: UsageOptions = {}): Promise<AccountUsage[]> {
  const saved = readSaved(path);
  const fresh: Record<string, Saved> = {};
  const who = identities(accounts);
  const readers = accounts.map((_, index) => usageReader(who, index));
  const sharing = (reader: number): UsageAccount[] => accounts.filter((_, index) => readers[index] === reader);
  const readOne = async (reader: number): Promise<AccountUsage> => {
    const account = accounts[reader];
    if (account === undefined) return { id: "", state: "unavailable", problem: "no such account" };
    const { id } = account;
    try {
      const outcome = await within((stop) => readAccount(account, sources, stop), limitMs, signal);
      if ("none" in outcome) return { id, state: "unavailable", problem: outcome.none };
      const readAt = now();
      for (const each of sharing(reader)) {
        const fingerprint = usageFingerprint(each);
        if (fingerprint !== undefined) fresh[each.id] = { readAt, who: fingerprint, reading: outcome.reading };
      }
      return { id, state: "read", reading: outcome.reading };
    } catch (error) {
      const at = now();
      const last = sharing(reader).map((each) => standIn(saved[each.id], each, at)).filter((entry) => entry !== undefined)
        .reduce<Saved | undefined>((newest, entry) => newest === undefined || entry.readAt > newest.readAt ? entry : newest, undefined);
      return last !== undefined
        ? { id, state: "last_known", reading: last.reading, readAt: last.readAt, problem: failure(error) }
        : { id, state: "unavailable", problem: failure(error) };
    }
  };
  const reads = new Map<number, Promise<AccountUsage>>();
  const usage = await Promise.all(accounts.map(async ({ id }, index) => {
    const reader = readers[index] ?? index;
    const read = reads.get(reader) ?? readOne(reader);
    reads.set(reader, read);
    const outcome = await read;
    const one: AccountUsage = reader === index ? outcome : { ...outcome, id, sameAccountAs: outcome.id };
    if (signal?.aborted !== true) onEach?.(one);
    return one;
  }));
  if (signal?.aborted !== true && Object.keys(fresh).length > 0) {
    try { save(path, { ...readSaved(path), ...fresh }); } catch { /* A reading that cannot be saved is still shown. */ }
  }
  return usage;
}

/** A span of time as the panel shows it: 4d 2h, 3h 12m, 25m. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const [days, hours] = [Math.floor(minutes / 1440), Math.floor(minutes % 1440 / 60)];
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** A meter's bar: segments of the share left, in hundredths of a percent. */
export function bar(hundredthsLeft: number, segments: number): string {
  const filled = filledSegments(hundredthsLeft, segments);
  return `${"█".repeat(filled)}${"░".repeat(segments - filled)}`;
}
