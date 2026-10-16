import type { Terminal } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";

/**
 * A terminal the shell draws into for tests (#444), emulated by xterm.js as
 * Pi's own tests do (pi-tui's `test/virtual-terminal.ts`): what it shows is
 * read back from the emulator's screen and scrollback, and keys are sent as
 * the terminal would send them.
 */
export class VirtualTerminal implements Terminal {
  private readonly xterm: xterm.Terminal;
  private onInput: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;
  private width: number;
  private height: number;
  /** Everything the shell wrote, for checking what it sent and how much. */
  written = "";

  constructor(columns = 80, rows = 24) {
    this.width = columns;
    this.height = rows;
    this.xterm = new xterm.Terminal({ cols: columns, rows, disableStdin: true, allowProposedApi: true });
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void {
    this.onInput = undefined;
    this.onResize = undefined;
  }
  async drainInput(): Promise<void> { /* no input to drain */ }
  write(data: string): void {
    this.written += data;
    this.xterm.write(data);
  }
  get columns(): number { return this.width; }
  get rows(): number { return this.height; }
  get kittyProtocolActive(): boolean { return true; }
  moveBy(lines: number): void { if (lines !== 0) this.write(lines > 0 ? `\x1b[${lines}B` : `\x1b[${-lines}A`); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(title: string): void { this.write(`\x1b]0;${title}\x07`); }
  setProgress(): void { /* nothing to show */ }
  setProgramStatus(): void { /* nothing to show */ }

  /** Sends `data` as typed keys. */
  type(data: string): void { this.onInput?.(data); }
  resize(columns: number, rows: number): void {
    this.width = columns;
    this.height = rows;
    this.xterm.resize(columns, rows);
    this.onResize?.();
  }
  /** What the screen shows, once every write so far is drawn. */
  async screen(): Promise<string[]> {
    await new Promise<void>((resolve) => { this.xterm.write("", () => resolve()); });
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: this.height }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  /** What the screen shows once it shows `text`; fails naming what it showed instead. */
  async until(text: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = (await this.screen()).join("\n");
      if (screen.includes(text)) return screen;
      if (Date.now() > deadline) throw new Error(`The screen never showed "${text}":\n${screen}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  /** The screen and everything scrolled above it. */
  async scrollback(): Promise<string[]> {
    await new Promise<void>((resolve) => { this.xterm.write("", () => resolve()); });
    const buffer = this.xterm.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "");
  }
}
