import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bar, claudeCodeUsage, LAST_KNOWN_MS, openCodeGoUsage, openRouterUsage, pendingUsage, readUsage,
  runUsageCommand, span, usageLines, usageTable, type UsageResponse, type UsageSources } from "../src/account-usage.js";
import { creditPercent, filledSegments, meterTone, remainingPercent } from "../src/verification/usage-meter-rule.js";

const now = Date.parse("2026-09-29T15:00:00Z");
/** Sources that answer as the providers did on 2026-09-29, recording what each request carried. */
function sources(answers: Readonly<Record<string, UsageResponse | Error>>, keys: Readonly<Record<string, string>> = {},
  accounts: Readonly<Record<string, string>> = {}) {
  const requests: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const answer = (url: string): UsageResponse => {
    const found = answers[url];
    if (found instanceof Error) throw found;
    if (found === undefined) throw new Error(`unexpected ${url}`);
    return found;
  };
  const fake: UsageSources = {
    key: async (route) => keys[route],
    get: async (url, headers) => { requests.push({ url, headers }); return answer(url); },
    claudeCode: async (directory) => answer(`claude:${directory ?? "default"}`).body,
    claudeCodeDirectory: (route) => `/claude/${route}`,
    account: async (route) => accounts[route],
    userAgent: "tesota/test",
  };
  return { fake, requests };
}

it("reads Claude Code's plan windows and ignores the entries it does not name", () => {
  expect(claudeCodeUsage({ subscription_type: "pro", rate_limits: {
    five_hour: { utilization: 69.4, resets_at: "2026-09-29T18:40:00Z" },
    seven_day: { utilization: 22, resets_at: null }, seven_day_sonnet: null, codename_window: { utilization: 90 },
  } })).toEqual({ reading: { plan: "pro", notes: [], meters: [
    { label: "5h", left: 31, resetsAt: Date.parse("2026-09-29T18:40:00Z") }, { label: "week", left: 78 }] } });
  expect(claudeCodeUsage({ subscription_type: null, rate_limits: null })).toEqual({ none: "Claude Code reports no plan limits for this sign-in" });
});

it("draws a key's credit limit as a meter, and a key without one as what it has used", () => {
  expect(openRouterUsage({ data: { usage: 1.55, limit: 4, limit_remaining: 2.45, limit_reset: null } })).toEqual({ notes: [],
    meters: [{ label: "key limit", left: 61, amount: "$2.45 of $4.00 left" }] });
  expect(openRouterUsage({ data: { usage: 3, limit: 10, limit_remaining: 7, limit_reset: "monthly" } }).meters[0]?.label).toBe("monthly limit");
  expect(openRouterUsage({ data: { usage: 4.1234, limit: null, limit_remaining: null } }))
    .toEqual({ meters: [], notes: ["$4.12 used; the key has no limit"] });
  expect(openCodeGoUsage({ usage: { rolling: { status: "ok", percent: 12, resetsAt: "2026-09-29T17:00:00Z" },
    weekly: { status: "ok", percent: 40, resetsAt: "2026-10-02T00:00:00Z" }, monthly: { status: "rate-limited", percent: 100,
      resetsAt: "2026-10-15T00:00:00Z" } } }).meters.map((meter) => [meter.label, meter.left])).toEqual([["rolling", 88], ["week", 60], ["month", 0]]);
});

it("keeps a bar empty only when nothing is left and full only when nothing is used", () => {
  expect(remainingPercent(-5)).toBe(100);
  expect(remainingPercent(140)).toBe(0);
  expect(creditPercent(245, 400)).toBe(61);
  expect(creditPercent(399, 400)).toBe(99);
  expect([0, 1, 2, 50, 97, 99, 100].map((left) => filledSegments(left, 20))).toEqual([0, 1, 1, 10, 19, 19, 20]);
  expect(bar(60)).toBe("████████████░░░░░░░░");
  expect(bar(1)).toBe("█░░░░░░░░░░░░░░░░░░░");
  expect(bar(1, 10)).toBe("█░░░░░░░░░");
  expect([0, 1, 25, 26, 100].map(meterTone)).toEqual(["out", "low", "low", "ok", "ok"]);
  expect([90_000, 3 * 3_600_000 + 420_000, 6 * 86_400_000 + 3_600_000].map(span)).toEqual(["2m", "3h 7m", "6d 1h"]);
});

it("reads every route at once, sends each key only to its provider, and never shows or saves one", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  const path = join(folder, "usage.json");
  try {
    const { fake, requests } = sources({
      "claude:/claude/claude-2": { status: 200, body: { subscription_type: "pro", rate_limits: { seven_day: { utilization: 100 } } } },
      "https://openrouter.ai/api/v1/key": { status: 200, body: { data: { usage: 1.55, limit: 4, limit_remaining: 2.45 } } },
      "https://opencode.ai/zen/go/v1/usage": { status: 403, body: { type: "error" } },
    }, { chatgpt: "TEST_CHATGPT_TOKEN", openrouter: "TEST_OPENROUTER_KEY", opencode: "TEST_OPENCODE_KEY" });
    const arrived: string[] = [];
    const usage = await readUsage([{ route: "chatgpt", kind: "chatgpt" }, { route: "claude-2", kind: "claude-code" },
      { route: "openrouter", kind: "openrouter" }, { route: "opencode", kind: "opencode" }, { route: "typesafe", kind: "typesafe" }],
    fake, { path, now: () => now, onEach: (one) => { arrived.push(one.route); } });
    expect(arrived.sort()).toEqual(["chatgpt", "claude-2", "opencode", "openrouter", "typesafe"]);
    // Sign in with ChatGPT has no usage source, so its token is never sent anywhere to read one.
    expect(requests.map((request) => [request.url, request.headers["Authorization"]])).toEqual([
      ["https://openrouter.ai/api/v1/key", "Bearer TEST_OPENROUTER_KEY"],
      ["https://opencode.ai/zen/go/v1/usage", "Bearer TEST_OPENCODE_KEY"]]);
    const table = usageTable(usage, now);
    expect(table.split("\n")).toEqual([
      "Route       Account          Window     Left                       Details",
      "chatgpt     ChatGPT          no usage source for Sign in with ChatGPT: see ChatGPT's settings, Usage",
      "claude-2    Claude Code pro  week       ░░░░░░░░░░░░░░░░░░░░   0%",
      "openrouter  OpenRouter       key limit  ████████████░░░░░░░░  61%  $2.45 of $4.00 left",
      "opencode    OpenCode         no OpenCode Go subscription",
      "                             Zen's balance: see opencode.ai",
      "typesafe    TypeSafe         no usage source: see console.typesafe.ai/settings/billing",
      "",
      "Claude Code's usage comes from an experimental report, which may change.",
      ""]);
    // On a width, a note wraps beneath its own column, so its link is never cut.
    expect(usageLines(usage.slice(-1), now, { width: 60 })).toEqual([
      "Route     Account   Window  Left  Details",
      "typesafe  TypeSafe  no usage source: see",
      "                    console.typesafe.ai/settings/billing"]);
    const saved = await readFile(path, "utf8");
    expect(Object.keys(JSON.parse(saved) as object).sort()).toEqual(["claude-2", "opencode", "openrouter"]);
    expect(`${table}${saved}`).not.toMatch(/TEST_/u);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("shows the last reading of the past hour with its age when a read fails, and unknown after that", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  const path = join(folder, "usage.json");
  const route = [{ route: "claude-code", kind: "claude-code" }];
  const report = { subscription_type: "pro", rate_limits: { five_hour: { utilization: 69 } } };
  try {
    expect(pendingUsage(route, { path, now: () => now })).toEqual([{ route: "claude-code", kind: "claude-code", state: "reading" }]);
    await readUsage(route, sources({ "claude:default": { status: 200, body: report } }).fake, { path, now: () => now });
    const limited = sources({ "claude:default": { status: 200, body: { rate_limits: null } } }).fake;
    const later = now + 25 * 60_000;
    // While a route is read again, its saved reading shows at once, faded, with no line of its own.
    const [pending] = pendingUsage(route, { path, now: () => later });
    expect(pending).toMatchObject({ state: "reading", last: { readAt: now } });
    expect(usageLines(pending === undefined ? [] : [pending], later).slice(1)).toEqual(["claude-code  Claude Code pro  5h      ██████░░░░░░░░░░░░░░  31%"]);
    const [known] = await readUsage(route, limited, { path, now: () => later });
    expect(usageLines(known === undefined ? [] : [known], later).slice(1)).toEqual([
      "claude-code  Claude Code pro  5h      ██████░░░░░░░░░░░░░░  31%",
      "                              last known, 25m ago: Claude Code reports no plan limits for this sign-in; tesota auth status " +
      "claude-code shows its sign-in"]);
    const [stale] = await readUsage(route, sources({ "claude:default": new Error("could not reach claude.ai") }).fake,
      { path, now: () => now + LAST_KNOWN_MS + 1 });
    expect(stale).toEqual({ route: "claude-code", kind: "claude-code", state: "unavailable", problem: "unknown: could not reach claude.ai" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("names a refused sign-in, and refuses a route it does not know", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  try {
    const { fake } = sources({ "https://openrouter.ai/api/v1/key": { status: 401, body: undefined } }, { openrouter: "TEST_KEY" });
    const [refused] = await readUsage([{ route: "openrouter", kind: "openrouter" }], fake, { path: join(folder, "usage.json"), now: () => now });
    expect(refused).toMatchObject({ state: "unavailable", problem: "unknown: sign-in refused (HTTP 401): tesota auth login openrouter" });
    let written = "";
    expect(await runUsageCommand(["no-such-route"], (text) => { written += text; }, fake, { path: join(folder, "usage.json") })).toBe(2);
    expect(written).toMatch(/^Usage: tesota usage \[chatgpt\|/u);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("reads an account once through its first route, and every route on it shows that one reading", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  const path = join(folder, "usage.json");
  // claude-code and claude-2 are signed in to one claude.ai account; chatgpt-free1's has no usage source.
  const routes = [{ route: "claude-code", kind: "claude-code" }, { route: "chatgpt-free1", kind: "chatgpt" },
    { route: "claude-2", kind: "claude-code" }];
  const accounts = { "claude-code": "45e4b49f", "claude-2": "45e4b49f" };
  const report = { subscription_type: "max", rate_limits: { five_hour: { utilization: 40 } } };
  try {
    const asked: string[] = [];
    const { fake } = sources({ "claude:default": { status: 200, body: report } }, {}, accounts);
    const counted = { ...fake, claudeCode: async (directory: string | undefined) => { asked.push(directory ?? "default"); return fake.claudeCode(directory); } };
    const arrived: string[] = [];
    const usage = await readUsage(routes, counted, { path, now: () => now, onEach: (one) => { arrived.push(one.route); } });
    expect(asked).toEqual(["default"]);
    expect(arrived.sort()).toEqual(["chatgpt-free1", "claude-2", "claude-code"]);
    expect(usage[2]).toMatchObject({ route: "claude-2", kind: "claude-code", state: "read", sameAccountAs: "claude-code",
      reading: { plan: "max", meters: [{ label: "5h", left: 60 }] } });
    expect(usage[0]?.sameAccountAs).toBeUndefined();
    expect(usageLines(usage, now).slice(1)).toEqual([
      "claude-code    Claude Code max  5h      ████████████░░░░░░░░  60%",
      "chatgpt-free1  ChatGPT          no usage source for Sign in with ChatGPT: see ChatGPT's settings, Usage",
      "claude-2       Claude Code max  same account as claude-code: one reading, above"]);
    // Saved under both routes, so a later failed read of either shows the same last reading.
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")) as object).sort()).toEqual(["claude-2", "claude-code"]);
    const failing = sources({ "claude:default": new Error("could not reach claude.ai") }, {}, accounts).fake;
    const later = await readUsage(routes, failing, { path, now: () => now + 10 * 60_000 });
    expect(later[0]).toMatchObject({ state: "last_known", readAt: now });
    expect(later[2]).toMatchObject({ state: "last_known", readAt: now, sameAccountAs: "claude-code" });
    // An account that cannot be read leaves each route to be read by itself.
    const unknown = sources({ "claude:default": { status: 200, body: report }, "claude:/claude/claude-2": { status: 200, body: report } }).fake;
    expect((await readUsage(routes, { ...unknown, account: async () => { throw new Error("unreadable"); } }, { path, now: () => now }))
      .map((entry) => entry.sameAccountAs)).toEqual([undefined, undefined, undefined]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
