import type { ToolCall } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "bun:test";
import { shellTheme } from "../../../src/theme.ts";
import { Transcript } from "../src/shell/transcript.ts";

const theme = shellTheme("dark", "truecolor");
const plain = (transcript: Transcript, width: number): string[] => transcript.render(width).map((line) => stripTerminalSequences(line).trimEnd());

test("operator messages start at the replies' column and wrap with a two-column indent, no padding rows or background", () => {
  const transcript = new Transcript(theme);
  transcript.add({ role: "user", content: "abcdefghijklm\nnext", timestamp: 0 });
  expect(plain(transcript, 10)).toEqual([" › abcdefg", "   hijklm", "   next"]);
  expect(plain(transcript, 6)).toEqual([" › abc", "   def", "   ghi", "   jkl", "   m", "   nex", "   t"]);
  for (const width of [1, 2, 6, 10, 80]) {
    const rows = transcript.render(width);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(rows.join("\n")).not.toContain("\x1b[48;");
  }
});

test("a user message cannot repaint the terminal, such as a submitted answer quoting the agent's question", () => {
  const transcript = new Transcript(theme);
  transcript.add({ role: "user", content: "Agent question: pick\x1b[2J\x1b]0;owned\x07 one", timestamp: 0 });
  const rows = transcript.render(80).join("\n");
  expect(rows).not.toContain("\x1b[2J");
  expect(rows).not.toContain("\x1b]0;");
  expect(plain(transcript, 80)).toEqual([" › Agent question: pick one"]);
});

test("a pending call has a muted glyph, a single clipped row and no result note", () => {
  const transcript = new Transcript(theme);
  transcript.start({ type: "toolCall", id: "edit", name: "edit", arguments: {
    path: "a/very/long/path.txt", edits: [{ oldText: "one", newText: "two" }],
  } });
  expect(plain(transcript, 80)).toEqual([" ○ edit a/very/long/path.txt"]);
  expect(transcript.render(80)[0]).toContain(theme.fg("muted", "○"));
  expect(plain(transcript, 12)).toHaveLength(1);
  expect(visibleWidth(transcript.render(12)[0] ?? "")).toBeLessThanOrEqual(12);
});

test("expanded output keeps twelve lines and the remainder count, without a background", () => {
  const transcript = new Transcript(theme, { renderers: new Map(), tools: new Map(), expanded: () => true, cwd: "" });
  transcript.start({ type: "toolCall", id: "read", name: "read", arguments: { path: "a.txt" } });
  transcript.add({ role: "toolResult", toolCallId: "read", toolName: "read", isError: false, timestamp: 0,
    content: [{ type: "text", text: Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n") }] });
  const rows = plain(transcript, 80);
  expect(rows[0]).toBe(" ✓ read a.txt");
  expect(rows.slice(1, 4)).toEqual(["   line 1", "   line 2", "   line 3"]);
  expect(rows.slice(-2)).toEqual(["   line 12", "   … 2 more lines"]);
  expect(rows).toHaveLength(14);
  expect(transcript.render(80).join("\n")).not.toContain("\x1b[48;");
});

test("collapsed failures show only the first output line and never show edit counts", () => {
  const call: ToolCall = { type: "toolCall", id: "edit", name: "edit", arguments: {
    path: "a.txt", edits: [{ oldText: "one", newText: "two" }],
  } };
  const transcript = new Transcript(theme);
  transcript.start(call);
  transcript.add({ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp: 0,
    content: [{ type: "text", text: "Could not edit.\nMore error details." }] });
  expect(plain(transcript, 80)).toEqual([" ✗ edit a.txt", "   Could not edit."]);
  expect(transcript.render(80)[0]).toContain(theme.fg("error", "✗"));
  expect(transcript.render(80).join("\n")).not.toContain("\x1b[48;");
});

test("a deletion counts no added lines and a final newline adds no phantom line", () => {
  const transcript = new Transcript(theme);
  transcript.start({ type: "toolCall", id: "edit", name: "edit", arguments: {
    path: "a.txt", edits: [{ oldText: "one\ntwo\n", newText: "" }],
  } });
  transcript.add({ role: "toolResult", toolCallId: "edit", toolName: "edit", isError: false, timestamp: 0,
    content: [{ type: "text", text: "Applied 1 edit to a.txt." }] });
  expect(plain(transcript, 80)).toEqual([" ✓ edit a.txt +0 −2"]);
});

test("a search shows its pattern and where it looks", () => {
  const transcript = new Transcript(theme);
  transcript.start({ type: "toolCall", id: "grep", name: "grep", arguments: { pattern: "quesillo", path: "notes" } });
  transcript.start({ type: "toolCall", id: "find", name: "find", arguments: { pattern: "**/*.md" } });
  expect(plain(transcript, 80)).toEqual([" ○ grep quesillo in notes", "", " ○ find **/*.md"]);
});
