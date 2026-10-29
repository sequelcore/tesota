import { type Component, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IndicatorAnimation, Theme, WorkingIndicator, WorkPhase } from "../../../../src/contract.ts";
import type { ShellTheme } from "../../../../src/theme.ts";

/** The spinner the shell shows when no extension sets an indicator: pi-tui's own frames, one row each. */
const SPINNER: IndicatorAnimation = { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].map((frame) => [frame]), intervalMs: 80 };

/**
 * The row under the conversation while a run works (#749): the indicator's animation for the phase, which may be
 * several rows tall, beside the message, whose lines and wrapped rows stand to its right. An extension's frames are
 * drawn as given, asked for in the shell's theme each time, so they follow the terminal turning light or dark; the
 * shell's own spinner takes the accent.
 */
export class WorkingStatus implements Component {
  readonly #tui: Pick<TUI, "requestRender">;
  readonly #theme: ShellTheme;
  #indicator: ((theme: Theme) => WorkingIndicator) | undefined;
  #phase: WorkPhase = "working";
  #message = "Working…";
  #frame = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(tui: Pick<TUI, "requestRender">, theme: ShellTheme) {
    this.#tui = tui;
    this.#theme = theme;
  }

  #animation(): IndicatorAnimation { return this.#indicator?.(this.#theme).phases[this.#phase] ?? SPINNER; }

  /** The phase and the message beside it; a new phase plays its animation from the first frame while the status runs. */
  show(phase: WorkPhase, message: string): void {
    const changed = phase !== this.#phase;
    this.#phase = phase;
    this.#message = message;
    if (changed && this.#timer !== undefined) this.start();
    else this.#tui.requestRender();
  }

  setIndicator(factory: ((theme: Theme) => WorkingIndicator) | undefined): void {
    this.#indicator = factory;
    if (this.#timer !== undefined) this.start();
  }

  start(): void {
    this.stop();
    this.#frame = 0;
    const { frames, intervalMs } = this.#animation();
    if (frames.length > 1) {
      this.#timer = setInterval(() => {
        this.#frame = (this.#frame + 1) % frames.length;
        this.#tui.requestRender();
      }, intervalMs);
    }
    this.#tui.requestRender();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  render(width: number): string[] {
    const animation = this.#animation();
    const frame = animation.frames[this.#frame % animation.frames.length] ?? [];
    const drawn = animation === SPINNER ? frame.map((row) => this.#theme.fg("accent", row)) : frame;
    const column = Math.max(0, ...frame.map((row) => visibleWidth(row)));
    const room = Math.max(1, width - column - 3);
    const text = this.#message.split("\n").flatMap((line) => wrapTextWithAnsi(this.#theme.fg("muted", line), room));
    const rows = Math.max(drawn.length, text.length);
    return ["", ...Array.from({ length: rows }, (_, row) =>
      truncateToWidth(` ${drawn[row] ?? " ".repeat(column)} ${text[row] ?? ""}`, width, ""))];
  }

  invalidate(): void {}
}
