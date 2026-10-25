import { Editor, type EditorTheme, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth }
  from "@earendil-works/pi-tui";
import type { Theme } from "./contract.js";

/** Pi's border hooks return these in place of its border lines, so the frame can find the rows between them. */
const TOP = "\u{F8FF}tesota-top";
const BOTTOM = "\u{F8FF}tesota-bottom";
/** The prompt and one space; the text keeps the rest of the terminal width. */
const LEFT = 2;
const RIGHT = 0;
const HINT = "/ for commands · @ for files";

/**
 * pi-tui's editor inside a full-width prompt band, with scroll markers in
 * its top and bottom padding rows. The editor still lays out and edits the text, so
 * autocomplete, paste, history and keys are its own; only the frame is
 * redrawn, through its border hooks and on the rows it returns between them.
 */
export class BarEditor extends Editor {
  #above = 0;
  #below = 0;
  /** The last frame's suggestion rows, drawn above the block, and text rows, so a click lands where pi's layout has it. */
  #suggestions = 0;
  #textRows = 0;

  readonly #look: () => Theme;

  constructor(tui: TUI, theme: EditorTheme, look: () => Theme) {
    super(tui, theme, { paddingX: 0 });
    this.#look = look;
  }

  protected override renderTopBorder(_width: number, hiddenLineCount: number): string {
    this.#above = hiddenLineCount;
    return TOP;
  }

  protected override renderBottomBorder(_width: number, hiddenLineCount: number): string {
    this.#below = hiddenLineCount;
    return BOTTOM;
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - LEFT - RIGHT);
    // Pi's layout: its top border, the visible text rows, its bottom border, then any autocomplete rows.
    const lines = super.render(inner);
    const end = lines.indexOf(BOTTOM);
    if (lines[0] !== TOP || end < 0) throw new Error("The host's editor no longer draws its borders through the border hooks");
    const theme = this.#look();
    const band = (line: string): string => {
      const fitted = truncateToWidth(line, width, "");
      return theme.bg("userMessageBg", theme.fg("userMessageText", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)))));
    };
    const padding = (hidden: number, arrow: string): string => band(hidden > 0
      ? `  ${theme.fg("muted", `${arrow} ${hidden} more`)}` : "");
    // An empty input says what it takes, dim after the cursor, as Gemini CLI's does.
    const hint = (line: string): string => this.getText() === "" ? `${line.trimEnd()} ${theme.fg("muted", HINT)}` : line;
    // Suggestions open above the block, between the conversation and the input, as Claude Code's and Codex's do.
    const suggestions = lines.slice(end + 1);
    this.#suggestions = suggestions.length;
    this.#textRows = end - 1;
    return [
      ...suggestions.map((line) => `${" ".repeat(LEFT)}${line}`),
      padding(this.#above, "↑"),
      ...lines.slice(1, end).map((line, row) => band(`${row === 0 ? "› " : "  "}${row === 0 ? hint(line) : line}`)),
      padding(this.#below, "↓"),
    ].map((line) => truncateToWidth(line, width, ""));
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Pi's rows are its border, the text, its border, then the suggestions; here the suggestions come first.
    const y = event.y < this.#suggestions ? this.#textRows + 2 + event.y : event.y - this.#suggestions;
    return super.handleMouse({ ...event, x: event.x - LEFT, y, width: Math.max(1, event.width - LEFT - RIGHT) });
  }
}
