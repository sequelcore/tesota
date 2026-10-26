import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountUsage, bar, claudeCodeUsage, codexUsage, LAST_KNOWN_MS, pendingUsage, readUsage, span, type UsageAccount, usageFingerprint, usedHundredths,
  type UsageSources, windowLabel,
} from "../src/usage.ts";
import { chatgptUsage, claudeCodeReport, type StartUsageQuery } from "../src/usage-sources.ts";
import { filledSegments, meterTone, shownPercent } from "../src/usage-rule.ts";

/**
 * The usage panel's sources and readings (#184, #260): each source's reply
 * parsed, malformed ones included; the last-known fallback, its age and whom
 * it was read for; an underlying account read once; a round stopped. Nothing
 * here reaches the network or a real Claude Code.
 */
const file = (): string => join(mkdtempSync(join(tmpdir(), "tesota-usage-")), "usage.json");
const now = 2_000_000_000_000;
const claudeReport = { subscription_type: "max", rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 38, resets_at: "2033-05-18T03:33:20.000Z" },
  seven_day: { utilization: 71.4, resets_at: "2033-05-20T00:00:00.000Z" },
  seven_day_opus: null, seven_day_oauth_apps: { utilization: 5, resets_at: null } } };
const meters = (parsed: ReturnType<typeof claudeCodeUsage>) => "reading" in parsed ? parsed.reading.meters : parsed;

describe("Claude Code's usage report", () => {
  test("gives the 5-hour and weekly windows as the share left, with their resets and the plan", () => {
    expect(claudeCodeUsage(claudeReport)).toEqual({ reading: { plan: "max", notes: [], meters: [
      { label: "5h", hundredthsLeft: 6200, resetsAt: Date.parse("2033-05-18T03:33:20.000Z") },
      { label: "week", hundredthsLeft: 2860, resetsAt: Date.parse("2033-05-20T00:00:00.000Z") }] } });
  });
  test("holds a utilization outside 0 to 100 to it, and ignores a reset that is no date", () => {
    expect(meters(claudeCodeUsage({ rate_limits: { five_hour: { utilization: 130, resets_at: "soon" }, seven_day: { utilization: -4, resets_at: null } } })))
      .toEqual([{ label: "5h", hundredthsLeft: 0 }, { label: "week", hundredthsLeft: 10_000 }]);
  });
  test("a sign-in Claude Code says has no plan limits has none, which no earlier reading stands in for", () => {
    expect(claudeCodeUsage({ rate_limits: null, rate_limits_available: false })).toEqual({ none: "Claude Code reports no plan limits for this sign-in" });
    expect(claudeCodeUsage({ rate_limits_available: false })).toEqual({ none: "Claude Code reports no plan limits for this sign-in" });
  });
  test("a report, or its limits, of the wrong shape is unreadable, not an empty reading", () => {
    for (const bad of [undefined, null, "report", 7, [], {}, { rate_limits: [] }, { rate_limits: "x" }, { rate_limits: 3 },
      { rate_limits: [], rate_limits_available: false }, { rate_limits: null }]) {
      expect(claudeCodeUsage(bad)).toEqual({ unreadable: "Claude Code's usage report was not understood" });
    }
  });
  test("a window of the wrong shape makes the report unreadable; an absent or null window is left out", () => {
    for (const window of [{ utilization: "50" }, { utilization: null }, {}, [], 3, "x"]) {
      expect(claudeCodeUsage({ rate_limits: { five_hour: window } })).toEqual({ unreadable: "Claude Code's usage report was not understood" });
    }
    expect(meters(claudeCodeUsage({ rate_limits: { five_hour: null, seven_day: { utilization: 10 } } }))).toEqual([{ label: "week", hundredthsLeft: 9000 }]);
    expect(meters(claudeCodeUsage({ rate_limits: {} }))).toEqual([]);
  });
});

describe("Codex's usage reply", () => {
  const body = { plan_type: "plus", rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604_800, reset_at: 1_800_100_000 } },
  credits: { has_credits: true, balance: "5.00" } };
  test("labels each window by its own length and gives the share left, its reset and the credits", () => {
    expect(codexUsage(body)).toEqual({ reading: { plan: "plus", notes: ["5.00 credits"], meters: [
      { label: "5h", hundredthsLeft: 7000, resetsAt: 1_800_000_000_000 }, { label: "week", hundredthsLeft: 0, resetsAt: 1_800_100_000_000 }] } });
  });
  test("says unlimited credits, and names no credits that are not there", () => {
    const notes = (reply: unknown) => { const parsed = codexUsage(reply); return "reading" in parsed ? parsed.reading.notes : parsed; };
    expect(notes({ rate_limit: {}, credits: { unlimited: true } })).toEqual(["unlimited credits"]);
    expect(notes({ rate_limit: {}, credits: { has_credits: false, balance: "0" } })).toEqual([]);
  });
  test("a reply without a rate limit has none; one whose rate limit or reply is of the wrong shape is unreadable", () => {
    expect(codexUsage({ rate_limit: null })).toEqual({ none: "ChatGPT reports no limits for this sign-in" });
    expect(codexUsage({})).toEqual({ none: "ChatGPT reports no limits for this sign-in" });
    for (const bad of [undefined, null, "x", [], { rate_limit: [] }, { rate_limit: 3 }, { rate_limit: "x" }]) {
      expect(codexUsage(bad)).toEqual({ unreadable: "ChatGPT's usage reply was not understood" });
    }
  });
  test("a window of the wrong shape makes the reply unreadable; an absent or null window is left out", () => {
    for (const window of [{ used_percent: "30", limit_window_seconds: 18_000 }, { used_percent: 10 }, { used_percent: 10, limit_window_seconds: 0 }, [], 4]) {
      expect(codexUsage({ rate_limit: { primary_window: window } })).toEqual({ unreadable: "ChatGPT's usage reply was not understood" });
    }
    const parsed = codexUsage({ rate_limit: { primary_window: null, secondary_window: { used_percent: 25, limit_window_seconds: 604_800 } } });
    expect("reading" in parsed && parsed.reading.meters).toEqual([{ label: "week", hundredthsLeft: 7500 }]);
  });
  test("labels window lengths", () => {
    expect([18_000, 604_800, 86_400, 172_800, 1_800].map(windowLabel)).toEqual(["5h", "week", "day", "2 days", "30m"]);
  });
});

describe("the meter's text", () => {
  test("a bar is empty only when nothing is left and full only when nothing is used", () => {
    expect(bar(0, 10)).toBe("░".repeat(10));
    expect(bar(10_000, 10)).toBe("█".repeat(10));
    expect(bar(1, 10)).toBe(`█${"░".repeat(9)}`);
    expect(bar(9_999, 10)).toBe(`${"█".repeat(9)}░`);
  });
  test("a fraction is kept for the meter's decisions and rounded only for the printed percent (#5)", () => {
    // 99.6% used: 0.4% is left, which is neither empty nor in the error color.
    const nearlyOut = 10_000 - usedHundredths(99.6);
    expect(nearlyOut).toBe(40);
    expect(filledSegments(nearlyOut, 20)).toBe(1);
    expect(meterTone(nearlyOut)).toBe("low");
    expect(shownPercent(nearlyOut)).toBe(1);
    // 0.4% used: the bar is not full, and the percent does not say 100.
    const barelyUsed = 10_000 - usedHundredths(0.4);
    expect(barelyUsed).toBe(9_960);
    expect(filledSegments(barelyUsed, 20)).toBe(19);
    expect(shownPercent(barelyUsed)).toBe(99);
    // A sliver either side of an edge stays off it.
    expect([usedHundredths(0.001), usedHundredths(99.999), usedHundredths(0), usedHundredths(100), usedHundredths(-3), usedHundredths(140)])
      .toEqual([1, 9_999, 0, 10_000, 0, 10_000]);
  });
  test("a span reads as days and hours, hours and minutes, or minutes", () => {
    expect([25 * 60_000, 192 * 60_000, 3_000 * 60_000, -5].map(span)).toEqual(["25m", "3h 12m", "2d 2h", "0m"]);
  });
});

/** A signed-in Claude account; `null` for one whose identity is not known. */
const claude = (id: string, identity: string | null = `${id}@x.test`, extra: Partial<UsageAccount> = {}): UsageAccount =>
  ({ id, provider: "claude-code", signedIn: true, ...identity === null ? {} : { identity }, ...extra });
const sources = (over: Partial<UsageSources> = {}): UsageSources & { calls: string[]; signals: AbortSignal[] } => {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  return { calls, signals, claudeCode: async (folder, signal) => { calls.push(`claude ${folder ?? "default"}`); signals.push(signal); return claudeReport; },
    chatgpt: async (id, signal) => {
      calls.push(`chatgpt ${id}`);
      signals.push(signal);
      return { status: 200, body: { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } } };
    },
    ...over };
};
const failing = (problem = "Claude Code did not report its usage in time") => sources({ claudeCode: async () => { throw new Error(problem); } });

describe("reading the accounts' usage", () => {
  test("reads each account once and saves the readings with their time and a fingerprint of whom they are for, never the identity", async () => {
    const path = file();
    const seen: string[] = [];
    const work: UsageAccount = { id: "openai-codex@w", provider: "openai-codex", signedIn: true, identity: "chatgpt-account-1" };
    const usage = await readUsage([claude("claude-code@a", "a@x.test", { folder: "/f/a" }), work],
      sources(), { path, now: () => now, onEach: (each) => { seen.push(each.id); } });
    expect(usage.map((each) => each.state)).toEqual(["read", "read"]);
    expect(seen.sort()).toEqual(["claude-code@a", "openai-codex@w"]);
    const saved = readFileSync(path, "utf8");
    const parsed = JSON.parse(saved);
    expect(Object.keys(parsed)).toEqual(["claude-code@a", "openai-codex@w"]);
    expect(parsed["claude-code@a"].readAt).toBe(now);
    expect(parsed["claude-code@a"].who).toMatch(/^[0-9a-f]{64}$/u);
    expect(parsed["openai-codex@w"].who).toBe(usageFingerprint(work));
    expect(saved).not.toMatch(/token|secret|Bearer|a@x\.test|chatgpt-account-1/iu);
  });

  test("a failed read shows the last reading of the past hour, with its age and why", async () => {
    const path = file();
    await readUsage([claude("c")], sources(), { path, now: () => now });
    const usage = await readUsage([claude("c")], failing(), { path, now: () => now + 25 * 60_000 });
    expect(usage[0]).toMatchObject({ id: "c", state: "last_known", readAt: now, problem: "Claude Code did not report its usage in time" });
    expect(usage[0]?.state === "last_known" && usage[0].reading.meters).toHaveLength(2);
  });

  test("a reading older than the past hour is not shown, only why the read failed; a failure does not overwrite the saved reading", async () => {
    const path = file();
    await readUsage([claude("c")], sources(), { path, now: () => now });
    const usage = await readUsage([claude("c")], failing("boom"), { path, now: () => now + LAST_KNOWN_MS + 1 });
    expect(usage[0]).toEqual({ id: "c", state: "unavailable", problem: "boom" });
    expect(JSON.parse(readFileSync(path, "utf8")).c.readAt).toBe(now);
    const edge = await readUsage([claude("c")], failing("boom"), { path, now: () => now + LAST_KNOWN_MS });
    expect(edge[0]?.state).toBe("last_known");
  });

  test("a reading from the future never stands in, however near (#6)", async () => {
    const path = file();
    await readUsage([claude("c")], sources(), { path, now: () => now });
    for (const earlier of [1, 60_000, LAST_KNOWN_MS * 5]) {
      expect((await readUsage([claude("c")], failing("boom"), { path, now: () => now - earlier }))[0]).toEqual({ id: "c", state: "unavailable", problem: "boom" });
      expect(pendingUsage([claude("c")], { path, now: () => now - earlier })).toEqual([{ id: "c", state: "reading" }]);
    }
    expect(pendingUsage([claude("c")], { path, now: () => now })[0]).toMatchObject({ last: { readAt: now } });
  });

  test("a saved reading stands only for the sign-in it was read for, never another under the same name (#2)", async () => {
    const path = file();
    await readUsage([claude("claude-code@work", "first@x.test")], sources(), { path, now: () => now });
    const later = now + 60_000;
    const other = claude("claude-code@work", "second@x.test");
    expect(pendingUsage([other], { path, now: () => later })).toEqual([{ id: "claude-code@work", state: "reading" }]);
    expect((await readUsage([other], failing("boom"), { path, now: () => later }))[0]).toEqual({ id: "claude-code@work", state: "unavailable", problem: "boom" });
    // The same person, written otherwise, is the same sign-in.
    const same = claude("claude-code@work", "First@X.test");
    expect(pendingUsage([same], { path, now: () => later })[0]).toMatchObject({ last: { readAt: now } });
    expect((await readUsage([same], failing("boom"), { path, now: () => later }))[0]?.state).toBe("last_known");
  });

  test("an account whose identity is not known shows no saved reading, and its reading is not saved (#2)", async () => {
    const path = file();
    await readUsage([claude("c", "me@x.test")], sources(), { path, now: () => now });
    const unknown = claude("c", null);
    expect(pendingUsage([unknown], { path, now: () => now })).toEqual([{ id: "c", state: "reading" }]);
    expect((await readUsage([unknown], failing("boom"), { path, now: () => now }))[0]?.state).toBe("unavailable");
    const fresh = file();
    expect((await readUsage([unknown], sources(), { path: fresh, now: () => now }))[0]?.state).toBe("read");
    expect(() => readFileSync(fresh, "utf8")).toThrow();
  });

  test("a saved reading without whom it was read for, as an earlier file holds, is not shown", () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ c: { readAt: now, reading: { notes: [], meters: [{ label: "5h", hundredthsLeft: 5000 }] } } }));
    expect(pendingUsage([claude("c")], { path, now: () => now })).toEqual([{ id: "c", state: "reading" }]);
  });

  test("a reply of the wrong shape counts as a failed read: the last reading stands in and is not saved over (#4)", async () => {
    const path = file();
    await readUsage([claude("c")], sources(), { path, now: () => now });
    const before = readFileSync(path, "utf8");
    for (const reply of [{ rate_limits: [] }, { rate_limits: { five_hour: { utilization: "x" } } }]) {
      const usage = await readUsage([claude("c")], sources({ claudeCode: async () => reply }), { path, now: () => now + 60_000 });
      expect(usage[0]).toMatchObject({ state: "last_known", problem: "Claude Code's usage report was not understood" });
    }
    const codex: UsageAccount = { id: "openai-codex", provider: "openai-codex", signedIn: true, identity: "acct" };
    await readUsage([codex], sources(), { path, now: () => now });
    const usage = await readUsage([codex], sources({ chatgpt: async () => ({ status: 200, body: { rate_limit: [] } }) }), { path, now: () => now + 60_000 });
    expect(usage[0]).toMatchObject({ state: "last_known", problem: "ChatGPT's usage reply was not understood" });
    expect(JSON.parse(readFileSync(path, "utf8")).c).toEqual(JSON.parse(before).c);
  });

  test("limits a sign-in does not have are said, with no earlier reading standing in", async () => {
    const path = file();
    await readUsage([claude("c")], sources(), { path, now: () => now });
    const usage = await readUsage([claude("c")], sources({ claudeCode: async () => ({ rate_limits: null, rate_limits_available: false }) }),
      { path, now: () => now + 60_000 });
    expect(usage[0]).toEqual({ id: "c", state: "unavailable", problem: "Claude Code reports no plan limits for this sign-in" });
  });

  test("a read that takes too long counts as failed, without holding the others, and its source is told to stop", async () => {
    const told: AbortSignal[] = [];
    const slow = sources({ claudeCode: (_folder, signal) => { told.push(signal); return new Promise(() => undefined); } });
    const started = Date.now();
    const usage = await readUsage([claude("slow"), { id: "openai-codex", provider: "openai-codex", signedIn: true }], slow, { path: file(), limitMs: 30 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(usage[0]).toMatchObject({ id: "slow", state: "unavailable", problem: "the read took too long" });
    expect(usage[1]?.state).toBe("read");
    expect(told[0]?.aborted).toBe(true);
  });

  test("a round that is stopped stops its sources, tells no one of its readings and never writes the file (#3)", async () => {
    const path = file();
    const round = new AbortController();
    const told: AbortSignal[] = [];
    let finish = (): void => undefined;
    const held = sources({ claudeCode: (_folder, signal) => {
      told.push(signal);
      return new Promise((resolve) => { finish = () => { resolve(claudeReport); }; });
    } });
    const seen: AccountUsage[] = [];
    const reading = readUsage([claude("c"), { id: "openai-codex", provider: "openai-codex", signedIn: true, identity: "acct" }], held,
      { path, now: () => now, signal: round.signal, onEach: (each) => { seen.push(each); } });
    await Bun.sleep(5);
    round.abort();
    finish();
    const usage = await reading;
    expect(told[0]?.aborted).toBe(true);
    expect(usage[0]).toMatchObject({ state: "unavailable", problem: "the read was stopped" });
    expect(seen.filter((each) => each.id === "c")).toEqual([]);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  test("accounts on one underlying account are read once, and the others point to that reading", async () => {
    const path = file();
    const given = sources();
    const usage = await readUsage([claude("claude-code", "Me@X.test"), claude("claude-code@b", "me@x.test", { folder: "/f/b" }), claude("claude-code@c", "other@x.test")],
      given, { path, now: () => now });
    expect(given.calls).toEqual(["claude default", "claude default"]);
    expect(usage[1]).toMatchObject({ id: "claude-code@b", state: "read", sameAccountAs: "claude-code" });
    expect(usage[0]?.sameAccountAs).toBeUndefined();
    expect(usage[2]?.sameAccountAs).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(["claude-code", "claude-code@b", "claude-code@c"]);
  });

  test("accounts with no known identity are each read by themselves", async () => {
    const given = sources();
    await readUsage([claude("a", null), claude("b", null)], given, { path: file() });
    expect(given.calls).toHaveLength(2);
  });

  test("an account that is not signed in is not read; a refused or unexpected reply says why", async () => {
    const given = sources({ chatgpt: async (id) => id === "none" ? undefined : id === "refused" ? { status: 401, body: {} }
      : id === "down" ? { status: 500, body: {} } : { status: 200, body: "<html>" } });
    const codex = (id: string, signedIn = true): UsageAccount => ({ id, provider: "openai-codex", signedIn });
    const usage = await readUsage([claude("out", null, { signedIn: false }), codex("none"), codex("refused"), codex("down"), codex("html")], given, { path: file() });
    expect(usage.map((each) => each.state === "unavailable" ? each.problem : each.state)).toEqual(["not signed in", "not signed in",
      "sign-in refused (HTTP 401)", "usage request failed (HTTP 500)", "ChatGPT's usage reply was not understood"]);
    expect(given.calls).toEqual([]);
  });

  test("a provider other than these two reports no limits", async () => {
    const other = { id: "x", provider: "someone-else", signedIn: true } as unknown as UsageAccount;
    expect((await readUsage([other], sources(), { path: file() }))[0]).toEqual({ id: "x", state: "unavailable", problem: "reports no limits" });
  });

  test("the saved readings of the past hour for the same sign-in are there at once; older, damaged or missing ones are not", () => {
    const path = file();
    const reading = { notes: [], meters: [{ label: "5h", hundredthsLeft: 5000 }] };
    const who = (id: string) => usageFingerprint(claude(id));
    writeFileSync(path, JSON.stringify({ fresh: { readAt: now - 600_000, who: who("fresh"), reading }, old: { readAt: now - LAST_KNOWN_MS - 1, who: who("old"), reading },
      damaged: { readAt: now, who: who("damaged"), reading: { notes: [], meters: [{ label: 5 }] } },
      fraction: { readAt: now, who: who("fraction"), reading: { notes: [], meters: [{ label: "5h", hundredthsLeft: 50.5 }] } } }));
    const pending: AccountUsage[] = pendingUsage([claude("fresh"), claude("old"), claude("damaged"), claude("fraction"), claude("missing")], { path, now: () => now });
    expect(pending).toEqual([{ id: "fresh", state: "reading", last: { readAt: now - 600_000, reading } }, { id: "old", state: "reading" },
      { id: "damaged", state: "reading" }, { id: "fraction", state: "reading" }, { id: "missing", state: "reading" }]);
    writeFileSync(path, "{ not json");
    expect(pendingUsage([claude("fresh")], { path, now: () => now })).toEqual([{ id: "fresh", state: "reading" }]);
  });
});

describe("Claude Code's report, asked for", () => {
  const recorded = (report: unknown = claudeReport) => {
    const runs: { options: { env?: Record<string, string | undefined> } }[] = [];
    let closed = 0;
    const start: StartUsageQuery = (input) => {
      runs.push(input as never);
      return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => report, close: () => { closed += 1; } };
    };
    return { start, runs, closed: () => closed };
  };

  test("points Claude Code at the account's folder with CLAUDE_CONFIG_DIR alone, never changing HOME", async () => {
    const given = recorded();
    process.env["ANTHROPIC_API_KEY"] = "key-of-the-operator";
    try {
      expect(await claudeCodeReport("/accounts/claude/work", given.start)).toEqual(claudeReport);
    } finally { delete process.env["ANTHROPIC_API_KEY"]; }
    const env = given.runs[0]?.options.env ?? {};
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/accounts/claude/work");
    expect(env["HOME"]).toBe(process.env["HOME"]);
    expect(env["USERPROFILE"]).toBe(process.env["USERPROFILE"]);
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(Object.keys(env).filter((name) => env[name] !== process.env[name]).sort()).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CONFIG_DIR"]);
    expect(given.closed()).toBe(1);
  });

  test("the default account is asked with no folder set at all", async () => {
    const given = recorded();
    await claudeCodeReport(undefined, given.start);
    const env = given.runs[0]?.options.env ?? {};
    expect(Object.keys(env).filter((name) => env[name] !== process.env[name])).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP"]);
  });

  test("gives up after its time limit and still closes Claude Code", async () => {
    let closed = 0;
    const hung: StartUsageQuery = () => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined), close: () => { closed += 1; } });
    await expect(claudeCodeReport("/f", hung, 20)).rejects.toThrow("did not report its usage in time");
    expect(closed).toBe(1);
  });

  test("stops at once when told, closing Claude Code, and starts none when told before (#3)", async () => {
    let closed = 0;
    let started = 0;
    const hung: StartUsageQuery = () => {
      started += 1;
      return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined), close: () => { closed += 1; } };
    };
    const stop = new AbortController();
    const asked = claudeCodeReport("/f", hung, 60_000, stop.signal);
    await Bun.sleep(5);
    const at = Date.now();
    stop.abort();
    await expect(asked).rejects.toThrow("the read was stopped");
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(closed).toBe(1);
    await expect(claudeCodeReport("/f", hung, 60_000, stop.signal)).rejects.toThrow("the read was stopped");
    expect(started).toBe(1);
  });
});

describe("ChatGPT's usage endpoint, asked for", () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url");
  const token = `header.${claims}.signature`;
  const models = (apiKey: string | undefined) => ({ getAuth: async () => apiKey === undefined ? undefined : { auth: { apiKey } } }) as never;

  test("sends the account's token, read through pi-ai, to OpenAI's usage endpoint alone", async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await chatgptUsage(models(token), "openai-codex@w", fetcher)).toEqual({ status: 200, body: { rate_limit: {} } });
    expect(asked).toEqual([{ url: "https://chatgpt.com/backend-api/wham/usage",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "tesota", "ChatGPT-Account-Id": "acct-1" } }]);
  });

  test("has nothing to ask with when the account has no credential, and says when OpenAI cannot be reached or answers without JSON", async () => {
    const never = (async () => { throw new Error("no request"); }) as unknown as typeof fetch;
    expect(await chatgptUsage(models(undefined), "x", never)).toBeUndefined();
    await expect(chatgptUsage(models("t"), "x", never)).rejects.toThrow("could not reach chatgpt.com");
    const html = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    expect(await chatgptUsage(models("t"), "x", html)).toEqual({ status: 502, body: undefined });
  });

  test("cancels the request when told to stop, or when its time limit passes (#3)", async () => {
    const given: AbortSignal[] = [];
    const hanging = ((_url: string, init: { signal: AbortSignal }) => {
      given.push(init.signal);
      return new Promise((_, reject) => { init.signal.addEventListener("abort", () => { reject(new Error("aborted")); }); });
    }) as unknown as typeof fetch;
    const stop = new AbortController();
    const asked = chatgptUsage(models("t"), "x", hanging, 60_000, stop.signal);
    await Bun.sleep(5);
    stop.abort();
    await expect(asked).rejects.toThrow("the read was stopped");
    expect(given[0]?.aborted).toBe(true);
    await expect(chatgptUsage(models("t"), "x", hanging, 20)).rejects.toThrow("could not reach chatgpt.com");
    expect(given[1]?.aborted).toBe(true);
  });

  test("a sign-in refresh that never ends ends the read when told to stop or at the time limit, and nothing is requested", async () => {
    const refreshing = { getAuth: () => new Promise(() => undefined) } as never;
    const requested: string[] = [];
    const fetcher = (async (url: string) => { requested.push(url); return new Response("{}"); }) as unknown as typeof fetch;
    // A read still waiting a second after it should have ended fails here, rather than hanging the test.
    const within = (read: Promise<unknown>) => Promise.race([read, Bun.sleep(1_000).then(() => "still waiting")]);
    const stop = new AbortController();
    const closed = chatgptUsage(refreshing, "x", fetcher, 3_000, stop.signal);
    await Bun.sleep(5);
    stop.abort();
    await expect(within(closed)).rejects.toThrow("the read was stopped");
    await expect(within(chatgptUsage(refreshing, "x", fetcher, 30))).rejects.toThrow("the ChatGPT sign-in did not refresh in time");
    expect(requested).toEqual([]);
  });
});
