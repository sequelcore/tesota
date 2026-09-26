import { expect, it, vi } from "vitest";
import { type WebFetchDependencies, type WebResponse, fetchPage } from "../src/web-fetch.js";

const body = (text: string): AsyncIterable<Uint8Array> => (async function* () { yield new TextEncoder().encode(text); })();

function response(status: number, headers: Record<string, string>, text = ""): WebResponse {
  return { status, headers, body: body(text) };
}

/** A web of hosts: each maps to addresses and a response per path; the operator allows the listed hosts. */
function web(options: { allowed?: string[]; denied?: string[]; addresses?: Record<string, string[]>;
  pages?: Record<string, WebResponse>; }) {
  const asked: string[] = [];
  const resolved: string[] = [];
  const requested: { url: string; address: string }[] = [];
  const dependencies: WebFetchDependencies = {
    permit: vi.fn(async (host: string) => {
      asked.push(host);
      if (options.denied?.includes(host)) return "denied";
      return options.allowed?.includes(host) === true ? "allowed" : "denied";
    }),
    resolve: async (host) => { resolved.push(host); return options.addresses?.[host] ?? ["93.184.215.14"]; },
    get: async (url, address) => {
      requested.push({ url: url.href, address });
      return options.pages?.[url.href] ?? response(404, { "content-type": "text/plain" }, "missing");
    },
  };
  return { dependencies, asked, resolved, requested };
}

const signal = (): AbortSignal => new AbortController().signal;

it("reads an allowed page over https, from the address it checked, as text", async () => {
  const w = web({ allowed: ["docs.example.com"], pages: { "https://docs.example.com/guide": response(200,
    { "content-type": "text/html; charset=utf-8" }, "<html><head><script>steal()</script></head><body><h1>Guide</h1><p>Use <a href=\"/x\">x</a>.</p></body></html>") } });
  const result = await fetchPage("http://docs.example.com/guide", w.dependencies, signal());
  expect(result.status).toBe("ok");
  if (result.status !== "ok") return;
  expect(result.page.finalUrl).toBe("https://docs.example.com/guide");
  expect(result.page.text).toContain("Guide");
  expect(result.page.text).toContain("Use x");
  expect(result.page.text).not.toContain("steal");
  expect(w.requested).toEqual([{ url: "https://docs.example.com/guide", address: "93.184.215.14" }]);
});

it("refuses a URL it could never fetch before asking anyone or looking anything up", async () => {
  for (const url of ["ftp://example.com/a", "file:///etc/passwd", "https://user:secret@example.com/", "not a url",
    "https://example.com:8443/"]) {
    const w = web({ allowed: ["example.com"] });
    const result = await fetchPage(url, w.dependencies, signal());
    expect(result).toMatchObject({ status: "failed", error: "url_refused" });
    expect(w.asked).toEqual([]);
    expect(w.resolved).toEqual([]);
  }
});

it("asks before looking up a host, and a denied host is never looked up", async () => {
  const w = web({ denied: ["tracker.example.net"] });
  const result = await fetchPage("https://data.tracker.example.net/?q=secret", w.dependencies, signal());
  expect(result).toMatchObject({ status: "failed", error: "destination_denied" });
  expect(w.asked).toEqual(["data.tracker.example.net"]);
  expect(w.resolved).toEqual([]);
});

it("refuses a public name that resolves to the operator's own network", async () => {
  const w = web({ allowed: ["intranet.example.com"], addresses: { "intranet.example.com": ["93.184.215.14", "192.168.1.10"] } });
  expect(await fetchPage("https://intranet.example.com/", w.dependencies, signal()))
    .toMatchObject({ status: "failed", error: "address_refused" });
  expect(w.requested).toEqual([]);
});

it("checks every redirect as a new destination, and stops after five", async () => {
  const hop = (to: string): WebResponse => response(302, { location: to });
  const inside = web({ allowed: ["a.example.com", "b.example.com"], addresses: { "b.example.com": ["10.0.0.5"] },
    pages: { "https://a.example.com/": hop("https://b.example.com/admin") } });
  expect(await fetchPage("https://a.example.com/", inside.dependencies, signal()))
    .toMatchObject({ status: "failed", error: "address_refused" });
  const elsewhere = web({ allowed: ["a.example.com"], pages: { "https://a.example.com/": hop("https://c.example.org/") } });
  expect(await fetchPage("https://a.example.com/", elsewhere.dependencies, signal()))
    .toMatchObject({ status: "failed", error: "destination_denied" });
  expect(elsewhere.asked).toEqual(["a.example.com", "c.example.org"]);
  const pages: Record<string, WebResponse> = {};
  for (let index = 0; index < 7; index++) pages[`https://a.example.com/${index}`] = hop(`/${index + 1}`);
  const loop = web({ allowed: ["a.example.com"], pages });
  expect(await fetchPage("https://a.example.com/0", loop.dependencies, signal()))
    .toMatchObject({ status: "failed", error: "too_many_redirects" });
});

it("refuses what is too large, not text, or empty, and never reads an empty page as a success", async () => {
  const large = web({ allowed: ["x.example.com"], pages: { "https://x.example.com/": response(200,
    { "content-type": "text/plain" }, "x".repeat(2 * 1024 * 1024 + 1)) } });
  expect(await fetchPage("https://x.example.com/", large.dependencies, signal())).toMatchObject({ error: "too_large" });
  const binary = web({ allowed: ["x.example.com"], pages: { "https://x.example.com/": response(200,
    { "content-type": "application/octet-stream" }, "\u0000") } });
  expect(await fetchPage("https://x.example.com/", binary.dependencies, signal())).toMatchObject({ error: "unsupported_type" });
  const empty = web({ allowed: ["x.example.com"], pages: { "https://x.example.com/": response(200,
    { "content-type": "text/html" }, "<html><body>  </body></html>") } });
  expect(await fetchPage("https://x.example.com/", empty.dependencies, signal())).toMatchObject({ error: "empty_page" });
  const gone = web({ allowed: ["x.example.com"] });
  expect(await fetchPage("https://x.example.com/gone", gone.dependencies, signal()))
    .toMatchObject({ error: "fetch_failed", detail: expect.stringContaining("404") });
});

it("keeps plain text, Markdown and JSON as they are", async () => {
  const w = web({ allowed: ["api.example.com"], pages: { "https://api.example.com/v": response(200,
    { "content-type": "application/json" }, "{\"version\":\"2.1\"}") } });
  const result = await fetchPage("https://api.example.com/v", w.dependencies, signal());
  expect(result.status === "ok" && result.page.text).toBe("{\"version\":\"2.1\"}");
});

it("stops at its time limit", async () => {
  const w = web({ allowed: ["slow.example.com"] });
  w.dependencies.get = async (_url, _address, requestSignal) => new Promise((_settle, fail) => {
    requestSignal.addEventListener("abort", () => { fail(new Error("aborted")); }, { once: true });
  });
  expect(await fetchPage("https://slow.example.com/", w.dependencies, signal(), { timeLimitMs: 20 }))
    .toMatchObject({ status: "failed", error: "timeout" });
});
