import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToRgb, foregroundAnsi, MouseRegion, type TerminalColors, truncateToWidth, type TUI,
  type TuiMouseEvent, type TuiMouseEventResult, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { MARK_MAX_COLUMNS, MARK_MAX_ROWS, MARK_STAGE_ROWS_PER_60_COLUMNS, markLighting, renderMark, type MarkColors,
  type Rgb } from "./welcome-mark.js";

/** The scene's length: the wind rising and falling, and on a replay the tumbleweed's pass. */
export const WELCOME_SCENE_MS = 9_000;
export const WELCOME_FRAME_MS = 50;
/** A frame that arrives later than this, such as after the terminal was busy, advances by this much at most. */
const LONGEST_STEP_MS = 100;
const MIN_STAGE_ROWS = 8;
export const WELCOME_TAGLINE = "Shows evidence that the change does what you asked.";

/** The background the tree is lit against until the terminal reports its own, or when it never does: each
 * appearance's usual one, the canvas Tesota's palettes are drawn for. */
const fallbackBackground: Readonly<Record<"dark" | "light", Rgb>> = { dark: [32, 32, 32], light: [237, 237, 229] };

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
  /** Rows of the terminal; the tree takes at most `stageShare` of them. */
  readonly terminalRows: () => number;
  /** The share of the terminal's rows the tree may take: less where Pi lists what it loaded beneath the header. */
  readonly stageShare: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Pi's header in a Tesota session: the palo fierro with a saguaro seedling in its shade and saguaros further off,
 * and beneath it Tesota's name, version, folder and what it does. The wind moves the crown once, then the tree rests
 * for the rest of the session; a click on the resting tree (`click`) plays the scene again with a tumbleweed blowing
 * through. Its colors follow Pi's active theme.
 */
export class WelcomeHeader implements Component {
  readonly #cwd: string;
  readonly #theme: Theme;
  readonly #options: WelcomeHeaderOptions;
  readonly #version = packageVersion();
  /** How much of the scene has played, in milliseconds. */
  #played = 0;
  /** Whether the tumbleweed blows through: from the first click on, not at the opening. */
  #visitor = false;
  /** Where the last render drew the tree, in the header's own rows and columns. */
  #drawnStage: { readonly left: number; readonly rows: number; readonly columns: number } | undefined;
  #lastFrame: number | undefined;
  #cancelFrame: (() => void) | undefined;
  #cached: { readonly key: string; readonly lines: readonly string[] } | undefined;
  /** The terminal's own background, once it reports one. */
  #background: Rgb | undefined;

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

  /** The terminal's own background, which the tree is lit against from now on. */
  setBackground(background: Rgb): void { this.#background = background; }

  dispose(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = undefined;
    this.#played = WELCOME_SCENE_MS;
  }

  /**
   * A plain left click on the resting tree plays the scene again, with the tumbleweed; one during a replay or the
   * opening only keeps it playing. Other gestures, and clicks beside the tree, keep their usual owner.
   */
  click(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const stage = this.#drawnStage;
    if (stage === undefined || event.type !== "click" || event.button !== "left" || event.shift || event.alt ||
      event.ctrl) return undefined;
    if (event.y < 0 || event.y >= stage.rows || event.x < stage.left || event.x >= stage.left + stage.columns) {
      return undefined;
    }
    if (!this.moving) {
      this.#played = 0;
      this.#visitor = true;
      this.#lastFrame = undefined;
    }
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    let columns = Math.min(MARK_MAX_COLUMNS, width - 4);
    let rows = Math.round(columns * MARK_STAGE_ROWS_PER_60_COLUMNS / MARK_MAX_COLUMNS);
    const most = Math.floor(this.#options.terminalRows() * this.#options.stageShare);
    if (rows > most) {
      rows = most;
      columns = Math.round(rows * MARK_MAX_COLUMNS / MARK_STAGE_ROWS_PER_60_COLUMNS);
    }
    const lines: string[] = [];
    if (rows >= MIN_STAGE_ROWS && rows <= MARK_MAX_ROWS && columns <= MARK_MAX_COLUMNS) {
      const left = Math.floor((width - columns) / 2);
      this.#drawnStage = { left, rows, columns };
      lines.push(...this.#stage(columns, rows).map((line) => " ".repeat(left) + line), "");
    } else {
      this.#drawnStage = undefined;
      this.#lastFrame = undefined;
    }
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
    const background = this.#background ?? fallbackBackground[appearance];
    const key = JSON.stringify([columns, rows, progress, this.#visitor, appearance, colors, mode, background]);
    if (this.#cached?.key === key) return this.#cached.lines;
    const cells = renderMark(columns, rows, progress, markLighting(background, appearance === "light", colors),
      this.#visitor);
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

/** How long the header waits for the terminal's colors before a late reply is applied as it arrives. */
const COLOR_QUERY_MS = 200;

/**
 * The header as Pi mounts it: the tree inside a `MouseRegion`, which receives clicks where Pi routes the mouse to
 * components (its fullscreen mode); elsewhere the scene plays once. It asks the terminal for its background (OSC 11),
 * at once and whenever the terminal turns light or dark, and lights the tree against it; a terminal that never
 * answers leaves the tree on its appearance's usual background.
 */
export function mountWelcomeHeader(header: WelcomeHeader,
  tui: Pick<TUI, "queryTerminalColors" | "onTerminalColorSchemeChange" | "requestRender">): MouseRegion & {
  dispose(): void;
} {
  let disposed = false;
  const apply = (colors: TerminalColors): void => {
    if (disposed || colors.background === undefined) return;
    const { r, g, b } = colors.background;
    header.setBackground([r, g, b]);
    tui.requestRender();
  };
  const ask = (): void => { void tui.queryTerminalColors({ timeoutMs: COLOR_QUERY_MS, onLateReply: apply }).then(apply); };
  ask();
  const stopListening = tui.onTerminalColorSchemeChange(ask);
  return Object.assign(new MouseRegion(header, (event) => header.click(event)), { dispose: () => {
    disposed = true;
    stopListening();
    header.dispose();
  } });
}
