import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { recordRows, Transcript } from "../src/tesota-shell-transcript.js";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";

/**
 * A conversation's rendering stays cheap however long it grows: each entry
 * keeps its lines until what it shows changes (pi-tui's caching guidance),
 * and adding an entry never discards the others' (findings, 2026-09-27).
 */

afterEach(() => { vi.restoreAllMocks(); });

it("keeps every earlier entry's rendered lines when an entry is added", () => {
  initTheme("dark");
  const transcript = new Transcript(tesotaShellTheme("tesota-dark"));
  for (let index = 0; index < 5; index++) transcript.add({ kind: "agent", text: `Reply **${index}** with a [link](https://example.com).` });
  transcript.container.render(80);
  const invalidated = vi.spyOn(Markdown.prototype, "invalidate");
  transcript.add({ kind: "tool", tool: "read", subject: "src/a.ts", failed: false });
  transcript.activity({ type: "tool_started", call: "1", tool: "bash", subject: "bun test" });
  transcript.add({ kind: "agent", text: "Another reply." });
  // pi-tui's Container.invalidate() clears every child's cache, which re-parsed every reply on each new entry.
  expect(invalidated).not.toHaveBeenCalled();
});

it("draws a tool call once per width, and again when its state or output changes", () => {
  initTheme("dark");
  const transcript = new Transcript(tesotaShellTheme("tesota-dark"));
  transcript.activity({ type: "tool_started", call: "1", tool: "bash", subject: "bun test" });
  const block = transcript.container.children.at(-1);
  if (block === undefined) throw new Error("no tool block");
  const running = block.render(80);
  expect(block.render(80)).toBe(running);
  transcript.activity({ type: "tool_output", call: "1", output: "1 passed" });
  const withOutput = block.render(80);
  expect(withOutput).not.toBe(running);
  expect(withOutput.join("\n")).toContain("1 passed");
  transcript.activity({ type: "tool_finished", call: "1", failed: false, output: "1 passed" } as never);
  expect(block.render(80)).not.toBe(withOutput);
});

it("shows a long notice's full text when toggled, and caches each state", () => {
  initTheme("dark");
  const transcript = new Transcript(tesotaShellTheme("tesota-dark"));
  transcript.add({ kind: "notice", tone: "info", text: "Brought changes:\na.ts\nb.ts\nc.ts\nd.ts" });
  const notice = transcript.container.children.at(-1);
  if (notice === undefined) throw new Error("no notice");
  const collapsed = notice.render(80);
  expect(notice.render(80)).toBe(collapsed);
  expect(transcript.toggleNotice()).toBe(true);
  expect(notice.render(80).join("\n")).toContain("d.ts");
});

it("sets a review apart from the agent's replies and wraps each line under its own text", () => {
  initTheme("dark");
  const transcript = new Transcript(tesotaShellTheme("tesota-dark"));
  transcript.add({ kind: "review", title: "Review · 1 file",
    text: "  edit   src/price.ts\n  ✗ high · src/price.ts:3 — Exactly one hundred dollars is discounted as well" });
  const rows = transcript.container.render(40).map((row) => stripTerminalSequences(row).trimEnd());
  expect(rows).toEqual([
    " ┃ Review · 1 file",
    " ┃   edit   src/price.ts",
    " ┃   ✗ high · src/price.ts:3 — Exactly",
    " ┃     one hundred dollars is discounted",
    " ┃     as well",
    " ┃ Alt+R shows or hides the full diff",
    " ┃ and check output.",
  ]);
});

it("shows a command's colored output as plain text", () => {
  initTheme("dark");
  const transcript = new Transcript(tesotaShellTheme("tesota-dark"));
  transcript.activity({ type: "tool_started", call: "1", tool: "bash", subject: "bun test" });
  transcript.activity({ type: "tool_finished", call: "1", failed: true, output: "\x1b[41m FAIL \x1b[49m a.test.ts" });
  const screen = stripTerminalSequences(transcript.container.render(60).join("\n"));
  expect(screen).toContain("└  FAIL  a.test.ts");
  expect(screen).not.toContain("\u001b");
});

it("draws a review record's sections as headings, nesting kept on wrapped rows", () => {
  const theme = tesotaShellTheme("tesota-dark");
  const record = "Changes to what gets checked\n  modified tests/tesota-shell-terminal.test.ts (test)\n\nChecks\n" +
    "  ✗ failed (exit 1): bun run check\n    Claim: `bun run check` exits with code 0 on this tree\n    │ AssertionError: expected 1 to be 2";
  const rows = recordRows(record, 37, theme, true);
  expect(rows.map((row) => stripTerminalSequences(row).trimEnd())).toEqual([
    "Changes to what gets checked",
    "  modified",
    "  tests/tesota-shell-terminal.test.ts",
    "  (test)",
    "",
    "Checks",
    "  ✗ failed (exit 1): bun run check",
    "    Claim: `bun run check` exits with",
    "    code 0 on this tree",
    "    │ AssertionError: expected 1 to",
    "    │ be 2",
  ]);
  expect(rows[0]).toContain("\x1b[1m");
  expect(rows[6]).toContain("\x1b[38;2;216;140;140m");
});
