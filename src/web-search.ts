import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { TokenUsage } from "./token-usage.js";
import { searchContinues, searchStep } from "./verification/search-provider-rule.js";

/**
 * Web search behind one seam (decision 024), so the tool is the same whoever
 * answers it. The providers, in order: a SearXNG instance the operator runs,
 * named in `~/.tesota/web.json`, and the `searcher` role's model searching
 * with its provider's own search (issue #295), which needs no setup. A
 * provider pinned in `web.json` is the only one used (`searchStep`, proved).
 * SearXNG is the operator's own choice, so it is not held to the
 * public-address rule that pages are.
 */

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type WebSearchOutcome =
  | Readonly<{
    status: "ok";
    /** Who answered: `searxng`, or the searcher's `route:model`. */
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

export const SEARCH_PROVIDERS = ["searxng", "hosted"] as const;
export type SearchProviderName = typeof SEARCH_PROVIDERS[number];

/** A provider in the order, when it can be used at all. */
export interface SearchProvider extends WebSearch {
  readonly name: SearchProviderName;
}

export const DEFAULT_WEB_CONFIG: string = join(homedir(), ".tesota", "web.json");
export const WEB_SEARCH_TIME_LIMIT_MS: number = 30_000;

const configSchema = z.strictObject({ searxng: z.url({ protocol: /^https?$/u }).optional(), search: z.enum(SEARCH_PROVIDERS).optional() })
  .refine((config) => config.search !== "searxng" || config.searxng !== undefined, "search is searxng without a searxng address");
const searxngResponse = z.object({ results: z.array(z.object({ title: z.string().default(""), url: z.string(),
  content: z.string().default("") })) });

const NOT_CONFIGURED = "No search provider: sign in to Codex or Claude Code for the searcher role (tesota roles), " +
  "or set searxng in ~/.tesota/web.json to your SearXNG address";

function searxng(base: string): SearchProvider {
  return {
    name: "searxng",
    async search(query, limit, signal) {
      const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      try {
        const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(WEB_SEARCH_TIME_LIMIT_MS)]),
          headers: { accept: "application/json" } });
        if (!response.ok) {
          return { status: "failed", error: "provider_failed", detail: `SearXNG answered ${response.status}; is its json format enabled?` };
        }
        const parsed = searxngResponse.safeParse(await response.json());
        if (!parsed.success) return { status: "failed", error: "provider_failed", detail: "SearXNG answered in an unexpected shape" };
        // Only web pages: a result that is not an http or https address cannot be read.
        const results = parsed.data.results.filter((result) => /^https?:\/\//iu.test(result.url))
          .slice(0, limit).map((result) => ({ title: result.title, url: result.url, snippet: result.content }));
        return { status: "ok", provider: "searxng", results };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "failed", error: "provider_failed", detail: error instanceof Error ? error.message : "SearXNG did not answer" };
      }
    },
  };
}

/**
 * The providers in order, each used as `searchStep` says: a pinned provider
 * alone, and without a pin each available one until one answers. A failure
 * names every provider tried; nothing tried is `provider_not_configured`.
 */
export function searchInOrder(providers: readonly SearchProvider[], pinned?: SearchProviderName): WebSearch {
  return {
    async search(query, limit, signal, onUsage) {
      const failures: string[] = [];
      for (const name of SEARCH_PROVIDERS) {
        const provider = providers.find((candidate) => candidate.name === name);
        const step = searchStep(pinned !== undefined, pinned === name, provider !== undefined);
        if (step === "fail") {
          return { status: "failed", error: "provider_not_configured", detail: `The pinned search provider ${name} is not available` };
        }
        if (step === "skip" || provider === undefined) continue;
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

/**
 * The search the agent and explorers use: the operator's SearXNG from
 * `~/.tesota/web.json`, then `hosted`, the searcher's own search when its
 * route has one. An unreadable file is an error, not a silent default.
 */
export function readWebSearch(path: string = DEFAULT_WEB_CONFIG, hosted?: WebSearch): WebSearch {
  let config: z.infer<typeof configSchema> = {};
  if (existsSync(path)) {
    const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error(`${path} is not a valid web.json; fix or delete it`);
    config = parsed.data;
  }
  const providers: SearchProvider[] = [];
  if (config.searxng !== undefined) providers.push(searxng(config.searxng));
  if (hosted !== undefined) providers.push({ name: "hosted", search: (...args) => hosted.search(...args) });
  return searchInOrder(providers, config.search);
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
