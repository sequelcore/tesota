import { Editor, type EditorTheme, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult }
  from "@earendil-works/pi-tui";
import type { Theme } from "./contract.js";

/** Pi's border hooks return these in place of its border lines, so the frame can find the rows between them. */
const TOP = "\u{F8FF}tesota-top";
const BOTTOM = "\u{F8FF}tesota-bottom";
/** The columns the frame adds: the bar and two spaces before the text, three spaces after it. */
const LEFT = 3;
const RIGHT = 3;
const HINT = "/ for commands · @ for files";

/**
 * pi-tui's editor, drawn on the terminal's own background with a bar in its
 * border color down its left edge, a padding row above and below the text,
 * and the scroll markers in those padding rows: only the live input has the
 * bar, so it never reads as one of the conversation's cards (OpenCode marks
 * its input the same way). The editor still lays out and edits the text, so
 * autocomplete, paste, history and keys are its own; only the frame is
 * redrawn, through its border hooks and on the rows it returns between them.
 */
export class BarEditor extends Editor {
  #above = 0;
  #below = 0;

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
    const bar = this.borderColor("▌");
    const padding = (hidden: number, arrow: string): string => bar + (hidden > 0
      ? `  ${theme.fg("muted", `${arrow} ${hidden} more`)}${" ".repeat(Math.max(0, inner + RIGHT - 7 - String(hidden).length))}`
      : " ".repeat(inner + LEFT - 1 + RIGHT));
    // An empty input says what it takes, dim after the cursor, as Gemini CLI's does.
    const hint = (line: string): string => this.getText() === "" ? `${line.trimEnd()} ${theme.fg("dim", HINT)}` : line;
    return [
      padding(this.#above, "↑"),
      ...lines.slice(1, end).map((line, row) => `${bar}  ${row === 0 ? hint(line) : line}${" ".repeat(RIGHT)}`),
      padding(this.#below, "↓"),
      ...lines.slice(end + 1).map((line) => `${" ".repeat(LEFT)}${line}`),
    ].map((line) => truncateToWidth(line, width, ""));
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({ ...event, x: event.x - LEFT, width: Math.max(1, event.width - LEFT - RIGHT) });
  }
}
