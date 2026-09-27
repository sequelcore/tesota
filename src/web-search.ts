import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";

/**
 * Web search behind one seam (decision 024), so the tool is the same whoever
 * answers it. The first provider is a SearXNG instance the operator runs,
 * named in `~/.tesota/web.json`; without one, search fails closed. The
 * provider is the operator's own choice, so it is not held to the
 * public-address rule that pages are.
 */

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type WebSearchOutcome =
  | Readonly<{ status: "ok"; results: readonly WebSearchResult[] }>
  | Readonly<{ status: "failed"; error: "provider_not_configured" | "provider_failed"; detail: string }>;

export interface WebSearch {
  search(query: string, limit: number, signal: AbortSignal): Promise<WebSearchOutcome>;
}

export const DEFAULT_WEB_CONFIG: string = join(homedir(), ".tesota", "web.json");
export const WEB_SEARCH_TIME_LIMIT_MS: number = 30_000;

const configSchema = z.strictObject({ searxng: z.url({ protocol: /^https?$/u }).optional() });
const searxngResponse = z.object({ results: z.array(z.object({ title: z.string().default(""), url: z.string(),
  content: z.string().default("") })) });

const notConfigured: WebSearch = {
  search: async () => ({ status: "failed", error: "provider_not_configured",
    detail: "No search provider: set searxng in ~/.tesota/web.json to your SearXNG address" }),
};

function searxng(base: string): WebSearch {
  return {
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
        return { status: "ok", results };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "failed", error: "provider_failed", detail: error instanceof Error ? error.message : "SearXNG did not answer" };
      }
    },
  };
}

/** The operator's search provider from `~/.tesota/web.json`; an unreadable file is an error, not a silent default. */
export function readWebSearch(path: string = DEFAULT_WEB_CONFIG): WebSearch {
  if (!existsSync(path)) return notConfigured;
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid web.json; fix or delete it`);
  return parsed.data.searxng === undefined ? notConfigured : searxng(parsed.data.searxng);
}
