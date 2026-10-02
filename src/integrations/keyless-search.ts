import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as z from "zod";
import type { SearchProvider, WebSearchOutcome, WebSearchResult } from "../web-search.js";

/**
 * Search without any account (issue #295): Exa's and Parallel's public MCP
 * servers, which both offer free, rate-limited search to agents with no key,
 * as OpenCode and Hermes use them. Each receives only the search's words:
 * Tesota sends no session id, model name or other identifier. Their addresses
 * are fixed here. A result's text is cut to a snippet, so a page reaches the
 * agent only through `web_read`, as before.
 */

export const KEYLESS_SEARCH_TIME_LIMIT_MS: number = 30_000;
export const SNIPPET_LIMIT = 300;

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";

function snippet(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat;
}

const isPage = (url: string): boolean => /^https?:\/\//iu.test(url);

/** Exa's `web_search_exa` answers in text: a block per result with `Title:`, `URL:` and `Highlights:`, separated by `---`. */
export function exaResults(text: string): WebSearchResult[] {
  return text.split(/\n-{3,}\n/u).flatMap((block) => {
    const title = /^Title: (.*)$/mu.exec(block)?.[1]?.trim() ?? "";
    const url = /^URL: (\S+)$/mu.exec(block)?.[1] ?? "";
    const highlights = /^Highlights:\n([\s\S]*)$/mu.exec(block)?.[1] ?? "";
    return isPage(url) ? [{ title: title || url, url, snippet: snippet(highlights) }] : [];
  });
}

const parallelResponse = z.object({ results: z.array(z.object({ url: z.string(), title: z.string().nullish(),
  excerpts: z.array(z.string()).nullish() })) });

/** Parallel's `web_search` answers in JSON: results with a URL, a title and excerpts. */
export function parallelResults(text: string): WebSearchResult[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  const response = parallelResponse.safeParse(parsed);
  if (!response.success) return undefined;
  return response.data.results.filter((result) => isPage(result.url)).map((result) => ({ title: result.title || result.url,
    url: result.url, snippet: snippet((result.excerpts ?? []).join(" ")) }));
}

/** One MCP tool call to a fixed server, with the text of its answer, or why there is none. */
async function callTool(url: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const client = new Client({ name: "tesota", version: "0.0.0" });
  // The SDK's transport declares optional members without `undefined`, which exactOptionalPropertyTypes rejects.
  await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport, { signal });
  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: KEYLESS_SEARCH_TIME_LIMIT_MS });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.flatMap((part: unknown) => {
      const value: unknown = typeof part === "object" && part !== null ? Reflect.get(part, "text") : undefined;
      return typeof value === "string" ? [value] : [];
    }).join("\n");
    if (result.isError === true) throw new Error(text.slice(0, 300) || "the provider refused the search");
    return text;
  } finally { await client.close().catch(() => undefined); }
}

function keyless(name: "exa" | "parallel", search: (query: string, limit: number, signal: AbortSignal) => Promise<WebSearchResult[]>): SearchProvider {
  return {
    name,
    async search(query, limit, signal): Promise<WebSearchOutcome> {
      const running = AbortSignal.any([signal, AbortSignal.timeout(KEYLESS_SEARCH_TIME_LIMIT_MS)]);
      try {
        return { status: "ok", provider: name, results: (await search(query, limit, running)).slice(0, limit) };
      } catch (error) {
        if (signal.aborted) throw error;
        const detail = running.aborted ? `no answer within ${KEYLESS_SEARCH_TIME_LIMIT_MS / 1_000} s`
          : error instanceof Error ? error.message : "the search failed";
        return { status: "failed", error: "provider_failed", detail };
      }
    },
  };
}

export const exaSearch: SearchProvider = keyless("exa", async (query, limit, signal) =>
  exaResults(await callTool(EXA_MCP_URL, "web_search_exa", { query, numResults: limit }, signal)));

export const parallelSearch: SearchProvider = keyless("parallel", async (query, _limit, signal) => {
  const results = parallelResults(await callTool(PARALLEL_MCP_URL, "web_search", { objective: query, search_queries: [query] }, signal));
  if (results === undefined) throw new Error("Parallel answered in an unexpected shape");
  return results;
});

/** The keyless providers in their order. */
export const KEYLESS_SEARCH: readonly SearchProvider[] = [exaSearch, parallelSearch];
