import { TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { colorText, surfaceText } from "./tesota-shell-theme.js";

/** Fades the layout beneath the overlays while a panel is open, as a web page dims behind a dialog. */
export interface Backdrop {
  /** How each line beneath is faded, or undefined to show the layout as it is. */
  setBackdrop(fade: ((line: string) => string) | undefined): void;
}

/**
 * A column of the layout on a surface of its own, from `x` for `width`
 * cells, every row; `rule` draws a line in the free cell beside it, at that
 * column, which sets it apart from the conversation.
 */
export interface ShellSurface {
  readonly x: number;
  readonly width: number;
  readonly background: string | null;
  readonly rule?: Readonly<{ x: number; color: string | null }>;
}

/** The layout's columns on surfaces of their own, beneath whatever background their content sets itself. */
export interface Surfaces {
  setSurfaces(surfaces: (() => readonly ShellSurface[]) | undefined): void;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/**
 * One escape sequence, which takes no cell: a CSI such as a color; a string sequence, an OSC such as a link or an APC
 * such as pi-tui's cursor marker; or a two-character one.
 */
const sequence = new RegExp(`^${ESC}(?:\\[[0-9;?:<=>]*[ -/]*[@-~]|[\\]_P^X][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|.)`, "u");

/**
 * A line cut at a cell: what is drawn before `column`, padded to it, and what
 * from it. Sequences go with the cell after them, so the styles a column
 * opens at its start stay with it.
 */
function cut(line: string, column: number): readonly [string, string] {
  let width = 0;
  let index = 0;
  while (index < line.length) {
    const escape = sequence.exec(line.slice(index))?.[0];
    if (escape !== undefined) {
      if (width >= column) break;
      index += escape.length;
      continue;
    }
    const character = String.fromCodePoint(line.codePointAt(index) ?? 32);
    const cells = visibleWidth(character);
    if (width + cells > column) break;
    width += cells;
    index += character.length;
  }
  return [`${line.slice(0, index)}${" ".repeat(Math.max(0, column - width))}`, line.slice(index)];
}

/** One line with the range from `x` for `width` cells replaced by `paint` of what it held there, padded to that width. */
function paintRange(line: string, x: number, width: number, paint: (cells: string) => string): string {
  const [before, rest] = cut(line, x);
  const [within, after] = cut(rest, width);
  return `${before}${ESC}[0m${paint(within)}${ESC}[0m${after}`;
}

/** Lay each surface under its column, the content's own backgrounds kept, and draw each surface's rule. */
export function paintSurfaces(lines: readonly string[], surfaces: readonly ShellSurface[]): string[] {
  return lines.map((line) => surfaces.reduce((painted, surface) => {
    const filled = surface.background === null ? painted
      : paintRange(painted, surface.x, surface.width, (cells) => surfaceText(cells, surface.background));
    const rule = surface.rule;
    return rule === undefined ? filled : paintRange(filled, rule.x, 1,
      () => rule.color === null ? "\x1b[2m│\x1b[22m" : colorText("│", rule.color));
  }, line));
}

/**
 * The shell's TUI: pi-tui's alternate screen, whose layout lines are laid on
 * their columns' surfaces, then faded while a backdrop is set, before the
 * overlays are drawn over them.
 */
export class BackdropTui extends TuiAltScreen implements Backdrop, Surfaces {
  #fade: ((line: string) => string) | undefined;
  #surfaces: (() => readonly ShellSurface[]) | undefined;

  setBackdrop(fade: ((line: string) => string) | undefined): void {
    this.#fade = fade;
    this.requestRender();
  }

  setSurfaces(surfaces: (() => readonly ShellSurface[]) | undefined): void {
    this.#surfaces = surfaces;
    this.requestRender();
  }

  protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
    const fade = this.#fade;
    const surfaces = this.#surfaces?.() ?? [];
    const laid = surfaces.length === 0 ? lines : paintSurfaces(lines, surfaces);
    return super.compositeOverlays(fade === undefined ? laid : laid.map((line) => fade(line)), termWidth, termHeight);
  }
}

/**
 * A terminal that reports focus changes. pi-tui's alternate screen turns focus reporting on and consumes the reports
 * itself, so they are read here, on their way in, and still passed on.
 */
export class FocusReportingTerminal implements Terminal {
  readonly #terminal: Terminal;
  #listener: ((focused: boolean) => void) | undefined;

  constructor(terminal: Terminal) { this.#terminal = terminal; }

  onFocusChange(listener: (focused: boolean) => void): void { this.#listener = listener; }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#terminal.start((data) => {
      if (data === "[I") this.#listener?.(true);
      else if (data === "[O") this.#listener?.(false);
      onInput(data);
    }, onResize);
  }
  stop(): void { this.#terminal.stop(); }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.#terminal.drainInput(maxMs, idleMs); }
  write(data: string): void { this.#terminal.write(data); }
  get columns(): number { return this.#terminal.columns; }
  get rows(): number { return this.#terminal.rows; }
  get kittyProtocolActive(): boolean { return this.#terminal.kittyProtocolActive; }
  moveBy(lines: number): void { this.#terminal.moveBy(lines); }
  hideCursor(): void { this.#terminal.hideCursor(); }
  showCursor(): void { this.#terminal.showCursor(); }
  clearLine(): void { this.#terminal.clearLine(); }
  clearFromCursor(): void { this.#terminal.clearFromCursor(); }
  clearScreen(): void { this.#terminal.clearScreen(); }
  setTitle(title: string): void { this.#terminal.setTitle(title); }
  setProgress(active: boolean): void { this.#terminal.setProgress(active); }
}
