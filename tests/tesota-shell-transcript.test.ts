import { Markdown } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { Transcript } from "../src/tesota-shell-transcript.js";
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
