import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as z from "zod";
import type { TokenUsage } from "./token-usage.js";
import { type SearchConsent, searchContinues, searchStep } from "./verification/search-provider-rule.js";

/**
 * Web search behind one seam (decision 024), so the tool is the same whoever
 * answers it, with nothing to set up (issue #295). The providers, in order:
 * `hosted`, the `searcher` role's model searching with its provider's own
 * search, then Exa and Parallel, which search without any account. A keyless
 * provider receives the search's words, so it is used only once the operator
 * allowed it, asked the first time it would be; a provider pinned in
 * `~/.tesota/web.json` is the only one used (`searchStep`, proved).
 */

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type WebSearchOutcome =
  | Readonly<{
    status: "ok";
    /** Who answered: a keyless provider's name, or the searcher's `route:model`. */
    provider: string;
    results: readonly WebSearchResult[];
    /** A searching model's answer, from the pages its search found. */
    findings?: string;
    /** Addresses the findings cite that were not among the search's sources. */
    unverified?: readonly string[];
  }>
  | Readonly<{ status: "failed"; error: "provider_not_configured" | "provider_failed"; detail: string }>;

export interface WebSearch {
  /** `onUsage` receives the tokens a searching model used. */
  search(query: string, limit: number, signal: AbortSignal, onUsage?: (usage: TokenUsage) => void): Promise<WebSearchOutcome>;
}

export const SEARCH_PROVIDERS = ["hosted", "exa", "parallel"] as const;
export type SearchProviderName = typeof SEARCH_PROVIDERS[number];
/** The providers that search without any account of the operator's, as the consent question names them. */
export const KEYLESS_PROVIDERS: Readonly<Partial<Record<SearchProviderName, string>>> = { exa: "Exa", parallel: "Parallel" };

/** A provider in the order, when it can be used at all. */
export interface SearchProvider extends WebSearch {
  readonly name: SearchProviderName;
}

/** The operator's answer to keyless search: always, saved in `web.json`; this session; or not this session. */
export type KeylessAnswer = "always" | "session" | "no";

export const DEFAULT_WEB_CONFIG: string = join(homedir(), ".tesota", "web.json");

const configSchema = z.strictObject({ search: z.enum(SEARCH_PROVIDERS).optional(), keyless: z.literal("allowed").optional() });
type WebConfig = z.infer<typeof configSchema>;

const NOT_CONFIGURED = "No search provider: sign in to Codex or Claude Code for the searcher role (tesota roles), " +
  "or allow keyless search when Tesota asks";

/** Whether a keyless provider may be used, and how to ask the operator when nobody has answered yet. */
export interface SearchConsentSource {
  current(): SearchConsent;
  ask(): Promise<SearchConsent>;
}

const NO_CONSENT: SearchConsentSource = { current: () => "denied", ask: async () => "denied" };

/**
 * The providers in order, each used as `searchStep` says: a pinned provider
 * alone; without a pin each available one until one answers, a keyless one
 * only with the operator's consent. A failure names every provider tried;
 * nothing tried is `provider_not_configured`.
 */
export function searchInOrder(providers: readonly SearchProvider[], pinned?: SearchProviderName,
  consent: SearchConsentSource = NO_CONSENT): WebSearch {
  return {
    async search(query, limit, signal, onUsage) {
      const failures: string[] = [];
      for (const name of SEARCH_PROVIDERS) {
        const provider = providers.find((candidate) => candidate.name === name);
        const step = (answer: SearchConsent) => searchStep(pinned !== undefined, pinned === name, provider !== undefined,
          KEYLESS_PROVIDERS[name] !== undefined, answer);
        let next = step(consent.current());
        if (next === "ask") next = step(await consent.ask());
        if (next === "fail") {
          return { status: "failed", error: "provider_not_configured", detail: `The pinned search provider ${name} is not available` };
        }
        if (next !== "use" || provider === undefined) continue;
        const outcome = await provider.search(query, limit, signal, onUsage);
        if (outcome.status === "ok") return outcome;
        failures.push(`${name}: ${outcome.detail}`);
        if (!searchContinues(pinned !== undefined)) break;
      }
      return failures.length === 0 ? { status: "failed", error: "provider_not_configured", detail: NOT_CONFIGURED }
        : { status: "failed", error: "provider_failed", detail: failures.join("; ") };
    },
  };
}

function readConfig(path: string): WebConfig {
  if (!existsSync(path)) return {};
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid web.json; fix or delete it`);
  return parsed.data;
}

/** Remember that the operator allowed keyless search; the file is replaced whole, so a failed write leaves it as it was. */
export function allowKeylessSearch(path: string = DEFAULT_WEB_CONFIG): void {
  const config: WebConfig = { ...readConfig(path), keyless: "allowed" };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/**
 * One session's search: `hosted` when the searcher's route has its own
 * search, then the keyless providers. Keyless search is allowed when
 * `web.json` says so; otherwise `ask` asks the operator the first time a
 * search would use it, and the answer holds for the session, "always" also
 * saved. Without `ask`, as in `tesota run`, keyless search stays off unless
 * allowed. An unreadable file is an error, not a silent default.
 */
export function readWebSearch(options: { path?: string; hosted?: WebSearch | undefined; keyless: readonly SearchProvider[];
  ask?: (providers: readonly string[]) => Promise<KeylessAnswer> }): WebSearch {
  const path = options.path ?? DEFAULT_WEB_CONFIG;
  const config = readConfig(path);
  const providers: SearchProvider[] = [];
  const hosted = options.hosted;
  if (hosted !== undefined) providers.push({ name: "hosted", search: (...args) => hosted.search(...args) });
  providers.push(...options.keyless);
  let session: SearchConsent = config.keyless === "allowed" ? "allowed" : "unasked";
  let asking: Promise<SearchConsent> | undefined;
  const ask = options.ask;
  return searchInOrder(providers, config.search, {
    current: () => session,
    // Searches running at once share one question.
    ask: () => asking ??= (async () => {
      if (ask === undefined) return session = "denied";
      const answer = await ask(options.keyless.map((provider) => KEYLESS_PROVIDERS[provider.name] ?? provider.name));
      if (answer === "always") allowKeylessSearch(path);
      return session = answer === "no" ? "denied" : "allowed";
    })(),
  });
}

/**
 * An address as sources are compared: without its fragment, tracking
 * parameters (`utm_*`, which Codex adds to what it cites) or a trailing
 * slash; undefined when it is not an http or https address.
 */
export function sourceKey(address: string): string | undefined {
  let url: URL;
  try { url = new URL(address); } catch { return undefined; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.hash = "";
  // Collected first, since deleting while the parameters are iterated would skip one.
  const tracking = Array.from(url.searchParams.keys()).filter((name) => name.toLowerCase().startsWith("utm_"));
  for (const name of tracking) url.searchParams.delete(name);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : "";
  return `${url.host.toLowerCase()}${path}${url.search}`;
}

/**
 * A searching model's sources, checked: an address its findings cite counts
 * as a source only when its search found or opened that page; the others are
 * named as unverified. Cited sources come first, then what else the search
 * found, up to `limit`.
 */
export function checkedSources(cited: readonly { url: string; title?: string }[], found: readonly { url: string; title?: string }[],
  limit: number): { results: WebSearchResult[]; unverified: string[] } {
  const foundKeys = new Set(found.map((source) => sourceKey(source.url)).filter((key) => key !== undefined));
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  const unverified: string[] = [];
  for (const source of cited) {
    const key = sourceKey(source.url);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    if (foundKeys.has(key)) results.push({ title: source.title ?? source.url, url: source.url, snippet: "Cited in the findings" });
    else unverified.push(source.url);
  }
  for (const source of found) {
    const key = sourceKey(source.url);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    results.push({ title: source.title ?? source.url, url: source.url, snippet: "" });
  }
  return { results: results.slice(0, limit), unverified };
}
