import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";

/** Fades the layout beneath the overlays while a panel is open, as a web page dims behind a dialog. */
export interface Backdrop {
  /** How each line beneath is faded, or undefined to show the layout as it is. */
  setBackdrop(fade: ((line: string) => string) | undefined): void;
}

/**
 * The shell's TUI: pi-tui's alternate screen, whose layout lines are faded
 * before the overlays are drawn over them while a backdrop is set.
 */
export class BackdropTui extends TuiAltScreen implements Backdrop {
  #fade: ((line: string) => string) | undefined;

  setBackdrop(fade: ((line: string) => string) | undefined): void {
    this.#fade = fade;
    this.requestRender();
  }

  protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
    const fade = this.#fade;
    return super.compositeOverlays(fade === undefined ? lines : lines.map((line) => fade(line)), termWidth, termHeight);
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
