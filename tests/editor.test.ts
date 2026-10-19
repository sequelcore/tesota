import { CombinedAutocompleteProvider, CURSOR_MARKER, Editor, type EditorTheme, renderFakeCursor, stripTerminalSequences, type TUI,
  type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../src/contract.js";
import { beforeAll, expect, it } from "vitest";
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

/** pi-tui's editor with the same text, at the width the barred one gives it. */
function plainRows(text: string, width: number, rows = 40): string[] {
  const plainEditor = new Editor(tui(rows), editorTheme, { paddingX: 0 });
  plainEditor.focused = true;
  plainEditor.setText(text);
  return plainEditor.render(width - 6);
}

it("draws the editor's text rows past the bar, between padding rows where the editor draws its borders", () => {
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

it("draws on the terminal's own background, the bar in the editor's border color", () => {
  const rows = editor("hello").render(40);
  for (const row of rows) {
    expect(row.startsWith("\x1b[35m▌\x1b[39m")).toBe(true);
    // No background of its own: only the live input has the bar, and the conversation's cards keep their fills.
    expect(row).not.toContain(theme.getBgAnsi("userMessageBg"));
    expect(row).not.toContain("\x1b[48;");
  }
  expect(rows[1]).toContain(`hello${CURSOR_MARKER}${renderFakeCursor(" ")}`);
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

it("opens suggestions above the block, as Claude Code and Codex do, and places clicks past the bar and the suggestions", async () => {
  const view = editor("");
  view.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "help", description: "Show help" }], process.cwd()));
  view.handleInput("/");
  view.handleInput("h");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rows = view.render(60).map(stripTerminalSequences);
  const block = rows.findIndex((row) => row.startsWith("▌"));
  expect(block).toBeGreaterThan(0);
  expect(rows.slice(0, block).join("\n")).toContain("help");
  expect(rows.slice(0, block).every((row) => row.startsWith("   "))).toBe(true);
  expect(rows.slice(block).every((row) => row.startsWith("▌"))).toBe(true);
  // A click on the text, below the open suggestions, places the cursor where pi's layout has it.
  view.handleMouse({ type: "click", button: "left", x: 3 + 1, y: block + 1, screenX: 4, screenY: block + 1, width: 60,
    height: rows.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
  expect(view.getCursor()).toEqual({ line: 0, col: 1 });
  const typed = editor("abcdefghij");
  const click: TuiMouseEvent = { type: "click", button: "left", x: 3 + 4, y: 1, screenX: 7, screenY: 1, width: 60, height: 3,
    shift: false, alt: false, ctrl: false } as TuiMouseEvent;
  typed.handleMouse(click);
  expect(typed.getCursor()).toEqual({ line: 0, col: 4 });
});

it("says what an empty input takes, and stops once the operator types", () => {
  expect(stripTerminalSequences(editor("").render(60)[1] ?? "")).toContain("/ for commands · @ for files");
  expect(stripTerminalSequences(editor("a").render(60)[1] ?? "")).not.toContain("for commands");
  expect(visibleWidth(editor("").render(20)[1] ?? "")).toBeLessThanOrEqual(20);
});
