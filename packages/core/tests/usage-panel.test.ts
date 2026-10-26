import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import type { AccountRow } from "../src/accounts.ts";
import { type UsageActions, UsagePanel, type UsageTab, type UsageView } from "../src/shell/usage-panel.ts";
import type { AccountUsage, UsageReading } from "../src/usage.ts";
import { bar } from "../src/usage.ts";
import { shownPercent } from "../src/usage-rule.ts";
import { shellTheme } from "../../../src/theme.ts";

/**
 * The usage panel (#184, #260): the tab each command opens, switching tabs,
 * the session's account marked, a narrow terminal, and a failed read. It is
 * given its accounts and readings, so nothing here reads one.
 */
const now = 10_000_000_000;
const theme = shellTheme("dark", "truecolor");
const reading = (...left: number[]): UsageReading => ({ plan: "max", notes: [], meters: left.map((each, index) =>
  ({ label: index === 0 ? "5h" : "week", hundredthsLeft: Math.round(each * 100), resetsAt: now + (index === 0 ? 192 : 3_000) * 60_000 })) });
/** A meter's segments and printed percent for this percent left, as the panel draws them at full width. */
const drawn = (percent: number): string => `${bar(Math.round(percent * 100), 20)} ${String(shownPercent(Math.round(percent * 100))).padStart(3)}%`;
const accounts: readonly AccountRow[] = [
  { id: "claude-code", provider: "claude-code", label: "me@x.test", signedIn: true, identity: "me@x.test", default: true },
  { id: "claude-code@work", provider: "claude-code", label: "me@x.test · same account as claude-code", signedIn: true, identity: "me@x.test", folder: "/f/work" },
  { id: "openai-codex@pro", provider: "openai-codex", label: "not signed in", signedIn: false },
];

/** OpenAI not signed in with ChatGPT. */
const noOpenAI = async (): Promise<boolean> => false;

function panel({ tab = "usage", session = "claude-code@work", usage = {} as Record<string, AccountUsage>, rows = 40, list = accounts, hold = false, openai = false }:
  { tab?: UsageTab; session?: string; usage?: Record<string, AccountUsage>; rows?: number; list?: readonly AccountRow[]; hold?: boolean;
    /** OpenAI signed in with ChatGPT. */
    openai?: boolean } = {}) {
  const calls: string[] = [];
  let release = (): void => undefined;
  const view: UsageView = {
    accounts: async (_signal, onUpdate) => { onUpdate(list); return list; },
    pending: (rowsGiven) => rowsGiven.map(({ id }) => ({ id, state: "reading" as const })),
    read: async (_rows, onEach) => {
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      for (const each of Object.values(usage)) onEach(each);
    },
    openaiChatGPT: async () => openai,
  };
  const actions: UsageActions = { close: () => { calls.push("close"); }, manage: (id) => { calls.push(`manage ${id}`); }, add: () => { calls.push("add"); } };
  const view2 = new UsagePanel({ theme, view, actions, tab, session: () => session, rows: () => rows, redraw: () => { calls.push("redraw"); }, now: () => now });
  return { panel: view2, calls, release: () => { release(); } };
}
const text = (view: UsagePanel, width = 100): string[] => view.render(width).map(stripTerminalSequences);
const screen = (view: UsagePanel, width = 100): string => text(view, width).join("\n");
const lineOf = (view: UsagePanel, needle: string, width = 100): string => text(view, width).find((line) => line.includes(needle)) ?? "";
const full = { "claude-code": { id: "claude-code", state: "read", reading: reading(62, 29) },
  "claude-code@work": { id: "claude-code@work", state: "read", sameAccountAs: "claude-code", reading: reading(62, 29) },
  "openai-codex@pro": { id: "openai-codex@pro", state: "unavailable", problem: "not signed in" } } as const satisfies Record<string, AccountUsage>;

describe("the usage panel", () => {
  test("starts with its tabs row, the open tab bracketed on the selected background and the other muted, and opens on the tab its command names", async () => {
    for (const tab of ["usage", "accounts"] as const) {
      const { panel: opened } = panel({ tab, usage: full });
      await opened.start();
      expect(opened.tab).toBe(tab);
      const lines = text(opened);
      // The dialog's frame gives the title, once: the panel starts with its tabs.
      expect(lines[0]).toMatch(tab === "usage" ? /^\[ Usage \] +Accounts/u : /^ +Usage +\[ Accounts \]/u);
      expect(lines.filter((line) => /^ *Usage *$/u.test(line))).toEqual([]);
      const raw = opened.render(100)[0] ?? "";
      const open = tab === "usage" ? "[ Usage ]" : "[ Accounts ]";
      expect(raw).toContain(theme.bg("selectedBg", theme.bold(theme.fg("text", open))));
      expect(raw).toContain(theme.fg("muted", tab === "usage" ? "  Accounts  " : "  Usage  "));
      // The hint is the last row.
      expect(lines.slice(-2).join(" ")).toMatch(/Esc\s+close$/u);
      expect(screen(opened)).toContain(tab === "usage" ? "resets in 3h 12m" : "Enter sign in again or remove");
      expect(screen(opened)).not.toContain(tab === "usage" ? "Enter sign in again" : "resets in");
    }
  });

  test("Tab, ← and → switch between the tabs, and Esc closes", async () => {
    const { panel: opened, calls } = panel({ usage: full });
    await opened.start();
    for (const [key, expected] of [["\t", "accounts"], ["\t", "usage"], ["\x1b[C", "accounts"], ["\x1b[D", "usage"], ["\x1b[Z", "accounts"], ["\x1b[D", "usage"]] as const) {
      opened.handleInput(key);
      expect(opened.tab).toBe(expected);
    }
    opened.handleInput("\x1b");
    expect(calls).toContain("close");
  });

  test("the Usage tab draws a row per window: label, segments of the share left with its percent, and when it resets", async () => {
    const { panel: opened } = panel({ usage: full });
    await opened.start();
    const five = lineOf(opened, "5h");
    expect(five).toContain(drawn(62));
    expect(five).toContain("resets in 3h 12m");
    expect(lineOf(opened, "week")).toContain(drawn(29));
    expect(lineOf(opened, "week")).toContain("resets in 2d 2h");
    expect(screen(opened)).toContain("experimental usage report");
    expect(screen(opened)).toContain("same account as claude-code: one reading, above");
    expect(screen(opened)).toContain("not signed in");
  });

  test("a meter is in the warning color at a quarter left and the error color when nothing is left", async () => {
    const usage = { "claude-code": { id: "claude-code", state: "read", reading: reading(26, 25) } } as const;
    const { panel: opened } = panel({ usage, list: accounts.slice(0, 1) });
    await opened.start();
    const raw = opened.render(100).join("\n");
    expect(raw).toContain(theme.fg("accent", drawn(26)));
    expect(raw).toContain(theme.fg("warning", drawn(25)));
    const { panel: empty } = panel({ usage: { "claude-code": { id: "claude-code", state: "read", reading: reading(0, 100) } }, list: accounts.slice(0, 1) });
    await empty.start();
    expect(empty.render(100).join("\n")).toContain(theme.fg("error", drawn(0)));
    expect(empty.render(100).join("\n")).toContain(theme.fg("accent", drawn(100)));
  });

  test("marks the session's own account in both tabs", async () => {
    const { panel: opened } = panel({ usage: full });
    await opened.start();
    expect(lineOf(opened, "claude-code@work")).toContain("this session");
    expect(lineOf(opened, "claude-code ")).not.toContain("this session");
    expect(text(opened).filter((line) => line.includes("this session"))).toHaveLength(1);
    opened.handleInput("\t");
    expect(lineOf(opened, "claude-code@work")).toContain("this session");
    expect(text(opened).filter((line) => line.includes("this session"))).toHaveLength(1);
  });

  test("the Accounts tab lists each account with its provider and sign-in, the email when given, and the command to run", async () => {
    const { panel: opened } = panel({ tab: "accounts", usage: full });
    await opened.start();
    const shown = screen(opened);
    expect(shown).toContain("claude-code (default)");
    expect(shown).toContain("Claude Code · signed in as me@x.test");
    expect(shown).toContain("/f/work");
    expect(shown).toContain("ChatGPT · not signed in");
    // The chosen account is the first, a default sign-in the provider's own.
    expect(shown).toContain("sign in with Claude Code");
    opened.handleInput("\x1b[B");
    opened.handleInput("\x1b[B");
    expect(screen(opened)).toContain("From a terminal: tesota accounts login openai-codex@pro");
  });

  test("Enter on a declared account asks to sign it in again or remove it; a default sign-in is not managed; a adds", async () => {
    const { panel: opened, calls } = panel({ tab: "accounts" });
    await opened.start();
    opened.handleInput("\r");
    expect(calls.filter((call) => call.startsWith("manage"))).toEqual([]);
    opened.handleInput("\x1b[B");
    opened.handleInput("\r");
    opened.handleInput("\x1b[B");
    opened.handleInput("\r");
    opened.handleInput("\x1b[B");
    opened.handleInput("\r");
    opened.handleInput("a");
    expect(calls.filter((call) => call !== "redraw")).toEqual(["manage claude-code@work", "manage openai-codex@pro", "manage openai-codex@pro", "add"]);
  });

  test("opens at once with the saved readings, faded and with their age, and replaces each as it is read", async () => {
    const saved: AccountUsage = { id: "claude-code", state: "reading", last: { readAt: now - 25 * 60_000, reading: reading(40, 10) } };
    const { panel: opened, release } = panel({ usage: { "claude-code": full["claude-code"] }, hold: true, list: accounts.slice(0, 1) });
    const open = opened.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen(opened)).toContain("reading…");
    // A saved reading, as pendingUsage gives it.
    const withSaved = new UsagePanel({ theme, view: { accounts: async () => accounts.slice(0, 1), pending: () => [saved],
      read: () => new Promise(() => undefined), openaiChatGPT: noOpenAI }, actions: { close() {}, manage() {}, add() {} }, session: () => undefined, rows: () => 40, redraw() {}, now: () => now });
    void withSaved.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen(withSaved)).toContain("saved 25m ago, reading…");
    expect(lineOf(withSaved, "5h")).toContain(drawn(40));
    expect(withSaved.render(100).join("\n")).toContain(theme.fg("dim", drawn(40)));
    release();
    await open;
    expect(lineOf(opened, "5h")).toContain(drawn(62));
    expect(screen(opened)).not.toContain("reading…");
  });

  test("a failed read shows the last reading with its age and why; with none, only why", async () => {
    const usage = {
      "claude-code": { id: "claude-code", state: "last_known", reading: reading(55, 44), readAt: now - 25 * 60_000, problem: "Claude Code did not report its usage in time" },
      "claude-code@work": { id: "claude-code@work", state: "unavailable", problem: "sign-in refused (HTTP 401)" },
    } as const satisfies Record<string, AccountUsage>;
    const { panel: opened } = panel({ usage, list: accounts.slice(0, 2) });
    await opened.start();
    const shown = screen(opened);
    expect(shown).toContain("last known, 25m ago: Claude Code did not report its usage in time");
    expect(lineOf(opened, "5h")).toContain("55%");
    expect(opened.render(100).join("\n")).toContain(theme.fg("dim", drawn(55)));
    expect(shown).toContain("sign-in refused (HTTP 401)");
  });

  test("when the accounts cannot be listed it says so, and r tries again", async () => {
    let attempts = 0;
    const opened = new UsagePanel({ theme, actions: { close() {}, manage() {}, add() {} }, session: () => undefined, rows: () => 40, redraw() {}, now: () => now,
      view: { accounts: async () => { attempts += 1; if (attempts === 1) throw new Error("settings are unreadable"); return accounts.slice(0, 1); },
        pending: (given) => given.map(({ id }) => ({ id, state: "reading" as const })), read: async () => undefined, openaiChatGPT: noOpenAI } });
    await opened.start();
    expect(screen(opened)).toContain("The accounts could not be read: settings are unreadable");
    opened.handleInput("r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen(opened)).not.toContain("could not be read");
    expect(attempts).toBe(2);
  });

  test("a window nearly used up is neither empty nor in the error color, and one barely used is not full (#5)", async () => {
    const usage = { "claude-code": { id: "claude-code", state: "read", reading: reading(0.4, 99.6) } } as const;
    const { panel: opened } = panel({ usage, list: accounts.slice(0, 1) });
    await opened.start();
    const five = lineOf(opened, "5h");
    expect(five).toContain(`█${"░".repeat(19)}   1%`);
    expect(lineOf(opened, "week")).toContain(`${"█".repeat(19)}░  99%`);
    const raw = opened.render(100).join("\n");
    expect(raw).toContain(theme.fg("warning", `█${"░".repeat(19)}   1%`));
    expect(raw).not.toContain(theme.fg("error", `█${"░".repeat(19)}`));
  });

  test("lists the accounts and their saved readings at once, and fills in each sign-in as its check returns (#1)", async () => {
    const checking = accounts.map((row) => ({ ...row, signedIn: false, label: "checking sign-in…", checking: true as const })) as AccountRow[];
    let update = (_rows: readonly AccountRow[]): void => undefined;
    let finish = (): void => undefined;
    const saved: AccountUsage = { id: "claude-code", state: "reading", last: { readAt: now - 5 * 60_000, reading: reading(80) } };
    const opened = new UsagePanel({ theme, actions: { close() {}, manage() {}, add() {} }, session: () => undefined, rows: () => 40, redraw() {}, now: () => now,
      view: {
        accounts: (_signal, onUpdate) => { update = onUpdate; onUpdate(checking); return new Promise((resolve) => { finish = () => { resolve(accounts); }; }); },
        // As pendingUsage does: a saved reading only for an account whose sign-in is known.
        pending: (rows) => rows.map(({ id, identity }) => id === "claude-code" && identity !== undefined ? saved : { id, state: "reading" as const }),
        read: () => new Promise(() => undefined), openaiChatGPT: noOpenAI } });
    void opened.start();
    // Before any check returns: every account is there, its sign-in being checked.
    expect(screen(opened)).not.toContain("Reading the accounts");
    expect(screen(opened)).toContain("claude-code@work");
    expect(screen(opened)).toContain("checking sign-in…");
    // One check returns: that account's saved reading shows, while the rest are still checked.
    update([accounts[0] as AccountRow, ...checking.slice(1)]);
    expect(lineOf(opened, "5h")).toContain(drawn(80));
    expect(screen(opened)).toContain("checking sign-in…");
    opened.handleInput("\t");
    expect(screen(opened)).toContain("Claude Code · signed in as me@x.test");
    expect(screen(opened)).toContain("Claude Code · checking sign-in…");
    finish();
    await Bun.sleep(0);
    expect(screen(opened)).not.toContain("checking sign-in…");
  });

  test("closing stops the round's checks and reads; r stops the one going, and its late readings are not shown (#3)", async () => {
    const signals: AbortSignal[] = [];
    const late: ((usage: AccountUsage) => void)[] = [];
    const opened = new UsagePanel({ theme, actions: { close() {}, manage() {}, add() {} }, session: () => undefined, rows: () => 40, redraw() {}, now: () => now,
      view: {
        accounts: async (signal, onUpdate) => { signals.push(signal); onUpdate(accounts.slice(0, 1)); return accounts.slice(0, 1); },
        pending: (rows) => rows.map(({ id }) => ({ id, state: "reading" as const })),
        read: (_rows, onEach, signal) => { signals.push(signal); late.push(onEach); return new Promise(() => undefined); }, openaiChatGPT: noOpenAI } });
    void opened.start();
    await Bun.sleep(0);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    opened.handleInput("r");
    await Bun.sleep(0);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false, false]);
    late[0]?.({ id: "claude-code", state: "read", reading: reading(3) });
    expect(screen(opened)).not.toContain("3%");
    late[1]?.({ id: "claude-code", state: "read", reading: reading(62) });
    expect(lineOf(opened, "5h")).toContain(drawn(62));
    opened.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("with OpenAI signed in with ChatGPT and no Codex sign-in, one muted line after the accounts says its limits are not reported", async () => {
    const { panel: opened } = panel({ usage: full, openai: true });
    await opened.start();
    await Bun.sleep(0);
    const lines = text(opened);
    const at = lines.findIndex((line) => line.includes("ChatGPT through the OpenAI sign-in doesn't report its limits."));
    expect(at).toBeGreaterThan(lines.findIndex((line) => line.includes("openai-codex@pro")));
    expect(screen(opened)).toMatch(/A Codex sign-in does: \/login, then\s+OpenAI Codex \(legacy\)\./u);
    const muted = theme.fg("muted", "\u0000").split("\u0000")[0] ?? "";
    expect(opened.render(100).join("\n")).toContain(`${muted}ChatGPT through the OpenAI sign-in`);
    // Only on the Usage tab.
    opened.handleInput("\t");
    expect(screen(opened)).not.toContain("OpenAI sign-in");
  });

  test("no line when a Codex sign-in is among the accounts, when OpenAI uses an API key, or is not signed in", async () => {
    const codex: AccountRow[] = [...accounts.slice(0, 2), { id: "openai-codex@pro", provider: "openai-codex", label: "acct", signedIn: true, identity: "acct" }];
    const { panel: withCodex } = panel({ usage: full, openai: true, list: codex });
    await withCodex.start();
    await Bun.sleep(0);
    expect(screen(withCodex)).not.toContain("OpenAI sign-in");
    // An API key, or no sign-in: the view says OpenAI is not signed in with ChatGPT.
    const { panel: without } = panel({ usage: full });
    await without.start();
    await Bun.sleep(0);
    expect(screen(without)).not.toContain("OpenAI sign-in");
  });

  test("a session on OpenAI's ChatGPT sign-in is marked on that line, never on an account whose limits it does not draw on", async () => {
    const { panel: opened } = panel({ usage: full, openai: true, session: "openai" });
    await opened.start();
    await Bun.sleep(0);
    const marked = text(opened).filter((line) => line.includes("this session"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("OpenAI");
    opened.handleInput("\t");
    expect(screen(opened)).not.toContain("this session");
    const { panel: alone } = panel({ openai: true, session: "openai", list: [] });
    await alone.start();
    await Bun.sleep(0);
    expect(screen(alone)).toMatch(/OpenAI sign-in doesn't report its limits[\s\S]*this session/u);
  });

  test("a narrow terminal gets fewer segments, and the details wrap under the meter", async () => {
    const { panel: opened } = panel({ usage: full });
    await opened.start();
    for (const width of [100, 60, 44, 30, 20]) {
      for (const line of opened.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const segmentsAt = (width: number): number => (lineOf(opened, "5h", width).match(/[█░]/gu) ?? []).length;
    expect(segmentsAt(100)).toBe(20);
    expect(segmentsAt(44)).toBeLessThan(20);
    expect(segmentsAt(30)).toBe(5);
    const narrow = text(opened, 30);
    const meter = narrow.findIndex((line) => line.includes("5h"));
    expect(narrow[meter]).not.toContain("resets");
    expect(narrow[meter + 1]).toMatch(/^ {4}resets in/u);
    // The note wraps under its account, not cut.
    expect(narrow.join("\n")).toMatch(/same account as\n? *claude-code/u);
    opened.handleInput("\t");
    for (const width of [44, 20]) for (const line of opened.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test("a short terminal scrolls the body rather than growing past it", async () => {
    const { panel: opened } = panel({ usage: full, rows: 12 });
    await opened.start();
    expect(opened.render(100).length).toBeLessThanOrEqual(12);
    expect(screen(opened)).toContain("↓");
    opened.handleInput("\x1b[B");
    opened.handleInput("\x1b[B");
    expect(opened.render(100).length).toBeLessThanOrEqual(12);
  });
});
