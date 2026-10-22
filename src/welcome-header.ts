import { type Color, colorToRgb, foregroundAnsi, MouseRegion, type TerminalColorMode, type TerminalColors,
  truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth, type Component }
  from "@earendil-works/pi-tui";
import { MARK_MAX_COLUMNS, MARK_MAX_ROWS, MARK_STAGE_ROWS_PER_60_COLUMNS, markLighting, renderMark,
  type MarkCell, type MarkColors, type Rgb } from "./welcome-mark.js";
import type { Theme } from "./contract.js";
import { homeRelative } from "./footer.js";
import { host } from "./host.js";

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

/** A color as red, green and blue; one the theme leaves to the terminal is drawn mid-grey, since the mark needs a value. */
function rgb(color: Color | undefined): Rgb {
  if (color === undefined) return [128, 128, 128];
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
  /** The engine's, as a receipt records it: a binary has no package.json beside it (#472). */
  readonly #version = host().version;
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
    // From `~` under the home folder, as the footer shows it; a folder's name could hold control characters, which never
    // reach the terminal as such.
    this.#cwd = Array.from(homeRelative(cwd), (character) => {
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
    // Bold directly: Pi's theme.bold leaves text plain where its color library detects no color support.
    return [`\x1b[1mTesota\x1b[22m ${theme.fg("muted", `(${version})`)}`, theme.fg("muted", cwd),
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
      lines.push(`${brailleText(cells.slice(row * columns, (row + 1) * columns), mode).trimEnd()}\x1b[39m`);
    }
    this.#cached = { key, lines };
    return lines;
  }
}

/** A row of the mark's cells as terminal text: each cell's braille dots in its color, an empty cell as a space. */
function brailleText(cells: readonly MarkCell[], mode: TerminalColorMode): string {
  return cells.map(({ dots, rgb }) => {
    if (dots === 0) return " ";
    const color: Color = { kind: "rgb", r: rgb >> 16 & 255, g: rgb >> 8 & 255, b: rgb & 255 };
    return foregroundAnsi(color, mode) + String.fromCodePoint(0x2800 + dots);
  }).join("");
}

export const ORB_FRAME_MS = 80;
const FRAME_COUNT = 30;
const TAU = Math.PI * 2;
const BITS = [1, 8, 2, 16, 4, 32, 64, 128] as const;
interface Dot { readonly x: number; readonly y: number; readonly depth: number }
const cache = new WeakMap<Theme, { readonly key: string; readonly frames: string[] }>();

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** Eight wood material levels; the near side is brighter on charcoal, darker on paper. */
function material(theme: Theme): readonly Rgb[] {
  const { wood, foreground, rim } = themeMarkColors(theme);
  const light = theme.appearance === "light";
  const background = colorToRgb(theme.colors["pageBg"] ?? { kind: "rgb", r: 128, g: 128, b: 128 });
  const far = mix(wood, [background.r, background.g, background.b], light ? 0.32 : 0.40);
  const near = mix(mix(wood, foreground, light ? 0.35 : 0.28), rim, 0.08);
  return Array.from({ length: 8 }, (_, level) => mix(far, near, level / 7));
}

/** Z-buffer collisions; each cell takes the depth-weighted average of its visible dots. */
function raster(dots: readonly Dot[], colors: readonly Rgb[], mode: TerminalColorMode): string {
  const grid = new Float64Array(24).fill(-1);
  for (const dot of dots) {
    const x = Math.round(dot.x);
    const y = Math.round(dot.y);
    if (x < 0 || x >= 6 || y < 0 || y >= 4) continue;
    const i = y * 6 + x;
    grid[i] = Math.max(grid[i] ?? -1, dot.depth);
  }
  let line = "";
  for (let col = 0; col < 3; col++) {
    let mask = 0;
    let sum = 0;
    let weights = 0;
    for (let y = 0; y < 4; y++) for (let dx = 0; dx < 2; dx++) {
      const depth = grid[y * 6 + col * 2 + dx] ?? -1;
      if (depth < 0) continue;
      mask |= BITS[y * 2 + dx] ?? 0;
      const weight = 1 + depth * 2;
      sum += depth * weight;
      weights += weight;
    }
    if (mask === 0) { line += " "; continue; }
    const [r, g, b] = colors[Math.round(Math.max(0, Math.min(1, sum / weights)) * 7)] ?? [0, 0, 0];
    line += foregroundAnsi({ kind: "rgb", r, g, b }, mode) + String.fromCodePoint(0x2800 + mask);
  }
  return line + "\x1b[39m";
}

/** Fixed rim and two longitude ribs turning around a fixed 16° axis, on a 6×4 dot grid.
 * Inspired by Jakub Antalik's MIT thinking-orbs; no code from that engine is used. */
function pose(index: number): readonly Dot[] {
  const phase = ((index % FRAME_COUNT + FRAME_COUNT) % FRAME_COUNT) / FRAME_COUNT * TAU;
  const dots: Dot[] = [];
  for (let y = 0; y < 4; y++) {
    const ny = (y - 1.5) / 2.1;
    const extent = Math.sqrt(1 - ny * ny);
    dots.push({ x: 2.5 - 2.5 * extent, y, depth: 0.22 }, { x: 2.5 + 2.5 * extent, y, depth: 0.22 });
  }
  for (const offset of [0, TAU / 3]) {
    const angle = phase + offset;
    const z = Math.cos(angle);
    for (let y = 0; y < 4; y++) {
      // Row-specific thresholds thin rear ribs gradually, without random sparkle.
      const rearCut = y % 4 === 1 ? 0.15 : -0.15;
      if (y % 2 === 1 && z < rearCut) continue;
      const ny = (y - 1.5) / 2.1;
      const radius = Math.sqrt(1 - ny * ny);
      const nx = radius * Math.sin(angle);
      dots.push({ x: 2.5 + 2.5 * (nx * Math.cos(0.28) - ny * Math.sin(0.28)),
        y: 1.5 + 1.5 * (nx * Math.sin(0.28) + ny * Math.cos(0.28)),
        depth: z < 0 ? 0.08 : 0.40 + 0.60 * z * radius });
    }
  }
  return dots;
}

/** A pose at any integer phase; phase 30 is exactly phase zero. No timers or I/O. */
export function orbFrame(theme: Theme, index: number): string {
  return raster(pose(index), material(theme), theme.getColorMode());
}

/** Precompute once per active palette and color mode; the shell only replays these strings. */
export function orbFrames(theme: Theme): string[] {
  const colors = material(theme);
  const mode = theme.getColorMode();
  const key = JSON.stringify([colors, mode]);
  const previous = cache.get(theme);
  if (previous?.key === key) return previous.frames;
  const frames = Array.from({ length: FRAME_COUNT }, (_, index) => raster(pose(index), colors, mode));
  cache.set(theme, { key, frames });
  return frames;
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
