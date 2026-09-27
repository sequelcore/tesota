import { expect, it } from "vitest";
import { fetchPage, pinnedGet, resolveHost, type WebFetchDependencies } from "../src/web-fetch.js";
import { readWebSearch } from "../src/web-search.js";

/**
 * Web access against the real web (decision 024), opt-in with
 * `TESOTA_LIVE_WEB=1` because it uses the network: a real page through the
 * resolver and the pinned connection, a public name that resolves to this
 * computer refused, and search through the operator's SearXNG when
 * `~/.tesota/web.json` names one.
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

it.runIf(live && process.env["TESOTA_LIVE_WEB_SEARCH"] === "1")("searches through the operator's SearXNG", async () => {
  const outcome = await readWebSearch().search("bun javascript runtime", 5, running());
  expect(outcome.status).toBe("ok");
  expect(outcome.status === "ok" && outcome.results.length).toBeGreaterThan(0);
}, 90_000);
