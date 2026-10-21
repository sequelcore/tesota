import type { Component } from "@earendil-works/pi-tui";
import type { ShellTheme } from "../../../../src/theme.ts";

/**
 * The frame of everything that takes the input's place and waits for the
 * operator (#531): a bar down its left edge whose color says what it asks,
 * and one title style. Something to approve, a permission, is in the
 * warning color; something to answer or choose is in the accent.
 */
export type FrameTone = "approve" | "answer";

/** How many columns the bar takes from what it frames. */
export const BAR_WIDTH = 2;

/** `lines` with the bar down their left edge; they were drawn `BAR_WIDTH` columns narrower. */
export function barLines(theme: ShellTheme, tone: FrameTone, lines: readonly string[]): string[] {
  const bar = theme.fg(tone === "approve" ? "warning" : "accent", "▌");
  return lines.map((line) => `${bar} ${line}`);
}

/**
 * `inner` in the frame. It is a leaf to the layout, so what scrolls inside
 * a stack (a question taller than the terminal) draws its own bar with
 * `barLines` instead.
 */
export function framed(theme: ShellTheme, tone: FrameTone, inner: Component): Component {
  return {
    invalidate: () => { inner.invalidate(); },
    render: (width) => barLines(theme, tone, inner.render(Math.max(1, width - BAR_WIDTH))),
  };
}

/** The title of what waits in the input's place: the question, the permission or the choice. */
export function frameTitle(theme: ShellTheme, text: string): string {
  return theme.bold(theme.fg("accent", text));
}
