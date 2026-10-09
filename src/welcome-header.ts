import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToRgb, foregroundAnsi, truncateToWidth, visibleWidth, type Component }
  from "@earendil-works/pi-tui";
import { MARK_MAX_COLUMNS, MARK_MAX_ROWS, MARK_STAGE_ROWS_PER_60_COLUMNS, markLighting, renderMark, type MarkColors,
  type Rgb } from "./welcome-mark.js";

/** The scene's length: the wind rising and falling once. */
export const WELCOME_SCENE_MS = 9_000;
export const WELCOME_FRAME_MS = 50;
/** A frame that arrives later than this, such as after the terminal was busy, advances by this much at most. */
const LONGEST_STEP_MS = 100;
const MIN_STAGE_ROWS = 8;
export const WELCOME_TAGLINE = "Shows evidence that the change does what you asked.";

/** The background the tree is lit against: Pi's themes do not expose the terminal's own, so each appearance's usual one. */
const background: Readonly<Record<"dark" | "light", Rgb>> = { dark: [32, 32, 32], light: [237, 237, 229] };

function rgb(color: Color): Rgb {
  const { r, g, b } = colorToRgb(color);
  return [r, g, b];
}

/** The tree in the theme's own roles: leaves in its success green, bark between its warning and muted colors, edges
 * lit in its accent and gloss in its text color. */
export function themeMarkColors(theme: Theme): MarkColors {
  const { success, warning, muted, accent, text } = theme.colors;
  const [bark, dust] = [rgb(warning), rgb(muted)];
  return { foliage: rgb(success), wood: [(bark[0] + dust[0]) / 2, (bark[1] + dust[1]) / 2, (bark[2] + dust[2]) / 2],
    rim: rgb(accent), foreground: rgb(text) };
}

function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest &&
      typeof manifest.version === "string") return manifest.version;
  } catch { /* A source checkout without a manifest still has an identity. */ }
  return "dev";
}

export interface WelcomeHeaderOptions {
  /** Asks Pi for another render. */
  readonly requestRender: () => void;
  /** Rows of the terminal; the tree takes at most a third of them, leaving room for what Pi shows at startup. */
  readonly terminalRows: () => number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Pi's header in a Tesota session: the palo fierro with a saguaro seedling in its shade and saguaros further off,
 * and beneath it Tesota's name, version, folder and what it does. The wind moves the crown once, then the tree rests
 * for the rest of the session. Its colors follow Pi's active theme.
 */
export class WelcomeHeader implements Component {
  readonly #cwd: string;
  readonly #theme: Theme;
  readonly #options: WelcomeHeaderOptions;
  readonly #version = packageVersion();
  /** How much of the scene has played, in milliseconds. */
  #played = 0;
  #lastFrame: number | undefined;
  #cancelFrame: (() => void) | undefined;
  #cached: { readonly key: string; readonly lines: readonly string[] } | undefined;

  constructor(cwd: string, theme: Theme, options: WelcomeHeaderOptions) {
    // A folder's name could hold control characters; they never reach the terminal as such.
    this.#cwd = Array.from(cwd, (character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? "?" : character;
    }).join("");
    this.#theme = theme;
    this.#options = options;
  }

  /** Whether the scene still has motion to show. */
  get moving(): boolean { return this.#played < WELCOME_SCENE_MS; }

  invalidate(): void { this.#cached = undefined; }

  dispose(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = undefined;
    this.#played = WELCOME_SCENE_MS;
  }

  render(width: number): string[] {
    let columns = Math.min(MARK_MAX_COLUMNS, width - 4);
    let rows = Math.round(columns * MARK_STAGE_ROWS_PER_60_COLUMNS / MARK_MAX_COLUMNS);
    const most = Math.floor(this.#options.terminalRows() / 3);
    if (rows > most) {
      rows = most;
      columns = Math.round(rows * MARK_MAX_COLUMNS / MARK_STAGE_ROWS_PER_60_COLUMNS);
    }
    const lines: string[] = [];
    if (rows >= MIN_STAGE_ROWS && rows <= MARK_MAX_ROWS && columns <= MARK_MAX_COLUMNS) {
      const left = " ".repeat(Math.floor((width - columns) / 2));
      lines.push(...this.#stage(columns, rows).map((line) => left + line), "");
    } else this.#lastFrame = undefined;
    for (const line of this.#text(width)) {
      const fitted = truncateToWidth(line, width);
      lines.push(" ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2))) + fitted);
    }
    return lines;
  }

  #text(width: number): string[] {
    const theme = this.#theme;
    const cwd = this.#cwd.length > width ? `…${this.#cwd.slice(-(width - 1))}` : this.#cwd;
    const version = /^\d/u.test(this.#version) ? `v${this.#version}` : this.#version;
    return [`${theme.bold("Tesota")} ${theme.fg("muted", `(${version})`)}`, theme.fg("muted", cwd),
      theme.fg("muted", WELCOME_TAGLINE)];
  }

  /** Advance the clock by the time since the last drawn frame, then draw the tree's pose for it. */
  #stage(columns: number, rows: number): readonly string[] {
    const now = (this.#options.now ?? Date.now)();
    const step = this.#lastFrame === undefined ? 0 : Math.min(LONGEST_STEP_MS, Math.max(0, now - this.#lastFrame));
    this.#lastFrame = now;
    this.#played = Math.min(WELCOME_SCENE_MS, this.#played + step);
    if (this.moving && this.#cancelFrame === undefined) {
      const setTimer = this.#options.setTimer ?? ((callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      });
      this.#cancelFrame = setTimer(() => {
        this.#cancelFrame = undefined;
        this.#options.requestRender();
      }, WELCOME_FRAME_MS);
    }
    return this.#paint(columns, rows, this.#played / WELCOME_SCENE_MS);
  }

  /** The tree's pose in the theme's colors; Pi renders on every keystroke, so a pose already drawn is reused. */
  #paint(columns: number, rows: number, progress: number): readonly string[] {
    const theme = this.#theme;
    const appearance = theme.appearance;
    const colors = themeMarkColors(theme);
    const mode = theme.getColorMode();
    const key = JSON.stringify([columns, rows, progress, appearance, colors, mode]);
    if (this.#cached?.key === key) return this.#cached.lines;
    const cells = renderMark(columns, rows, progress, markLighting(background[appearance], appearance === "light", colors));
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      for (let column = 0; column < columns; column++) {
        const cell = cells[row * columns + column]!;
        if (cell.dots === 0) { line += " "; continue; }
        const color: Color = { kind: "rgb", r: cell.rgb >> 16 & 255, g: cell.rgb >> 8 & 255, b: cell.rgb & 255 };
        line += foregroundAnsi(color, mode) + String.fromCodePoint(0x2800 + cell.dots);
      }
      lines.push(`${line.trimEnd()}\x1b[39m`);
    }
    this.#cached = { key, lines };
    return lines;
  }
}
