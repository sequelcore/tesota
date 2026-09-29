import { TuiAltScreen } from "@earendil-works/pi-tui";

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
