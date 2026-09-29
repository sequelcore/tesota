import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bar, claudeCodeUsage, codexUsage, LAST_KNOWN_MS, openCodeGoUsage, openRouterUsage, readUsage, runUsageCommand, span,
  usageTable, type UsageResponse, type UsageSources, windowLabel } from "../src/account-usage.js";
import { creditPercent, filledSegments, remainingPercent } from "../src/verification/usage-meter-rule.js";

const now = Date.parse("2026-09-29T15:00:00Z");
// A token shaped as Codex's, whose claims name its ChatGPT account.
const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url");
const codexToken = `TEST_HEADER.${claims}.TEST_SIGNATURE`;

/** Sources that answer as the providers did on 2026-09-29, recording what each request carried. */
function sources(answers: Readonly<Record<string, UsageResponse | Error>>, keys: Readonly<Record<string, string>> = {}) {
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
    userAgent: "tesota/test",
  };
  return { fake, requests };
}

const codexPlus = { plan_type: "plus", rate_limit: {
  primary_window: { used_percent: 0, limit_window_seconds: 18_000, reset_at: now / 1000 + 3 * 3600 + 420 },
  secondary_window: { used_percent: 33, limit_window_seconds: 604_800, reset_at: now / 1000 + 6 * 86_400 + 3600 },
}, credits: { has_credits: false, unlimited: false, balance: "0" } };

it("labels each window by its own length and turns the percent used into the percent left", () => {
  expect([18_000, 86_400, 604_800, 2_592_000, 5400].map(windowLabel)).toEqual(["5h", "day", "week", "30 days", "90m"]);
  expect(codexUsage(codexPlus)).toEqual({ plan: "plus", notes: [], meters: [
    { label: "5h", left: 100, resetsAt: now + (3 * 3600 + 420) * 1000 },
    { label: "week", left: 67, resetsAt: now + (6 * 86_400 + 3600) * 1000 }] });
  // A free account has one 30-day window and nothing else.
  expect(codexUsage({ plan_type: "free", rate_limit: { primary_window: { used_percent: 2, limit_window_seconds: 2_592_000,
    reset_at: 1 } }, credits: { has_credits: true, balance: "12.5" } }).meters.map((meter) => [meter.label, meter.left]))
    .toEqual([["30 days", 98]]);
  expect(codexUsage({ credits: { has_credits: true, balance: "12.5" } }).notes).toEqual(["12.5 credits"]);
  expect(codexUsage({ credits: { unlimited: true } }).notes).toEqual(["unlimited credits"]);
});

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
  expect(bar(60)).toBe("[████████████░░░░░░░░]");
  expect(bar(1)).toBe("[█░░░░░░░░░░░░░░░░░░░]");
  expect([90_000, 3 * 3_600_000 + 420_000, 6 * 86_400_000 + 3_600_000].map(span)).toEqual(["2m", "3h 7m", "6d 1h"]);
});

it("reads every route at once, sends each key only to its provider, and never shows or saves one", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  const path = join(folder, "usage.json");
  try {
    const { fake, requests } = sources({
      "https://chatgpt.com/backend-api/wham/usage": { status: 200, body: codexPlus },
      "claude:/claude/claude-2": { status: 200, body: { subscription_type: "pro", rate_limits: { seven_day: { utilization: 100 } } } },
      "https://openrouter.ai/api/v1/key": { status: 200, body: { data: { usage: 1.55, limit: 4, limit_remaining: 2.45 } } },
      "https://opencode.ai/zen/go/v1/usage": { status: 403, body: { type: "error" } },
    }, { codex: codexToken, openrouter: "TEST_OPENROUTER_KEY", opencode: "TEST_OPENCODE_KEY" });
    const usage = await readUsage([{ route: "codex", kind: "codex" }, { route: "codex-free1", kind: "codex" },
      { route: "claude-2", kind: "claude-code" }, { route: "openrouter", kind: "openrouter" }, { route: "opencode", kind: "opencode" },
      { route: "typesafe", kind: "typesafe" }], fake, path, () => now);
    expect(requests.map((request) => [request.url, request.headers["Authorization"]])).toEqual([
      ["https://chatgpt.com/backend-api/wham/usage", `Bearer ${codexToken}`],
      ["https://openrouter.ai/api/v1/key", "Bearer TEST_OPENROUTER_KEY"],
      ["https://opencode.ai/zen/go/v1/usage", "Bearer TEST_OPENCODE_KEY"]]);
    expect(requests[0]?.headers["ChatGPT-Account-Id"]).toBe("account-1");
    const table = usageTable(usage, now);
    expect(table.split("\n").slice(0, 3)).toEqual(["codex  Codex · plus",
      "  5h         [████████████████████] 100% left · resets in 3h 7m",
      "  week       [█████████████░░░░░░░]  67% left · resets in 6d 1h"]);
    expect(table).toContain("codex-free1  Codex\n  signed out: tesota auth login codex-free1\n");
    expect(table).toContain("claude-2  Claude Code · pro\n  week       [░░░░░░░░░░░░░░░░░░░░]   0% left\n");
    expect(table).toContain("  key limit  [████████████░░░░░░░░]  61% left · $2.45 of $4.00 left\n");
    expect(table).toContain("opencode  OpenCode\n  no OpenCode Go subscription\n  Zen's balance: see opencode.ai\n");
    expect(table).toContain("typesafe  TypeSafe\n  no usage source: see console.typesafe.ai/settings/billing\n");
    const saved = await readFile(path, "utf8");
    expect(Object.keys(JSON.parse(saved) as object).sort()).toEqual(["claude-2", "codex", "opencode", "openrouter"]);
    expect(`${table}${saved}`).not.toMatch(/TEST_|account-1/u);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("shows the last reading of the past hour with its age when a read fails, and unknown after that", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  const path = join(folder, "usage.json");
  const route = [{ route: "claude-code", kind: "claude-code" }];
  const report = { subscription_type: "pro", rate_limits: { five_hour: { utilization: 69 } } };
  try {
    await readUsage(route, sources({ "claude:default": { status: 200, body: report } }).fake, path, () => now);
    const limited = sources({ "claude:default": { status: 200, body: { rate_limits: null } } }).fake;
    const later = now + 25 * 60_000;
    const [known] = await readUsage(route, limited, path, () => later);
    expect(usageTable(known === undefined ? [] : [known], later).split("\n").slice(0, 3)).toEqual(["claude-code  Claude Code · pro",
      "  last known, 25m ago: Claude Code reports no plan limits for this sign-in; tesota auth status claude-code shows its sign-in",
      "  5h  [██████░░░░░░░░░░░░░░]  31% left"]);
    const [stale] = await readUsage(route, sources({ "claude:default": new Error("could not reach claude.ai") }).fake, path,
      () => now + LAST_KNOWN_MS + 1);
    expect(stale).toEqual({ route: "claude-code", kind: "claude-code", state: "unavailable", problem: "unknown: could not reach claude.ai" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("names a refused sign-in, and refuses a route it does not know", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tesota-usage-"));
  try {
    const { fake } = sources({ "https://openrouter.ai/api/v1/key": { status: 401, body: undefined } }, { openrouter: "TEST_KEY" });
    const [refused] = await readUsage([{ route: "openrouter", kind: "openrouter" }], fake, join(folder, "usage.json"), () => now);
    expect(refused).toMatchObject({ state: "unavailable", problem: "unknown: sign-in refused (HTTP 401): tesota auth login openrouter" });
    let written = "";
    expect(await runUsageCommand(["no-such-route"], (text) => { written += text; }, fake, join(folder, "usage.json"))).toBe(2);
    expect(written).toMatch(/^Usage: tesota usage \[codex\|/u);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
