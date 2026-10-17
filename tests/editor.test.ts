import { CombinedAutocompleteProvider, CURSOR_MARKER, Editor, type EditorTheme, renderFakeCursor, stripTerminalSequences, type TUI,
  type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../src/contract.js";
import { beforeAll, expect, it } from "vitest";
import { fill, FilledEditor } from "../src/editor.js";
import { shellTheme } from "../src/theme.js";

let theme: Theme;
beforeAll(async () => { theme = shellTheme("dark", "truecolor"); });

const tui = (rows = 40) => ({ terminal: { rows }, requestRender: () => undefined }) as unknown as TUI;
const plain = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: (text) => `\x1b[35m${text}\x1b[39m`, selectList: { selectedPrefix: plain,
  selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };

function editor(text: string, rows = 40) {
  const view = new FilledEditor(tui(rows), editorTheme, () => theme);
  view.focused = true;
  view.setText(text);
  return view;
}

/** pi-tui's editor with the same text, at the width the filled one gives it. */
function plainRows(text: string, width: number, rows = 40): string[] {
  const plainEditor = new Editor(tui(rows), editorTheme, { paddingX: 0 });
  plainEditor.focused = true;
  plainEditor.setText(text);
  return plainEditor.render(width - 6);
}

it("draws the editor's text rows on the fill, between padding rows where the editor draws its borders", () => {
  const text = "Make clamp reject an empty range and keep its proofs passing, with a test that exercises it";
  for (const width of [120, 80, 40]) {
    const rows = editor(text).render(width);
    const plain = plainRows(text, width);
    expect(rows).toHaveLength(plain.length);
    for (const row of rows) expect(visibleWidth(row)).toBe(width);
    // The rows between the padding are the editor's text rows, moved past the bar and two spaces.
    expect(rows.slice(1, -1).map((row) => stripTerminalSequences(row).slice(3).trimEnd()))
      .toEqual(plain.slice(1, -1).map((row) => stripTerminalSequences(row).trimEnd()));
    expect(stripTerminalSequences(rows[0] ?? "")).toBe(`▌${" ".repeat(width - 1)}`);
  }
});

it("keeps the fill through the cursor and resets, and the bar in the editor's border color", () => {
  const background = theme.getBgAnsi("userMessageBg");
  const body = editor("hello").render(40)[1] ?? "";
  expect(body.startsWith(`\x1b[35m▌\x1b[39m${background}`)).toBe(true);
  // The editor marks the cursor here and later draws it with reverse video on and off, so nothing ends the fill before the row does.
  expect(body).toContain(`hello${CURSOR_MARKER}${renderFakeCursor(" ")}`);
  expect(body.indexOf("\x1b[0m")).toBe(body.length - "\x1b[0m".length);
  expect(fill("a\x1b[49mb\x1b[mc", "<bg>")).toBe("<bg>a\x1b[49m<bg>b\x1b[m<bg>c\x1b[0m");
});

it("shows the editor's scroll markers in the padding rows", () => {
  // In a 10-row terminal the editor shows 5 text rows; the cursor at the end leaves 7 above.
  const long = Array.from({ length: 12 }, (_, k) => `line ${k + 1}`).join("\n");
  const view = editor(long, 10);
  const rows = view.render(60).map(stripTerminalSequences);
  expect(rows).toHaveLength(7);
  expect(rows[0]).toBe(`▌  ↑ 7 more${" ".repeat(49)}`);
  expect(rows[6]?.trimEnd()).toBe("▌");
  for (let k = 0; k < 11; k++) view.handleInput("\x1b[A");
  const top = view.render(60).map(stripTerminalSequences);
  expect(top[0]?.trimEnd()).toBe("▌");
  expect(top[6]).toBe(`▌  ↓ 7 more${" ".repeat(49)}`);
});

it("puts autocomplete beneath the block, under the text, and places clicks past the bar", async () => {
  const view = editor("");
  view.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()));
  view.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rows = view.render(60).map(stripTerminalSequences);
  expect(rows.length).toBeGreaterThan(3);
  expect(rows[3]?.startsWith("   ")).toBe(true);
  expect(rows.slice(3).join("\n")).toContain("help");
  const typed = editor("abcdefghij");
  const click: TuiMouseEvent = { type: "click", button: "left", x: 3 + 4, y: 1, screenX: 7, screenY: 1, width: 60, height: 3,
    shift: false, alt: false, ctrl: false } as TuiMouseEvent;
  typed.handleMouse(click);
  expect(typed.getCursor()).toEqual({ line: 0, col: 4 });
});
