import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { allRoutes, kindLabels } from "./auth.js";
import { creditPercent, filledSegments, type MeterTone, meterTone, remainingPercent } from "./verification/usage-meter-rule.js";
import { usageReader } from "./verification/usage-reader-rule.js";

/** One window or credit of an account: the whole percent left, when it resets, and the amounts behind a credit. */
export interface UsageMeter {
  readonly label: string;
  readonly left: number;
  /** Milliseconds since the epoch. */
  readonly resetsAt?: number;
  readonly amount?: string;
}

/** What a provider reported about an account: its plan, its meters, and facts that have no total to draw. */
export interface UsageReading {
  readonly plan?: string;
  readonly meters: readonly UsageMeter[];
  readonly notes: readonly string[];
}

/**
 * A route's usage in `tesota usage`: read now, the last reading of the past
 * hour when this read failed, or why there is none. A route signed in to the
 * same account as an earlier route shows that route's reading, and names it
 * (#235).
 */
export type RouteUsage = { readonly sameAccountAs?: string } & (
  | { readonly route: string; readonly kind: string; readonly state: "read"; readonly reading: UsageReading }
  | { readonly route: string; readonly kind: string; readonly state: "last_known"; readonly reading: UsageReading;
    readonly readAt: number; readonly problem: string }
  | { readonly route: string; readonly kind: string; readonly state: "unavailable"; readonly problem: string }
  /** Being read, with the last reading of the past hour, if any, shown meanwhile. */
  | { readonly route: string; readonly kind: string; readonly state: "reading";
    readonly last?: { readonly reading: UsageReading; readonly readAt: number } });

/** A provider's answer to a usage request. */
export interface UsageResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Where readings come from. `key` is the route's key or token, refreshed
 * when it is an OAuth sign-in, or undefined when the route is signed out; it
 * is sent to its provider and never shown or saved.
 */
export interface UsageSources {
  readonly key: (route: string, provider: string) => Promise<string | undefined>;
  readonly get: (url: string, headers: Readonly<Record<string, string>>) => Promise<UsageResponse>;
  /** Claude Code's own report for the account in this configuration folder, the default one when undefined. */
  readonly claudeCode: (configDirectory: string | undefined) => Promise<unknown>;
  readonly claudeCodeDirectory: (route: string) => string;
  /** Which account a route is signed in to, read locally from its sign-in; undefined when it records none. */
  readonly account: (route: string, kind: string) => Promise<string | undefined>;
  readonly userAgent: string;
}

/** A route's reading, or why it has none; a thrown error is a failed read, which the last reading may cover. */
type Outcome = { readonly reading: UsageReading } | { readonly none: string };

export const DEFAULT_USAGE_FILE: string = join(homedir(), ".tesota", "usage.json");

/** How long a reading stands in for a failed read, as Claude Code's last-known usage does. */
export const LAST_KNOWN_MS: number = 60 * 60 * 1000;


/** A named field of a JSON value, or undefined when the value is not an object. */
const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, name) : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const instant = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};
const dollars = (value: number): string => `$${value.toFixed(2)}`;

/** A window's label from its own length: 5h, week, 30 days. */
export function windowLabel(seconds: number): string {
  if (seconds === 7 * 86_400) return "week";
  if (seconds >= 86_400 && seconds % 86_400 === 0) return seconds === 86_400 ? "day" : `${seconds / 86_400} days`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** A meter from a window whose provider reports the percent used. */
function usedWindow(label: string, used: number, resetsAt: number | undefined): UsageMeter {
  return { label, left: remainingPercent(Math.round(used)), ...resetsAt === undefined ? {} : { resetsAt } };
}

/** Codex's `wham/usage`: each window with its length and reset, and the credit balance. */
export function codexUsage(body: unknown): UsageReading {
  const limits = field(body, "rate_limit");
  const meters = [field(limits, "primary_window"), field(limits, "secondary_window")].flatMap((value) => {
    const window = (value);
    const used = finite(field(window, "used_percent"));
    const seconds = finite(field(window, "limit_window_seconds"));
    const reset = finite(field(window, "reset_at"));
    return used === undefined || seconds === undefined ? [] : [usedWindow(windowLabel(seconds), used, reset === undefined ? undefined : reset * 1000)];
  });
  const credits = field(body, "credits");
  const balance = text(field(credits, "balance")) ?? finite(field(credits, "balance"))?.toString();
  const notes = field(credits, "unlimited") === true ? ["unlimited credits"]
    : field(credits, "has_credits") === true && balance !== undefined ? [`${balance} credits`] : [];
  const plan = text(field(body, "plan_type"));
  return { ...plan === undefined ? {} : { plan }, meters, notes };
}

const claudeWindows = [["five_hour", "5h"], ["seven_day", "week"], ["seven_day_opus", "week, Opus"],
  ["seven_day_sonnet", "week, Sonnet"]] as const;

/** Claude Code's experimental usage report: the plan's 5-hour and weekly windows; entries under other names are ignored. */
export function claudeCodeUsage(report: unknown): Outcome {
  const limits = field(report, "rate_limits");
  if (typeof limits !== "object" || limits === null) return { none: "Claude Code reports no plan limits for this sign-in" };
  const meters = claudeWindows.flatMap(([name, label]) => {
    const window = field(limits, name);
    const used = finite(field(window, "utilization"));
    return used === undefined ? [] : [usedWindow(label, used, instant(field(window, "resets_at")))];
  });
  const plan = text(field(report, "subscription_type"));
  return { reading: { ...plan === undefined ? {} : { plan }, meters, notes: [] } };
}

/** OpenRouter's key: a meter of what is left of its limit, or what it has used when it has none. */
export function openRouterUsage(body: unknown): UsageReading {
  const key = field(body, "data");
  const used = finite(field(key, "usage")) ?? 0;
  const limit = finite(field(key, "limit"));
  const remaining = finite(field(key, "limit_remaining"));
  if (limit === undefined || limit <= 0 || remaining === undefined) {
    return { meters: [], notes: [`${dollars(used)} used; the key has no limit`] };
  }
  const reset = text(field(key, "limit_reset"));
  return { meters: [{ label: reset === undefined ? "key limit" : `${reset} limit`, left: creditPercent(Math.round(remaining * 100),
    Math.round(limit * 100)), amount: `${dollars(remaining)} of ${dollars(limit)} left` }], notes: [] };
}

const goWindows = [["rolling", "rolling"], ["weekly", "week"], ["monthly", "month"]] as const;

/** OpenCode Go's rolling, weekly and monthly windows. */
export function openCodeGoUsage(body: unknown): UsageReading {
  const usage = field(body, "usage");
  const meters = goWindows.flatMap(([name, label]) => {
    const window = field(usage, name);
    const used = finite(field(window, "percent"));
    return used === undefined ? [] : [usedWindow(label, used, instant(field(window, "resetsAt")))];
  });
  return { plan: "Go", meters, notes: [] };
}

/** Why a request's answer is not a reading. */
function refusal(route: string, status: number): string {
  if (status === 401 || status === 403) return `sign-in refused (HTTP ${status}): tesota auth login ${route}`;
  return `usage request failed (HTTP ${status})`;
}

async function readCodex(route: string, sources: UsageSources): Promise<Outcome> {
  const token = await sources.key(route, "openai-codex");
  if (token === undefined) return { none: `signed out: tesota auth login ${route}` };
  const account = codexAccount(token);
  const response = await sources.get("https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${token}`,
    "User-Agent": sources.userAgent, ...account === undefined ? {} : { "ChatGPT-Account-Id": account } });
  if (response.status !== 200) throw new Error(refusal(route, response.status));
  return { reading: codexUsage(response.body) };
}

/** The ChatGPT account a Codex token belongs to, from its own claims, as Codex and Pi read it. */
function codexAccount(token: string): string | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return text(field(field(claims, "https://api.openai.com/auth"), "chatgpt_account_id"));
  } catch { return undefined; }
}

async function readClaudeCode(route: string, sources: UsageSources): Promise<Outcome> {
  const outcome = claudeCodeUsage(await sources.claudeCode(route === "claude-code" ? undefined : sources.claudeCodeDirectory(route)));
  if ("none" in outcome) throw new Error(`${outcome.none}; tesota auth status ${route} shows its sign-in`);
  return outcome;
}

async function readOpenRouter(route: string, sources: UsageSources): Promise<Outcome> {
  const key = await sources.key(route, "openrouter");
  if (key === undefined) return { none: `no key: tesota auth login ${route}` };
  const response = await sources.get("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}`, "User-Agent": sources.userAgent });
  if (response.status !== 200) throw new Error(refusal(route, response.status));
  return { reading: openRouterUsage(response.body) };
}

/** One OpenCode key serves Zen and Go: Go reports its windows; Zen's balance is only on OpenCode's website. */
async function readOpenCode(route: string, sources: UsageSources): Promise<Outcome> {
  const key = await sources.key(route, "opencode-go");
  if (key === undefined) return { none: `no key: tesota auth login ${route}` };
  const response = await sources.get("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${key}`,
    "User-Agent": sources.userAgent, "x-opencode-client": "tesota" });
  const zen = "Zen's balance: see opencode.ai";
  if (response.status === 403) return { reading: { meters: [], notes: ["no OpenCode Go subscription", zen] } };
  if (response.status !== 200) throw new Error(refusal(route, response.status));
  const go = openCodeGoUsage(response.body);
  return { reading: { ...go, notes: [...go.notes, zen] } };
}

/** Routes whose provider offers no usage source for the credential Tesota holds, and where the operator can look. */
const noSource: Readonly<Record<string, string>> = {
  anthropic: "no usage source for an API key: see console.anthropic.com/usage",
  typesafe: "no usage source: see console.typesafe.ai/settings/billing",
};

async function readRoute(route: string, kind: string, sources: UsageSources): Promise<Outcome> {
  if (kind === "codex") return readCodex(route, sources);
  if (kind === "claude-code") return readClaudeCode(route, sources);
  if (kind === "openrouter") return readOpenRouter(route, sources);
  if (kind === "opencode") return readOpenCode(route, sources);
  return { none: noSource[kind] ?? "no usage source" };
}

/** Readings saved with their time, by route. */
type SavedUsage = Readonly<Record<string, { readonly readAt: number; readonly reading: UsageReading }>>;

function readSaved(path: string): SavedUsage {
  try {
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof saved === "object" && saved !== null && !Array.isArray(saved) ? saved as SavedUsage : {};
  } catch { return {}; }
}

function save(path: string, saved: SavedUsage): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

const failure = (error: unknown): string => error instanceof Error && error.message.length > 0 ? error.message : "usage read failed";

/** Where readings are saved, the clock, and who hears of each route's reading as it arrives. */
export interface UsageOptions {
  readonly path?: string;
  readonly now?: () => number;
  readonly onEach?: (usage: RouteUsage) => void;
}

/** These routes as being read, each with its last reading of the past hour, so a panel has something to show at once. */
export function pendingUsage(routes: readonly { readonly route: string; readonly kind: string }[],
  { path = DEFAULT_USAGE_FILE, now = Date.now }: UsageOptions = {}): RouteUsage[] {
  const saved = readSaved(path);
  return routes.map(({ route, kind }) => {
    const last = saved[route];
    return last !== undefined && now() - last.readAt <= LAST_KNOWN_MS ? { route, kind, state: "reading", last } : { route, kind, state: "reading" };
  });
}

/**
 * Read these routes' usage at once, each account once: a route signed in to
 * the same account as an earlier route shows that route's reading, so their
 * meters cannot disagree. Each reading is saved with its time under every
 * route on its account; a failed read shows the account's last reading of the
 * past hour, or why there is none.
 */
export async function readUsage(routes: readonly { readonly route: string; readonly kind: string }[], sources: UsageSources,
  { path = DEFAULT_USAGE_FILE, now = Date.now, onEach }: UsageOptions = {}): Promise<RouteUsage[]> {
  const saved = readSaved(path);
  const fresh: Record<string, { readAt: number; reading: UsageReading }> = {};
  // An account that cannot be read leaves its route to be read by itself.
  const accounts = await Promise.all(routes.map(async ({ route, kind }) => await sources.account(route, kind).catch(() => undefined) ?? ""));
  const readers = routes.map((_, index) => usageReader(accounts, index));
  const sharing = (reader: number): string[] => routes.filter((_, index) => readers[index] === reader).map((entry) => entry.route);
  const readOne = async (reader: number): Promise<RouteUsage> => {
    const { route, kind } = routes[reader] ?? { route: "", kind: "" };
    try {
      const outcome = await readRoute(route, kind, sources);
      if ("none" in outcome) return { route, kind, state: "unavailable", problem: outcome.none };
      const readAt = now();
      for (const each of sharing(reader)) fresh[each] = { readAt, reading: outcome.reading };
      return { route, kind, state: "read", reading: outcome.reading };
    } catch (error) {
      // The newest reading saved under any route on the account, which every route on it shows.
      const last = sharing(reader).map((each) => saved[each]).filter((entry) => entry !== undefined)
        .reduce<SavedUsage[string] | undefined>((newest, entry) => newest === undefined || entry.readAt > newest.readAt ? entry : newest, undefined);
      return last !== undefined && now() - last.readAt <= LAST_KNOWN_MS
        ? { route, kind, state: "last_known", reading: last.reading, readAt: last.readAt, problem: failure(error) }
        : { route, kind, state: "unavailable", problem: `unknown: ${failure(error)}` };
    }
  };
  const reads = new Map<number, Promise<RouteUsage>>();
  const usage = await Promise.all(routes.map(async ({ route, kind }, index) => {
    const reader = readers[index] ?? index;
    const read = reads.get(reader) ?? readOne(reader);
    reads.set(reader, read);
    const outcome = await read;
    const one: RouteUsage = reader === index ? outcome : { ...outcome, route, kind, sameAccountAs: outcome.route };
    onEach?.(one);
    return one;
  }));
  if (Object.keys(fresh).length > 0) {
    try { save(path, { ...readSaved(path), ...fresh }); } catch { /* A reading that cannot be saved is still shown. */ }
  }
  return usage;
}

/** A span of time as the table shows it: 4d 2h, 3h 12m, 25m. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const [days, hours] = [Math.floor(minutes / 1440), Math.floor(minutes % 1440 / 60)];
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** A meter's bar, as Codex draws one: segments of the share left, 20 unless the width asks for fewer. */
export function bar(left: number, segments: number = 20): string {
  const filled = filledSegments(left, segments);
  return `${"█".repeat(filled)}${"░".repeat(segments - filled)}`;
}

/** How a table's text is styled: plain in the CLI, the theme's colors in the shell. */
export interface UsagePaint {
  readonly muted: (text: string) => string;
  readonly strong: (text: string) => string;
  readonly meter: (text: string, tone: MeterTone) => string;
}

const plain: UsagePaint = { muted: (text) => text, strong: (text) => text, meter: (text) => text };

/** One cell: its text, measured unstyled, and how it is styled. */
interface Cell {
  readonly text: string;
  readonly paint?: (text: string) => string;
}

/** A table row: cells in the route, account and window columns, then the meter and its details, or a note across them. */
interface Row {
  readonly cells: readonly Cell[];
  readonly note?: Cell;
}

function meterRows(reading: UsageReading, now: number, segments: number, paint: UsagePaint, stale: boolean): Row[] {
  const faded = (text: string): string => stale ? paint.muted(text) : text;
  const rows: Row[] = reading.meters.map((meter) => {
    const reset = meter.resetsAt === undefined ? undefined : meter.resetsAt > now ? `resets in ${span(meter.resetsAt - now)}` : "reset due";
    const detail = [meter.amount, reset].filter((part) => part !== undefined).join(" · ");
    const tone = meterTone(meter.left);
    return { cells: [{ text: meter.label, paint: faded }, { text: `${bar(meter.left, segments)} ${String(meter.left).padStart(3)}%`,
      paint: (text: string) => stale ? paint.muted(text) : paint.meter(text, tone) }, { text: detail, paint: paint.muted }] };
  });
  if (reading.meters.length === 0 && reading.notes.length === 0) rows.push({ cells: [], note: { text: "no limits reported", paint: paint.muted } });
  for (const note of reading.notes) rows.push({ cells: [], note: { text: note, paint: faded } });
  return rows;
}

/** Each route's rows: its meters, or why it has none, with the route and its account on the first. */
function routeRows(entry: RouteUsage, now: number, segments: number, paint: UsagePaint): Row[] {
  const kind = kindLabels[entry.kind] ?? entry.kind;
  const reading = entry.state === "read" || entry.state === "last_known" ? entry.reading : entry.state === "reading" ? entry.last?.reading : undefined;
  const account = reading?.plan === undefined ? kind : `${kind} ${reading.plan}`;
  const lead: Cell[] = [{ text: entry.route, paint: paint.strong }, { text: account }];
  // A route on an account read through an earlier route points to that reading instead of drawing it again.
  if (entry.sameAccountAs !== undefined && entry.state !== "reading") {
    return [{ cells: lead, note: { text: `same account as ${entry.sameAccountAs}: one reading, above`, paint: paint.muted } }];
  }
  const rows = reading === undefined ? [] : meterRows(reading, now, segments, paint, entry.state === "reading");
  if (entry.state === "unavailable") rows.push({ cells: [], note: { text: entry.problem, paint: paint.muted } });
  if (entry.state === "last_known") {
    rows.push({ cells: [], note: { text: `last known, ${span(now - entry.readAt)} ago: ${entry.problem}`, paint: paint.muted } });
  }
  // A saved reading shows faded while its route is read again; a route with none says it is being read.
  if (entry.state === "reading" && entry.last === undefined) rows.push({ cells: [], note: { text: "reading…", paint: paint.muted } });
  const [first, ...rest] = rows;
  return [{ ...first, cells: [...lead, ...first?.cells ?? []] },
    ...rest.map((row) => ({ ...row, cells: [{ text: "" }, { text: "" }, ...row.cells] }))];
}

/**
 * The usage table: a row per meter under each route and its account, the
 * share left as a bar, and the meter's reset or amount. The CLI and the
 * shell's Accounts panel both draw it; the shell adds the theme's colors and
 * fewer segments on a narrow terminal.
 */
export function usageLines(usage: readonly RouteUsage[], now: number,
  { segments = 20, paint = plain, width }: { segments?: number; paint?: UsagePaint; width?: number } = {}): string[] {
  const heading: Row = { cells: ["Route", "Account", "Window", "Left", "Details"].map((text) => ({ text, paint: paint.muted })) };
  const rows = [heading, ...usage.flatMap((entry) => routeRows(entry, now, segments, paint))];
  // A note spans from the window column on, so only the route and account columns count its row.
  const widths = [0, 1, 2, 3].map((column) => Math.max(0, ...rows.map((row) =>
    row.note !== undefined && column >= 2 ? 0 : row.cells[column]?.text.length ?? 0)));
  const styled = (cell: Cell, text: string): string => {
    const content = text.trimEnd();
    return `${cell.paint === undefined || content.length === 0 ? content : cell.paint(content)}${text.slice(content.length)}`;
  };
  return rows.flatMap((row) => {
    const columns = row.note === undefined ? row.cells : [...row.cells.slice(0, 2), row.note];
    const lead = columns.slice(0, -1).map((cell, column) => styled(cell, cell.text.padEnd((widths[column] ?? 0) + 2))).join("");
    const indent = columns.slice(0, -1).reduce((sum, _, column) => sum + (widths[column] ?? 0) + 2, 0);
    const last = columns.at(-1);
    if (last === undefined) return [lead.trimEnd()];
    // On a width, the last column wraps beneath itself, so a note keeps its link however narrow the table is.
    return wrapWords(last.text, width === undefined ? Number.POSITIVE_INFINITY : Math.max(12, width - indent))
      .map((part, index) => `${index === 0 ? lead : " ".repeat(indent)}${styled(last, part)}`.trimEnd());
  });
}

/** Text in lines of at most this width, broken between words, and within a word only when it alone is longer. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const joined = line.length === 0 ? word : `${line} ${word}`;
    if (joined.length <= width) { line = joined; continue; }
    if (line.length > 0) lines.push(line);
    line = word;
    while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width); }
  }
  return [...lines, line];
}

/** What the readings rest on, said once under the table. */
export const USAGE_SOURCES_NOTE: string = "Codex's usage comes from a private ChatGPT endpoint and Claude Code's from an experimental report; either may change.";

/** `tesota usage`'s text: the table, then what it rests on. */
export function usageTable(usage: readonly RouteUsage[], now: number): string {
  return [...usageLines(usage, now), "", USAGE_SOURCES_NOTE, ""].join("\n");
}

/** `tesota usage [route]`: every route's usage, or one route's. */
export async function runUsageCommand(args: readonly string[], write: (text: string) => void, sources: UsageSources,
  options: UsageOptions = {}): Promise<number> {
  const all = allRoutes();
  const chosen = args.length === 0 ? all : all.filter((entry) => entry.route === args[0]);
  if (args.length > 1 || chosen.length === 0) {
    write(`Usage: tesota usage [${all.map((entry) => entry.route).join("|")}]\n`);
    return 2;
  }
  write(usageTable(await readUsage(chosen, sources, options), (options.now ?? Date.now)()));
  return 0;
}
