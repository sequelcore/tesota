import { readFileSync } from "node:fs";
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult }
  from "@earendil-works/pi-tui";
import { bold, mutedText, tesotaShellTheme, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { safeTerminalText } from "./tesota-shell-transcript.js";
import { MARK_MAX_COLUMNS, MARK_MAX_ROWS, MARK_STAGE_ROWS_PER_60_COLUMNS, markLighting, renderMark, type MarkColors,
  type Rgb }
  from "./welcome-mark.js";

/** The scene's length: the wind rising and falling, and on a replay the tumbleweed's pass. */
export const WELCOME_SCENE_MS = 9_000;
export const WELCOME_FRAME_MS = 50;
const FADE_MS = 400;
/** How visible the tree stays while the terminal is unfocused. */
export const WELCOME_FADED_OPACITY = 0.18;
/** A frame that arrives later than this, such as after the session was hidden, advances by this much at most. */
const LONGEST_STEP_MS = 100;
const MIN_STAGE_ROWS = 8;
const HEADER_ROWS = 3;

const fallbackBackground: Readonly<Record<"dark" | "light", Rgb>> = { dark: [22, 21, 26], light: [250, 248, 244] };

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The tree in the theme's own roles: leaves in its success green, bark between its warning and muted colors, edges
 * lit in its accent and gloss in its foreground. A theme that leaves colors to the terminal lends Tesota's own.
 */
export function themeMarkColors(theme: TesotaShellTheme): MarkColors {
  const { success, warning, muted, accent, foreground } = theme;
  if (success === null || warning === null || muted === null || accent === null || foreground === null) {
    return themeMarkColors(tesotaShellTheme("tesota-dark"));
  }
  const [bark, dust] = [rgb(warning), rgb(muted)];
  return { foliage: rgb(success), wood: [(bark[0] + dust[0]) / 2, (bark[1] + dust[1]) / 2, (bark[2] + dust[2]) / 2],
    rim: rgb(accent), foreground: rgb(foreground) };
}

export type WelcomeColorMode = "truecolor" | "ansi256" | "plain";

export function welcomeColorMode(env: NodeJS.ProcessEnv = process.env): WelcomeColorMode {
  if (env["NO_COLOR"] !== undefined || env["TERM"] === "dumb") return "plain";
  if (env["COLORTERM"]?.includes("truecolor") || env["COLORTERM"]?.includes("24bit")) return "truecolor";
  return env["TERM"]?.includes("256color") ? "ansi256" : "truecolor";
}

function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest &&
      typeof manifest.version === "string") return manifest.version;
  } catch { /* A source checkout without a manifest still has an identity. */ }
  return "dev";
}

function ease(elapsed: number, duration: number): number {
  const t = Math.min(1, elapsed / duration);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function ansi256([r, g, b]: Rgb): number {
  const level = (value: number): number => Math.round(value / 255 * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

export interface WelcomeBannerOptions {
  /** Rows of the conversation's viewport, which the opening fills while the session is empty. */
  readonly viewportHeight: () => number;
  /** Rows the conversation shows beneath the opening, such as replies to the operator, at a width. */
  readonly rowsBelow?: (width: number) => number;
  /** Whether the terminal has focus; the scene plays only then, and the tree fades while it does not. */
  readonly focused?: () => boolean;
  /** Whether the operator has started typing; the tree pauses, without color, while they do. */
  readonly drafting?: () => boolean;
  /** Asks for another render after the delay, while the tree is moving. */
  readonly requestFrame?: (delayMs: number) => void;
  readonly reducedMotion?: boolean;
  readonly colorMode?: WelcomeColorMode;
  readonly now?: () => number;
}

/**
 * A fresh session's opening: the palo fierro in the middle of the empty conversation, with a saguaro seedling in
 * its shade, saguaros further off, and the version and folder beneath it, while the wind moves its crown. A click on
 * the resting scene plays it again with a tumbleweed blowing through. It plays while the terminal has focus and
 * pauses and fades when it loses focus, even at rest; while the operator types it pauses, without color. It leaves
 * at the session's first recorded entry, keeping only the header. It never enters the saved conversation.
 */
export class WelcomeBanner implements Component {
  readonly #cwd: string;
  readonly #theme: TesotaShellTheme;
  readonly #options: WelcomeBannerOptions;
  readonly #mode: WelcomeColorMode;
  readonly #version: string;
  #background: Rgb | undefined;
  #dismissed = false;
  /** How much of the scene has played, in milliseconds. */
  #played: number;
  /** Whether the tumbleweed blows through: from the first click on, not at the opening. */
  #visitor = false;
  #lastFrame: number | undefined;
  #faded: boolean | undefined;
  #fadeElapsed = FADE_MS;
  #fadeFrom = 1;
  #opacity = 1;
  /** Whether the last frame was drawn without color, for the operator's draft. */
  #plain = false;
  #drawnHeight: number | undefined;
  /** Where the last render drew the tree, in the banner's own rows and columns. */
  #drawnStage: { readonly top: number; readonly left: number; readonly rows: number; readonly columns: number } | undefined;
  readonly #reducedMotion: boolean;

  constructor(cwd: string, theme: TesotaShellTheme, options: WelcomeBannerOptions) {
    this.#cwd = safeTerminalText(cwd);
    this.#theme = theme;
    this.#options = options;
    this.#mode = options.colorMode ?? welcomeColorMode();
    this.#version = packageVersion();
    this.#reducedMotion = options.reducedMotion === true;
    this.#played = this.#reducedMotion ? WELCOME_SCENE_MS : 0;
  }

  get dismissed(): boolean { return this.#dismissed; }

  /**
   * The viewport height of the last render. pi-tui renders a scroll view's content before it measures the viewport,
   * so a height that differs from the viewport's now calls for one more render.
   */
  get drawnHeight(): number | undefined { return this.#drawnHeight; }

  /** Whether the scene still has motion to show: playing, or fading between its full and faded poses. */
  get moving(): boolean {
    return !this.#dismissed && (this.#played < WELCOME_SCENE_MS || this.#fadeElapsed < FADE_MS);
  }

  /** The session's first entry ends the opening; the header stays above the conversation. */
  dismiss(): void {
    this.#dismissed = true;
    this.#lastFrame = undefined;
  }

  /** The terminal's own background, which fades blend toward; each theme's usual background until it is known. */
  setBackground(background: Rgb): void { this.#background = background; }

  invalidate(): void {}

  /** A plain left click on the resting scene plays it again, with the tumbleweed; other gestures keep their usual owner. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const stage = this.#drawnStage;
    if (this.#dismissed || this.#reducedMotion || stage === undefined || event.type !== "click" ||
      event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
    if (event.y < stage.top || event.y >= stage.top + stage.rows ||
      event.x < stage.left || event.x >= stage.left + stage.columns) return undefined;
    if (this.#played >= WELCOME_SCENE_MS) {
      this.#played = 0;
      this.#visitor = true;
      this.#lastFrame = undefined;
    }
    return { handled: true, render: true };
  }

  render(width: number): string[] {
    const header = this.#header(width);
    if (this.#dismissed) {
      this.#drawnStage = undefined;
      return [...header.map((line) => truncateToWidth(line, width)), ""];
    }
    this.#drawnHeight = this.#options.viewportHeight();
    // Unmeasured until the conversation's first layout; the next frame has its height.
    if (this.#drawnHeight === 0) this.#options.requestFrame?.(0);
    const height = Math.max(this.#drawnHeight - (this.#options.rowsBelow?.(width) ?? 0), HEADER_ROWS);
    let columns = Math.min(MARK_MAX_COLUMNS, width - 4);
    let rows = Math.round(columns * MARK_STAGE_ROWS_PER_60_COLUMNS / MARK_MAX_COLUMNS);
    if (rows + 1 + HEADER_ROWS > height) {
      rows = height - 1 - HEADER_ROWS;
      columns = Math.round(rows * MARK_MAX_COLUMNS / MARK_STAGE_ROWS_PER_60_COLUMNS);
    }
    const block: string[] = [];
    const left = Math.floor((width - columns) / 2);
    const drawn = rows >= MIN_STAGE_ROWS && rows <= MARK_MAX_ROWS && columns <= MARK_MAX_COLUMNS;
    if (drawn) block.push(...this.#stage(columns, rows).map((line) => " ".repeat(left) + line), "");
    else this.#lastFrame = undefined;
    for (const line of header) {
      const fitted = truncateToWidth(line, width);
      block.push(" ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2))) + fitted);
    }
    const top = Math.max(0, Math.floor((height - block.length) / 2));
    this.#drawnStage = drawn ? { top, left, rows, columns } : undefined;
    const lines = [...Array<string>(top).fill(""), ...block];
    while (lines.length < height) lines.push("");
    return lines.slice(0, Math.max(height, block.length));
  }

  #header(width: number): string[] {
    const cwd = this.#cwd.length > width ? `…${this.#cwd.slice(-(width - 1))}` : this.#cwd;
    return [bold(`Tesota ${this.#version}`), mutedText(cwd, this.#theme),
      mutedText("Every turn is reviewed; reverting never overwrites your edits.", this.#theme)];
  }

  /** Advance the clock by the time since the last drawn frame, then draw the tree's pose for it. */
  #stage(columns: number, rows: number): string[] {
    const now = (this.#options.now ?? Date.now)();
    const faded = this.#options.focused?.() === false;
    this.#plain = this.#options.drafting?.() === true;
    const paused = faded || this.#plain;
    const step = this.#lastFrame === undefined ? 0 : Math.min(LONGEST_STEP_MS, Math.max(0, now - this.#lastFrame));
    this.#lastFrame = now;
    if (this.#faded !== faded) {
      // The first pose appears at once; later changes fade from wherever the opacity stands.
      this.#fadeElapsed = this.#faded === undefined ? FADE_MS : 0;
      this.#fadeFrom = this.#opacity;
      this.#faded = faded;
    } else {
      this.#fadeElapsed = Math.min(FADE_MS, this.#fadeElapsed + step);
      if (!paused) this.#played = Math.min(WELCOME_SCENE_MS, this.#played + step);
    }
    const target = faded ? WELCOME_FADED_OPACITY : 1;
    this.#opacity = this.#fadeFrom + (target - this.#fadeFrom) * ease(this.#fadeElapsed, FADE_MS);
    if (this.moving && (!paused || this.#fadeElapsed < FADE_MS)) this.#options.requestFrame?.(WELCOME_FRAME_MS);
    return this.#paint(columns, rows, this.#played / WELCOME_SCENE_MS);
  }

  #paint(columns: number, rows: number, progress: number): string[] {
    const appearance = this.#theme.appearance === "light" ? "light" : "dark";
    const background = this.#background ?? fallbackBackground[appearance];
    const cells = renderMark(columns, rows, progress, markLighting(background, appearance === "light",
      themeMarkColors(this.#theme)), this.#visitor);
    const colored = !this.#plain && this.#mode !== "plain" && this.#theme.appearance !== "terminal";
    const dim = this.#plain || this.#opacity < 0.5;
    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      for (let column = 0; column < columns; column++) {
        const cell = cells[row * columns + column]!;
        if (cell.dots === 0) { line += " "; continue; }
        const glyph = String.fromCodePoint(0x2800 + cell.dots);
        if (!colored) { line += dim ? `\x1b[2m${glyph}\x1b[22m` : glyph; continue; }
        const rgb: Rgb = [cell.rgb >> 16 & 255, cell.rgb >> 8 & 255, cell.rgb & 255].map((channel, i) =>
          Math.round(background[i]! + (channel - background[i]!) * this.#opacity)) as [number, number, number];
        line += this.#mode === "ansi256" ? `\x1b[38;5;${ansi256(rgb)}m${glyph}` : `\x1b[38;2;${rgb.join(";")}m${glyph}`;
      }
      lines.push(colored ? `${line.trimEnd()}\x1b[39m` : line.trimEnd());
    }
    return lines;
  }
}
