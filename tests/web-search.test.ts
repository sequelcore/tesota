import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkedSources, readWebSearch, sourceKey, type WebSearch, type WebSearchOutcome } from "../src/web-search.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function config(content: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-web-"));
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  const path = join(root, "web.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

async function searxng(handler: (query: URLSearchParams) => { status: number; body: string }): Promise<string> {
  const server: Server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    const { status, body } = url.pathname === "/search" ? handler(url.searchParams) : { status: 404, body: "" };
    outgoing.writeHead(status, { "content-type": "application/json" });
    outgoing.end(body);
  });
  await new Promise<void>((settle) => { server.listen(0, "127.0.0.1", settle); });
  cleanups.push(() => { server.close(); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}

const running = (): AbortSignal => new AbortController().signal;

it("searches the operator's SearXNG and returns titles, addresses and snippets", async () => {
  const seen: string[] = [];
  const url = await searxng((query) => {
    seen.push(`${query.get("q")}|${query.get("format")}`);
    return { status: 200, body: JSON.stringify({ results: [
      { title: "Bun docs", url: "https://bun.sh/docs", content: "Bun is a runtime." },
      { title: "Other", url: "https://example.com/", content: "More." },
      { title: "Not a page", url: "javascript:alert(1)", content: "x" }] }) };
  });
  const search = readWebSearch(config(JSON.stringify({ searxng: url })));
  expect(await search.search("bun runtime", 5, running())).toEqual({ status: "ok", provider: "searxng", results: [
    { title: "Bun docs", url: "https://bun.sh/docs", snippet: "Bun is a runtime." },
    { title: "Other", url: "https://example.com/", snippet: "More." }] });
  expect(seen).toEqual(["bun runtime|json"]);
  const one = await search.search("bun runtime", 1, running());
  expect(one.status === "ok" && one.results.length).toBe(1);
});

it("fails closed when no provider is configured, and says why when the provider fails", async () => {
  expect(await readWebSearch(config(undefined)).search("x", 5, running()))
    .toMatchObject({ status: "failed", error: "provider_not_configured" });
  expect(() => readWebSearch(config("{\"searxng\":\"not a url\"}"))).toThrow("web.json");
  const url = await searxng(() => ({ status: 403, body: "" }));
  expect(await readWebSearch(config(JSON.stringify({ searxng: url }))).search("x", 5, running()))
    .toMatchObject({ status: "failed", error: "provider_failed", detail: expect.stringContaining("403") });
});

function hosted(outcome: WebSearchOutcome): WebSearch & { calls: string[] } {
  const calls: string[] = [];
  return { calls, search: async (query) => { calls.push(query); return outcome; } };
}
const found: WebSearchOutcome = { status: "ok", provider: "codex:gpt-6-luna", results: [], findings: "Bun 1.4.2" };

it("searches with the searcher when no SearXNG is named, and says how to get a provider when there is none", async () => {
  const searcher = hosted(found);
  expect(await readWebSearch(config(undefined), searcher).search("bun", 5, running())).toEqual(found);
  expect(searcher.calls).toEqual(["bun"]);
  const none = await readWebSearch(config(undefined)).search("bun", 5, running());
  expect(none).toMatchObject({ status: "failed", error: "provider_not_configured", detail: expect.stringContaining("searcher") });
});

it("tries the operator's SearXNG first and moves on to the searcher when it fails", async () => {
  const url = await searxng(() => ({ status: 500, body: "" }));
  const searcher = hosted(found);
  expect(await readWebSearch(config(JSON.stringify({ searxng: url })), searcher).search("bun", 5, running())).toEqual(found);
  const failing = hosted({ status: "failed", error: "provider_failed", detail: "codex: limit reached" });
  const both = await readWebSearch(config(JSON.stringify({ searxng: url })), failing).search("bun", 5, running());
  expect(both).toMatchObject({ status: "failed", error: "provider_failed" });
  expect(both.status === "failed" && both.detail).toMatch(/searxng: .*500.*; hosted: codex: limit reached/u);
});

it("uses a pinned provider alone: it never falls back, and is not replaced when unavailable", async () => {
  const url = await searxng(() => ({ status: 500, body: "" }));
  const searcher = hosted(found);
  const pinned = await readWebSearch(config(JSON.stringify({ searxng: url, search: "searxng" })), searcher).search("bun", 5, running());
  expect(pinned).toMatchObject({ status: "failed", error: "provider_failed" });
  expect(searcher.calls).toEqual([]);
  const off = await readWebSearch(config(JSON.stringify({ search: "hosted" }))).search("bun", 5, running());
  expect(off).toMatchObject({ status: "failed", error: "provider_not_configured", detail: expect.stringContaining("pinned") });
  const alone = hosted(found);
  expect(await readWebSearch(config(JSON.stringify({ searxng: url, search: "hosted" })), alone).search("bun", 5, running()))
    .toEqual(found);
  expect(() => readWebSearch(config(JSON.stringify({ search: "searxng" })))).toThrow("web.json");
  expect(() => readWebSearch(config(JSON.stringify({ search: "bing" })))).toThrow("web.json");
});

it("compares addresses without fragments, tracking parameters or a trailing slash", () => {
  expect(sourceKey("https://Dafny.org/blog/about/?utm_source=openai#top")).toBe("dafny.org/blog/about");
  expect(sourceKey("https://bun.sh/")).toBe("bun.sh");
  expect(sourceKey("https://example.com/a?page=2&utm_medium=x")).toBe("example.com/a?page=2");
  expect(sourceKey("javascript:alert(1)")).toBeUndefined();
  expect(sourceKey("not an address")).toBeUndefined();
});

it("keeps a cited source only when the search found it, and names the others", () => {
  const checked = checkedSources(
    [{ url: "https://bun.sh/?utm_source=openai", title: "Bun" }, { url: "https://invented.example/post" }, { url: "https://bun.sh/" }],
    [{ url: "https://bun.sh/" }, { url: "https://github.com/oven-sh/bun/releases", title: "Releases" }, { url: "https://a.example/" }], 2);
  expect(checked.results).toEqual([
    { title: "Bun", url: "https://bun.sh/?utm_source=openai", snippet: "Cited in the findings" },
    { title: "Releases", url: "https://github.com/oven-sh/bun/releases", snippet: "" }]);
  expect(checked.unverified).toEqual(["https://invented.example/post"]);
});
