import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AUTH_ROUTES, kindLabels } from "./auth.js";
import { readAddedRoutes, type AddedRoute } from "./model-roles.js";
import { creditPercent, filledSegments, remainingPercent } from "./verification/usage-meter-rule.js";

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
 * hour when this read failed, or why there is none.
 */
export type RouteUsage =
  | { readonly route: string; readonly kind: string; readonly state: "read"; readonly reading: UsageReading }
  | { readonly route: string; readonly kind: string; readonly state: "last_known"; readonly reading: UsageReading;
    readonly readAt: number; readonly problem: string }
  | { readonly route: string; readonly kind: string; readonly state: "unavailable"; readonly problem: string };

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
  readonly userAgent: string;
}

/** A route's reading, or why it has none; a thrown error is a failed read, which the last reading may cover. */
type Outcome = { readonly reading: UsageReading } | { readonly none: string };

export const DEFAULT_USAGE_FILE: string = join(homedir(), ".tesota", "usage.json");

/** How long a reading stands in for a failed read, as Claude Code's last-known usage does. */
export const LAST_KNOWN_MS: number = 60 * 60 * 1000;

const BAR_SEGMENTS = 20;

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

/**
 * Read these routes' usage at once. Each reading is saved with its time; a
 * failed read shows the last reading of the past hour, or why there is none.
 */
export async function readUsage(routes: readonly { readonly route: string; readonly kind: string }[], sources: UsageSources,
  path: string = DEFAULT_USAGE_FILE, now: () => number = Date.now): Promise<RouteUsage[]> {
  const saved = readSaved(path);
  const fresh: Record<string, { readAt: number; reading: UsageReading }> = {};
  const usage = await Promise.all(routes.map(async ({ route, kind }): Promise<RouteUsage> => {
    try {
      const outcome = await readRoute(route, kind, sources);
      if ("none" in outcome) return { route, kind, state: "unavailable", problem: outcome.none };
      fresh[route] = { readAt: now(), reading: outcome.reading };
      return { route, kind, state: "read", reading: outcome.reading };
    } catch (error) {
      const last = saved[route];
      return last !== undefined && now() - last.readAt <= LAST_KNOWN_MS
        ? { route, kind, state: "last_known", reading: last.reading, readAt: last.readAt, problem: failure(error) }
        : { route, kind, state: "unavailable", problem: `unknown: ${failure(error)}` };
    }
  }));
  if (Object.keys(fresh).length > 0) {
    try { save(path, { ...saved, ...fresh }); } catch { /* A reading that cannot be saved is still shown. */ }
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

/** A meter's bar, as Codex draws one: 20 segments of the share left. */
export function bar(left: number): string {
  const filled = filledSegments(left, BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

/**
 * The usage table: a block per route with its kind and plan, a line per
 * meter, and then what the readings rest on.
 */
export function usageTable(usage: readonly RouteUsage[], now: number): string {
  const labels = usage.flatMap((entry) => entry.state === "unavailable" ? [] : entry.reading.meters.map((meter) => meter.label.length));
  const width = Math.max(0, ...labels) + 2;
  const blocks = usage.map((entry) => {
    const kind = kindLabels[entry.kind] ?? entry.kind;
    const plan = entry.state !== "unavailable" && entry.reading.plan !== undefined ? ` · ${entry.reading.plan}` : "";
    const lines = [`${entry.route}  ${kind}${plan}`];
    if (entry.state === "unavailable") return [...lines, `  ${entry.problem}`];
    if (entry.state === "last_known") lines.push(`  last known, ${span(now - entry.readAt)} ago: ${entry.problem}`);
    for (const meter of entry.reading.meters) {
      const reset = meter.resetsAt === undefined ? "" : meter.resetsAt > now ? ` · resets in ${span(meter.resetsAt - now)}` : " · reset due";
      lines.push(`  ${meter.label.padEnd(width)}${bar(meter.left)} ${String(meter.left).padStart(3)}% left${
        meter.amount === undefined ? "" : ` · ${meter.amount}`}${reset}`);
    }
    if (entry.reading.meters.length === 0 && entry.reading.notes.length === 0) lines.push("  no limits reported");
    for (const note of entry.reading.notes) lines.push(`  ${note}`);
    return lines;
  });
  return [...blocks.flatMap((lines) => [...lines, ""]),
    "Codex's usage comes from a private ChatGPT endpoint and Claude Code's from an experimental report; either may change.", ""].join("\n");
}

/** Each kind's default route, followed by the routes added for it, as `tesota auth status` lists them. */
export function usageRoutes(added: readonly AddedRoute[] = readAddedRoutes()): { route: string; kind: string }[] {
  return AUTH_ROUTES.flatMap((kind) => [{ route: kind, kind },
    ...added.filter((entry) => entry.kind === kind).map((entry) => ({ route: entry.name, kind }))]);
}

/** `tesota usage [route]` and `/usage [route]`: every route's usage, or one route's. */
export async function runUsageCommand(args: readonly string[], write: (text: string) => void, sources: UsageSources,
  path: string = DEFAULT_USAGE_FILE, now: () => number = Date.now): Promise<number> {
  const all = usageRoutes();
  const chosen = args.length === 0 ? all : all.filter((entry) => entry.route === args[0]);
  if (args.length > 1 || chosen.length === 0) {
    write(`Usage: tesota usage [${all.map((entry) => entry.route).join("|")}]\n`);
    return 2;
  }
  write(usageTable(await readUsage(chosen, sources, path, now), now()));
  return 0;
}
