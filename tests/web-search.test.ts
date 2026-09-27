import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readWebSearch } from "../src/web-search.js";

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
  expect(await search.search("bun runtime", 5, running())).toEqual({ status: "ok", results: [
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
