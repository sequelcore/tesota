import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult }
  from "@earendil-works/pi-tui";

/** Pi's border hooks return these in place of its border lines, so the fill can find the rows between them. */
const TOP = "\u{F8FF}tesota-top";
const BOTTOM = "\u{F8FF}tesota-bottom";
/** The columns the frame adds: the bar and two spaces before the text, three spaces after it. */
const LEFT = 3;
const RIGHT = 3;

/** Keeps a background through the resets inside a row, such as the cursor's `ESC[0m`, and ends it at the row's end. */
export function fill(line: string, background: string): string {
  const kept = ["\x1b[0m", "\x1b[49m", "\x1b[m"].reduce((text, reset) => text.replaceAll(reset, reset + background), line);
  return `${background}${kept}\x1b[0m`;
}

/**
 * Pi's editor, drawn as a filled block: a bar in Pi's border color (which
 * follows the thinking level and bash mode) down its left edge, the text
 * on the theme's `userMessageBg` with a padding row above and below it, and
 * Pi's scroll markers in those padding rows. Pi still lays out and edits the
 * text, so autocomplete, paste, history and keybindings are Pi's own; only
 * the frame is redrawn, through the border hooks and on the rows Pi returns
 * between them.
 */
export class FilledEditor extends CustomEditor {
  #above = 0;
  #below = 0;

  readonly #look: () => Theme;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, look: () => Theme) {
    super(tui, theme, keybindings, { paddingX: 0 });
    this.#look = look;
  }

  /** Pi sets the editor's padding from its settings once it creates the editor; the frame draws its own. */
  override setPaddingX(_padding: number): void { super.setPaddingX(0); }

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
    if (lines[0] !== TOP || end < 0) throw new Error("Pi's editor no longer draws its borders through the border hooks");
    const theme = this.#look();
    const background = theme.getBgAnsi("userMessageBg");
    const bar = this.borderColor("▌");
    const padding = (hidden: number, arrow: string): string => bar + fill(hidden > 0
      ? `  ${theme.fg("muted", `${arrow} ${hidden} more`)}${" ".repeat(Math.max(0, inner + RIGHT - 7 - String(hidden).length))}`
      : " ".repeat(inner + LEFT - 1 + RIGHT), background);
    return [
      padding(this.#above, "↑"),
      ...lines.slice(1, end).map((line) => `${bar}${fill(`  ${line}${" ".repeat(RIGHT)}`, background)}`),
      padding(this.#below, "↓"),
      ...lines.slice(end + 1).map((line) => `${" ".repeat(LEFT)}${line}`),
    ].map((line) => truncateToWidth(line, width, ""));
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return super.handleMouse({ ...event, x: event.x - LEFT, width: Math.max(1, event.width - LEFT - RIGHT) });
  }
}
