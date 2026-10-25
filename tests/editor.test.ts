import { CombinedAutocompleteProvider, CURSOR_MARKER, Editor, type EditorTheme, renderFakeCursor, stripTerminalSequences, type TUI,
  type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../src/contract.js";
import { beforeAll, expect, it, vi } from "vitest";
import { BarEditor } from "../src/editor.js";
import { shellTheme } from "../src/theme.js";

let theme: Theme;
beforeAll(async () => { theme = shellTheme("dark", "truecolor"); });

const tui = (rows = 40) => ({ terminal: { rows }, requestRender: () => undefined }) as unknown as TUI;
const plain = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: (text) => `\x1b[35m${text}\x1b[39m`, selectList: { selectedPrefix: plain,
  selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };

function editor(text: string, rows = 40) {
  const view = new BarEditor(tui(rows), editorTheme, () => theme);
  view.focused = true;
  view.setText(text);
  return view;
}

/** pi-tui's editor with the same text, at the width the band gives it. */
function plainRows(text: string, width: number, rows = 40): string[] {
  const plainEditor = new Editor(tui(rows), editorTheme, { paddingX: 0 });
  plainEditor.focused = true;
  plainEditor.setText(text);
  return plainEditor.render(width - 2);
}

it("draws the editor's text rows inside the band, between padding rows where the editor draws its borders", () => {
  const text = "Make clamp reject an empty range and keep its proofs passing, with a test that exercises it";
  for (const width of [120, 80, 40]) {
    const rows = editor(text).render(width);
    const plain = plainRows(text, width);
    expect(rows).toHaveLength(plain.length);
    for (const row of rows) expect(visibleWidth(row)).toBe(width);
    // The rows between the padding are the editor's text rows, moved past the prompt and a space.
    expect(rows.slice(1, -1).map((row) => stripTerminalSequences(row).slice(2).trimEnd()))
      .toEqual(plain.slice(1, -1).map((row) => stripTerminalSequences(row).trimEnd()));
    expect(stripTerminalSequences(rows[0] ?? "")).toBe(" ".repeat(width));
  }
});

it("fills the full-width band without a side bar", () => {
  const rows = editor("hello").render(40);
  for (const row of rows) {
    expect(row).toContain(theme.getBgAnsi("userMessageBg"));
    expect(row).not.toContain("▌");
    expect(visibleWidth(row)).toBe(40);
  }
  expect(stripTerminalSequences(rows[1]!)).toMatch(/^› hello/u);
  expect(rows[1]).toContain(`hello${CURSOR_MARKER}${renderFakeCursor(" ")}`);
});

it("uses the light band's text color instead of inheriting the terminal foreground", () => {
  const look = shellTheme("light", "truecolor");
  const view = new BarEditor(tui(), editorTheme, () => look);
  view.setText("hello");
  expect(view.render(40)[1]).toContain("\x1b[38;2;36;33;31m› hello");
  expect(view.render(40)[1]).toContain("\x1b[48;2;228;217;233m");
});

it.each(["dark", "light"] as const)("uses the readable muted text for the empty hint on the %s band", (appearance) => {
  const look = shellTheme(appearance, "truecolor");
  const view = new BarEditor(tui(), editorTheme, () => look);
  expect(view.render(80)[1]).toContain(look.fg("muted", "/ for commands · @ for files"));
  // WCAG relative luminance: guard the actual token pair, not just the choice of role.
  const luminance = (ansi: string): number => (ansi.match(/\d+/gu) ?? []).slice(2, 5).map(Number)
    .map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const foreground = luminance(look.fg("muted", ""));
  const background = luminance(look.getBgAnsi("userMessageBg"));
  expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
});

it("shows the editor's scroll markers in the padding rows", () => {
  // In a 10-row terminal the editor shows 5 text rows; the cursor at the end leaves 7 above.
  const long = Array.from({ length: 12 }, (_, k) => `line ${k + 1}`).join("\n");
  const view = editor(long, 10);
  const rows = view.render(60).map(stripTerminalSequences);
  expect(rows).toHaveLength(7);
  expect(rows[0]).toBe(`  ↑ 7 more${" ".repeat(50)}`);
  expect(rows[6]?.trimEnd()).toBe("");
  for (let k = 0; k < 11; k++) view.handleInput("\x1b[A");
  const top = view.render(60).map(stripTerminalSequences);
  expect(top[0]?.trimEnd()).toBe("");
  expect(top[6]).toBe(`  ↓ 7 more${" ".repeat(50)}`);
});

it("opens suggestions above the block, as Claude Code and Codex do, and places clicks past the prompt and the suggestions", async () => {
  const view = editor("");
  view.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()));
  view.handleInput("/");
  view.handleInput("h");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rows = view.render(60).map(stripTerminalSequences);
  const block = rows.findIndex((row) => row.trim() === "");
  expect(block).toBeGreaterThan(0);
  expect(rows.slice(0, block).join("\n")).toContain("help");
  expect(rows.slice(0, block).every((row) => row.startsWith("  "))).toBe(true);
  expect(rows[block + 1]).toContain("› /h");
  // A click on the text, below the open suggestions, places the cursor where pi's layout has it.
  view.handleMouse({ type: "click", button: "left", x: 2 + 1, y: block + 1, screenX: 4, screenY: block + 1, width: 60,
    height: rows.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
  expect(view.getCursor()).toEqual({ line: 0, col: 1 });
  const typed = editor("abcdefghij");
  const click: TuiMouseEvent = { type: "click", button: "left", x: 2 + 4, y: 1, screenX: 7, screenY: 1, width: 60, height: 3,
    shift: false, alt: false, ctrl: false } as TuiMouseEvent;
  typed.handleMouse(click);
  expect(typed.getCursor()).toEqual({ line: 0, col: 4 });
});

it("selects a suggestion by clicking its row above the band", async () => {
  const view = editor("");
  view.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: "help", description: "Show help" }, { name: "resume", description: "Resume a session" },
  ], process.cwd()));
  view.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rows = view.render(60).map(stripTerminalSequences);
  const y = rows.findIndex((row) => row.includes("Resume a session"));
  expect(y).toBeGreaterThanOrEqual(0);
  expect(view.handleMouse({ type: "click", button: "left", x: 5, y, screenX: 5, screenY: y,
    width: 60, height: rows.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent)?.handled).toBe(true);
  expect(view.getText()).toBe("/resume ");
});

it("says what an empty input takes, and stops once the operator types", () => {
  expect(stripTerminalSequences(editor("").render(60)[1] ?? "")).toContain("/ for commands · @ for files");
  expect(stripTerminalSequences(editor("a").render(60)[1] ?? "")).not.toContain("for commands");
  expect(visibleWidth(editor("").render(20)[1] ?? "")).toBeLessThanOrEqual(20);
});


it.each([{ NO_COLOR: "1" }, { TERM: "ansi", COLORTERM: "" }])("falls back to plain band rows on limited terminals: %j", (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  try {
    const look = shellTheme("dark", "256color");
    const view = new BarEditor(tui(), editorTheme, () => look);
    view.setText("hello");
    const rows = view.render(40);
    expect(look.getBgAnsi("userMessageBg")).toBe("");
    expect(rows.join("\n")).not.toContain("\x1b[48;");
    expect(stripTerminalSequences(rows[1]!)).toMatch(/^› hello/u);
    expect(rows.every((row) => visibleWidth(row) === 40)).toBe(true);
  } finally { vi.unstubAllEnvs(); }
});
