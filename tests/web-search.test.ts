import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkedSources, type KeylessAnswer, readWebSearch, type SearchProvider, type SearchProviderName, sourceKey, type WebSearch,
  type WebSearchOutcome } from "../src/web-search.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function config(content: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-web-"));
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); });
  const path = join(root, "web.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

const running = (): AbortSignal => new AbortController().signal;

/** A provider that records the searches it receives and answers with this outcome. */
function provider(name: SearchProviderName, outcome: WebSearchOutcome): SearchProvider & { calls: string[] } {
  const calls: string[] = [];
  return { name, calls, search: async (query) => { calls.push(query); return outcome; } };
}
function hosted(outcome: WebSearchOutcome): WebSearch & { calls: string[] } {
  const calls: string[] = [];
  return { calls, search: async (query) => { calls.push(query); return outcome; } };
}
const ok = (name: string): WebSearchOutcome => ({ status: "ok", provider: name, results: [{ title: name, url: `https://${name}.example/`, snippet: "" }] });
const failed = (detail: string): WebSearchOutcome => ({ status: "failed", error: "provider_failed", detail });

/** An operator who answers the keyless question with `answer`, counting the questions. */
function operator(answer: KeylessAnswer): { asked: (readonly string[])[]; ask: (providers: readonly string[]) => Promise<KeylessAnswer> } {
  const asked: (readonly string[])[] = [];
  return { asked, ask: async (providers) => { asked.push(providers); return answer; } };
}

it("searches with the searcher first, and never asks about keyless search while it answers", async () => {
  const searcher = hosted(ok("chatgpt:gpt-6-luna"));
  const exa = provider("exa", ok("exa"));
  const who = operator("session");
  const search = readWebSearch({ path: config(undefined), hosted: searcher, keyless: [exa], ask: who.ask });
  expect(await search.search("bun", 5, running())).toEqual(ok("chatgpt:gpt-6-luna"));
  expect([searcher.calls, exa.calls, who.asked]).toEqual([["bun"], [], []]);
});

it("asks once before a keyless provider receives a search, and keeps the answer for the session", async () => {
  const exa = provider("exa", ok("exa"));
  const yes = operator("session");
  const path = config(undefined);
  const search = readWebSearch({ path, keyless: [exa, provider("parallel", ok("parallel"))], ask: yes.ask });
  expect(await search.search("bun", 5, running())).toEqual(ok("exa"));
  expect(await search.search("dafny", 5, running())).toEqual(ok("exa"));
  expect(yes.asked).toEqual([["Exa", "Parallel"]]);
  expect(exa.calls).toEqual(["bun", "dafny"]);
  expect(() => readFileSync(path)).toThrow();

  const silent = provider("exa", ok("exa"));
  const no = operator("no");
  const declined = readWebSearch({ path: config(undefined), keyless: [silent], ask: no.ask });
  expect(await declined.search("bun", 5, running())).toMatchObject({ status: "failed", error: "provider_not_configured",
    detail: expect.stringContaining("searcher role") });
  await declined.search("dafny", 5, running());
  expect([silent.calls, no.asked.length]).toEqual([[], 1]);
});

it("saves an answer of always, and asks nothing once keyless search is allowed or a keyless provider is pinned", async () => {
  const path = config(undefined);
  await readWebSearch({ path, keyless: [provider("exa", ok("exa"))], ask: operator("always").ask }).search("x", 5, running());
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ keyless: "allowed" });
  const later = operator("no");
  expect(await readWebSearch({ path, keyless: [provider("exa", ok("exa"))], ask: later.ask }).search("x", 5, running()))
    .toEqual(ok("exa"));
  const pinned = readWebSearch({ path: config(JSON.stringify({ search: "parallel" })), keyless: [provider("parallel", ok("parallel"))],
    ask: later.ask });
  expect(await pinned.search("x", 5, running())).toEqual(ok("parallel"));
  expect(later.asked).toEqual([]);
});

it("uses keyless search only when allowed where nobody can be asked, as in tesota run", async () => {
  const exa = provider("exa", ok("exa"));
  expect(await readWebSearch({ path: config(undefined), keyless: [exa] }).search("x", 5, running()))
    .toMatchObject({ status: "failed", error: "provider_not_configured" });
  expect(exa.calls).toEqual([]);
  expect(await readWebSearch({ path: config(JSON.stringify({ keyless: "allowed" })), keyless: [exa] }).search("x", 5, running()))
    .toEqual(ok("exa"));
});

it("moves on when a provider fails, naming each one tried", async () => {
  const search = readWebSearch({ path: config(JSON.stringify({ keyless: "allowed" })), hosted: hosted(failed("chatgpt: limit reached")),
    keyless: [provider("exa", failed("rate limited")), provider("parallel", ok("parallel"))] });
  expect(await search.search("x", 5, running())).toEqual(ok("parallel"));
  const none = readWebSearch({ path: config(JSON.stringify({ keyless: "allowed" })), hosted: hosted(failed("chatgpt: limit reached")),
    keyless: [provider("exa", failed("rate limited"))] });
  expect(await none.search("x", 5, running())).toEqual({ status: "failed", error: "provider_failed",
    detail: "hosted: chatgpt: limit reached; exa: rate limited" });
});

it("uses a pinned provider alone: it never falls back, and is not replaced when unavailable", async () => {
  const searcher = hosted(ok("chatgpt:gpt-6-luna"));
  const exa = provider("exa", failed("rate limited"));
  const parallel = provider("parallel", ok("parallel"));
  const pinned = readWebSearch({ path: config(JSON.stringify({ search: "exa" })), hosted: searcher, keyless: [exa, parallel] });
  expect(await pinned.search("x", 5, running())).toMatchObject({ status: "failed", error: "provider_failed" });
  expect([searcher.calls, parallel.calls]).toEqual([[], []]);
  expect(await readWebSearch({ path: config(JSON.stringify({ search: "hosted" })), keyless: [parallel] }).search("x", 5, running()))
    .toMatchObject({ status: "failed", error: "provider_not_configured", detail: expect.stringContaining("pinned") });
  expect(() => readWebSearch({ path: config(JSON.stringify({ searxng: "http://127.0.0.1:8888" })), keyless: [] })).toThrow("web.json");
  expect(() => readWebSearch({ path: config(JSON.stringify({ search: "bing" })), keyless: [] })).toThrow("web.json");
});

it("asks one question for searches that start at once", async () => {
  let release: (answer: KeylessAnswer) => void = () => undefined;
  let questions = 0;
  const search = readWebSearch({ path: config(undefined), keyless: [provider("exa", ok("exa"))],
    ask: () => { questions += 1; return new Promise((settle) => { release = settle; }); } });
  const both = Promise.all([search.search("a", 5, running()), search.search("b", 5, running())]);
  await Promise.resolve();
  release("session");
  expect((await both).map((outcome) => outcome.status)).toEqual(["ok", "ok"]);
  expect(questions).toBe(1);
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
