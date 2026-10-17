import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import { Dashboard, type DashboardActions, type SessionRow } from "../src/shell/dashboard.ts";
import { shellTheme } from "../src/shell/theme.ts";

const now = 4_000_000;
const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id, request: id, state: "idle", workspace: "checkout", startedAt: now - 12_000, attached: false, ...extra,
});

function dashboard(initial: readonly SessionRow[]) {
  let rows = initial;
  const calls: string[] = [];
  const actions: DashboardActions = {
    attach: (id) => { calls.push(`attach ${id}`); },
    peek: (id) => { calls.push(`peek ${id}`); return Array.from({ length: 12 }, (_, i) => `${id} output ${i} ${"界".repeat(50)}`); },
    create: () => { calls.push("create"); },
    close: (id) => { calls.push(`close ${id}`); },
    back: () => { calls.push("back"); },
  };
  const view = new Dashboard(shellTheme("dark", "truecolor"), () => rows, actions, () => now);
  return { view, calls, rows: (next: readonly SessionRow[]) => { rows = next; } };
}

const lines = (view: Dashboard, width = 80): string[] => view.render(width).map(stripTerminalSequences);
const shown = (view: Dashboard, width = 80): string => lines(view, width).join("\n");

describe("the session dashboard", () => {
  test("shows each state, verification, workspace, elapsed time and only the request's first line", () => {
    const { view } = dashboard([
      row("one", { request: "first line\nsecond line", verification: "verified", attached: true }),
      row("two", { state: "working", verification: "incomplete", startedAt: now - 180_000 }),
      row("three", { state: "verifying", verification: "failed", startedAt: now - 3_840_000 }),
      row("four", { state: "waiting", verification: "unverified", workspace: "tesota/work" }),
      row("five", { state: "ended", outcome: "completed", request: "" }),
    ]);
    const screen = lines(view);
    expect(screen[0]).toBe("Sessions (5)");
    expect(screen[1]).toContain("idle");
    expect(screen[1]).toContain(" · verified · ");
    expect(screen[1]).toContain("checkout");
    expect(screen[1]).toContain("12s");
    expect(screen[1]).toContain("attached");
    expect(screen[1]).toContain("first line");
    expect(screen.join("\n")).not.toContain("second line");
    expect(screen[2]).toContain("working");
    expect(screen[2]).toContain("incomplete");
    expect(screen[2]).toContain("3m");
    expect(screen[2]).toContain("two");
    expect(screen[3]).toContain("verifying");
    expect(screen[3]).toContain("failed");
    expect(screen[3]).toContain("1h 4m");
    expect(screen[3]).toContain("three");
    expect(screen[4]).toContain("waiting for you");
    expect(screen[4]).toContain("unverified");
    expect(screen[4]).toContain("tesota/work");
    expect(screen[4]).toContain("four");
    expect(screen[5]).toContain("ended");
    expect(screen[5]).toContain("completed");
    expect(screen[5]).toContain("unverified");
    expect(screen[5]).toContain("new session");
    expect(screen.at(-1)).toBe("↑↓ choose · enter attach · space peek · n new · x close · esc back");
    const theme = shellTheme("dark", "truecolor");
    expect(view.render(80)[4]).toContain(theme.fg("warning", "waiting for you"));
  });

  test("truncates every line, including wide text, previews and confirmation, to the terminal width", () => {
    const { view } = dashboard([row("long", { state: "working", workspace: "界".repeat(50), request: "🙂".repeat(80) })]);
    view.handleInput(" ");
    view.handleInput("x");
    for (const width of [80, 40, 12, 1, 0]) {
      const screen = view.render(width);
      for (const line of screen) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const { view: request } = dashboard([row("request", { request: "界🙂".repeat(80) })]);
    expect(shown(request)).toContain("界🙂");
    expect(shown(request)).not.toContain("界🙂".repeat(80));
    for (const line of request.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  test("clamps arrow movement and keeps the same selected id through reordering and removal", () => {
    const a = row("a"), b = row("b"), c = row("c");
    const { view, calls, rows } = dashboard([a, b, c]);
    expect(lines(view)[1]).toStartWith("> ");
    view.handleInput("\x1b[A");
    view.handleInput("\r");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    view.handleInput("\x1b[A");
    expect(lines(view)[2]).toStartWith("> ");
    rows([b, c, a]);
    expect(lines(view)[1]).toStartWith("> ");
    view.handleInput("\r");
    rows([c, a]);
    view.handleInput("\r");
    view.handleInput("\x1b[B");
    rows([c]);
    expect(lines(view)[1]).toStartWith("> ");
    view.handleInput("\r");
    expect(calls).toEqual(["attach a", "attach c", "attach b", "attach c", "attach c"]);
  });

  test("enter attaches, space toggles the selected conversation's last ten lines, n creates and escape goes back", () => {
    const { view, calls } = dashboard([row("a"), row("b")]);
    view.handleInput("\x1b[B");
    view.handleInput("\r");
    view.handleInput(" ");
    const screen = lines(view);
    expect(screen).toHaveLength(15);
    expect(screen[4]).toBe("Peek");
    expect(screen[5]).toStartWith("b output 2 ");
    expect(screen.at(-1)).toStartWith("b output 11 ");
    expect(screen.join("\n")).not.toContain("b output 0 ");
    view.handleInput(" ");
    expect(shown(view)).not.toContain("output");
    view.handleInput("n");
    view.handleInput("\x1b");
    expect(calls).toEqual(["attach b", "peek b", "create", "back"]);
  });

  test("x closes ended and idle sessions immediately", () => {
    const { view, calls } = dashboard([row("done", { state: "ended", outcome: "aborted" }), row("idle")]);
    view.handleInput("x");
    expect(shown(view)).not.toContain("Stop and close");
    view.handleInput("\x1b[B");
    view.handleInput("x");
    expect(calls).toEqual(["close done", "close idle"]);
  });

  test.each(["working", "verifying", "waiting"] as const)("x confirms before closing a %s session, and n or escape cancels", (state) => {
    const { view, calls } = dashboard([row("busy", { state })]);
    view.handleInput("x");
    expect(lines(view).at(-1)).toBe("Stop and close this session? y/n");
    expect(calls).toEqual([]);
    view.handleInput("n");
    expect(shown(view)).not.toContain("Stop and close");
    expect(calls).toEqual([]);
    view.handleInput("x");
    view.handleInput("\x1b");
    expect(shown(view)).not.toContain("Stop and close");
    expect(calls).toEqual([]);
    view.handleInput("x");
    view.handleInput("\r");
    view.handleInput(" ");
    view.handleInput("\x1b[B");
    expect(calls).toEqual([]);
    view.handleInput("y");
    expect(shown(view)).not.toContain("Stop and close");
    expect(calls).toEqual(["close busy"]);
  });

  test("confirmation stays with its session when rows reorder and disappears if that session is removed", () => {
    const busy = row("busy", { state: "working" }), other = row("other");
    const { view, calls, rows } = dashboard([busy, other]);
    view.handleInput("x");
    rows([other, busy]);
    view.handleInput("y");
    expect(calls).toEqual(["close busy"]);
    view.handleInput("x");
    rows([other]);
    view.handleInput("y");
    expect(shown(view)).not.toContain("Stop and close");
    expect(calls).toEqual(["close busy"]);
  });

  test("the empty state explains how to start, ignores row actions and handles rows arriving later", () => {
    const { view, calls, rows } = dashboard([]);
    expect(lines(view)[0]).toBe("Sessions (0)");
    expect(shown(view)).toContain("No sessions. Press n to start one.");
    for (const key of ["\x1b[A", "\x1b[B", "\r", " ", "x", "y"]) view.handleInput(key);
    expect(calls).toEqual([]);
    view.handleInput("n");
    view.handleInput("\x1b");
    expect(calls).toEqual(["create", "back"]);
    rows([row("arrived")]);
    view.invalidate();
    expect(lines(view)[1]).toStartWith("> ");
    view.handleInput("\r");
    expect(calls).toEqual(["create", "back", "attach arrived"]);
  });
});
