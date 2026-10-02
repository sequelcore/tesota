import { expect, it } from "vitest";
import { fetchPage, pinnedGet, resolveHost, type WebFetchDependencies } from "../src/web-fetch.js";
import { exaSearch, parallelSearch, SNIPPET_LIMIT } from "../src/integrations/keyless-search.js";
import { hostedSearch } from "../src/integrations/hosted-search.js";
import { openModelTarget } from "../src/integrations/model-session.js";
import { readModelChoices } from "../src/model-roles.js";

/**
 * Web access against the real web (decision 024), opt-in with
 * `TESOTA_LIVE_WEB=1` because it uses the network: a real page through the
 * resolver and the pinned connection, a public name that resolves to this
 * computer refused, search through Exa and Parallel without an account
 * with `TESOTA_LIVE_WEB_SEARCH=1`, and the searcher's own search with
 * `TESOTA_LIVE_HOSTED_SEARCH=1`, on the searcher's model and account.
 */

const live = process.env["TESOTA_LIVE_WEB"] === "1";
const running = (): AbortSignal => AbortSignal.timeout(60_000);
const allowAll: WebFetchDependencies = { permit: async () => "allowed", resolve: resolveHost, get: pinnedGet };

it.runIf(live)("reads a real public page over https as text, upgrading http", async () => {
  const result = await fetchPage("http://example.com/", allowAll, running());
  expect(result.status).toBe("ok");
  expect(result.status === "ok" && result.page.finalUrl).toBe("https://example.com/");
  expect(result.status === "ok" && result.page.text).toContain("Example Domain");
}, 90_000);

it.runIf(live)("refuses a public name that resolves to this computer", async () => {
  // localtest.me and its subdomains resolve to 127.0.0.1 by design.
  expect(await fetchPage("https://app.localtest.me/", allowAll, running()))
    .toMatchObject({ status: "failed", error: "address_refused" });
}, 90_000);

it.runIf(live && process.env["TESOTA_LIVE_WEB_SEARCH"] === "1").each([exaSearch, parallelSearch])(
  "searches $name without an account and returns pages with short snippets", async (provider) => {
    const outcome = await provider.search("Bun JavaScript runtime latest release", 5, running());
    expect(outcome).toMatchObject({ status: "ok", provider: provider.name });
    const results = outcome.status === "ok" ? outcome.results : [];
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//u);
      expect(result.snippet.length).toBeLessThanOrEqual(SNIPPET_LIMIT + 1);
    }
  }, 90_000);

it.runIf(live && process.env["TESOTA_LIVE_HOSTED_SEARCH"] === "1")("searches with the searcher's provider and confirms a cited page", async () => {
  const choice = readModelChoices().searcher;
  const outcome = await hostedSearch(choice, (signal) => openModelTarget(choice, signal))
    .search("What is the latest stable release of Bun, the JavaScript runtime?", 5, running());
  expect(outcome).toMatchObject({ status: "ok", provider: choice, findings: expect.any(String) });
  expect(outcome.status === "ok" && outcome.results.some((result) => result.snippet === "Cited in the findings")).toBe(true);
}, 150_000);
