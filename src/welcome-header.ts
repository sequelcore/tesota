import { type Color, backgroundAnsi, colorToRgb, foregroundAnsi, MouseRegion, type TerminalColorMode, type TerminalColors,
  truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult, type Component, visibleWidth, sliceByColumn }
  from "@earendil-works/pi-tui";
import { markPalette, mixMark, renderMark, type MarkName, type MarkColors, type Rgb } from "./welcome-mark.js";
import { markBlooms, type MarkStanding } from "./verification/mark-bloom-rule.js";
import type { Theme } from "./contract.js";
import { homeRelative } from "./footer.js";
import { host } from "./host.js";

export const WELCOME_SCENE_MS = 800;
export const WELCOME_FRAME_MS = 50;
export const WELCOME_STATIC_OPACITY = 0.30;
/** What Tesota is, in one sentence, for `--help`; the welcome screen shows it short enough for its row. */
export const TAGLINE = "A coding agent that checks its code, challenges its specs, and flags where they may miss your request.";
export const WELCOME_TAGLINE = "Checks the code. Challenges the spec. Flags the gap.";
const fallbackBackground: Readonly<Record<"dark" | "light", Rgb>> = { dark: [32, 32, 32], light: [237, 237, 229] };

function rgb(color: Color | undefined): Rgb {
  if (color === undefined) return [128, 128, 128];
  const { r, g, b } = colorToRgb(color);
  return [r, g, b];
}

/** The flat inks follow the theme roles in both appearances. */
export function themeMarkColors(theme: Theme): MarkColors {
  const { success, warning, muted, accent, text } = theme.colors;
  return { foliage: rgb(success), wood: mixMark(rgb(warning), rgb(muted), 0.5), rim: rgb(accent),
    foreground: rgb(text), muted: rgb(muted) };
}

export interface WelcomeHeaderOptions {
  readonly requestRender: () => void;
  readonly terminalRows: () => number;
  readonly stageShare: number;
  readonly model?: () => string;
  readonly standing?: () => MarkStanding;
  readonly working?: () => boolean;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void;
}

/** A four-row header and separate live-only splash, sharing a bounded, on-demand rustle. */
export class WelcomeHeader implements Component {
  readonly #cwd: string;
  readonly #theme: Theme;
  readonly #options: WelcomeHeaderOptions;
  readonly #version = host().version;
  #started: number | undefined;
  #played = 0;
  #disposed = false;
  #leaf = false;
  #headerWidth = 0;
  #drawnStage: { readonly top: number; readonly left: number; readonly rows: number; readonly columns: number } | undefined;
  #cancelFrame: (() => void) | undefined;
  #background: Rgb | undefined;

  constructor(cwd: string, theme: Theme, options: WelcomeHeaderOptions) {
    this.#cwd = Array.from(homeRelative(cwd), (character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? "?" : character;
    }).join("");
    this.#theme = theme;
    this.#options = options;
  }

  #colored(): boolean { return this.#theme.getBgAnsi("userMessageBg") !== ""; }
  get moving(): boolean {
    return !this.#disposed && this.#colored() && !this.#options.working?.() && this.#played < WELCOME_SCENE_MS;
  }
  invalidate(): void { /* The tiny grids are rendered directly; no palette cache to invalidate. */ }
  setBackground(background: Rgb): void { this.#background = background; }
  dispose(): void {
    this.#cancelFrame?.(); this.#cancelFrame = undefined; this.#disposed = true;
  }
  #gesture(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.#disposed || !this.#colored() || this.#options.working?.() || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
    // Claim the press so Pi routes its eventual click here; a press alone never animates.
    if (event.type === "press") return { handled: true };
    if (event.type !== "click") return undefined;
    this.#cancelFrame?.(); this.#cancelFrame = undefined;
    this.#played = 0; this.#started = undefined; this.#leaf = true;
    return { handled: true, render: true };
  }
  click(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const stage = this.#drawnStage;
    if (stage === undefined || event.y < stage.top || event.y >= stage.top + stage.rows || event.x < stage.left || event.x >= stage.left + stage.columns) return undefined;
    return this.#gesture(event);
  }
  clickHeader(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.x < 0 || event.x >= Math.min(11, this.#headerWidth) || event.y < 0 || event.y >= 3) return undefined;
    return this.#gesture(event);
  }

  render(width: number): string[] {
    this.#headerWidth = width;
    const progress = this.#advance();
    const mark = this.#paint(markBlooms(this.#options.standing?.() ?? "none") ? "small-bloom" : "small", progress, 1);
    const text = this.#text(Math.max(0, width - 13));
    return mark.map((row, index) => truncateToWidth(row + "  " + (text[index] ?? ""), width, ""));
  }

  renderStage(width: number, availableRows: number = Math.floor(this.#options.terminalRows() * this.#options.stageShare)): string[] {
    const rows = 9;
    const columns = 49;
    if (width < columns || Math.min(availableRows, Math.floor(this.#options.terminalRows() * this.#options.stageShare)) < rows) {
      this.pause(); return [];
    }
    const left = Math.floor((width - columns) / 2);
    const top = Math.floor((availableRows - rows) / 2);
    this.#drawnStage = { top, left, rows, columns };
    return [...Array<string>(top).fill(""), ...this.#paint("large", this.#advance(), WELCOME_STATIC_OPACITY).map((line) => " ".repeat(left) + line),
      ...Array<string>(availableRows - rows - top).fill("")];
  }
  pause(): void { this.#drawnStage = undefined; }

  #text(width: number): string[] {
    const theme = this.#theme;
    const model = this.#options.model?.();
    const room = Math.max(0, width - (model === undefined || model === "" ? 0 : visibleWidth(model) + 3));
    const cwdWidth = visibleWidth(this.#cwd);
    const cwd = cwdWidth <= room ? this.#cwd : room <= 1 ? "…".slice(0, room)
      : `…${sliceByColumn(this.#cwd, cwdWidth - room + 1, room - 1)}`;
    const version = /^\d/u.test(this.#version) ? `v${this.#version}` : this.#version;
    return [`\x1b[1mTesota\x1b[22m ${theme.fg("muted", version)}`, theme.fg("muted", [model, cwd].filter(Boolean).join(" · ")),
      theme.fg("muted", WELCOME_TAGLINE)];
  }

  #advance(): number {
    if (this.#disposed) return 0;
    if (!this.#colored() || this.#options.working?.()) {
      this.#played = WELCOME_SCENE_MS;
      this.#cancelFrame?.(); this.#cancelFrame = undefined;
      return 0;
    }
    if (this.#played >= WELCOME_SCENE_MS) return 1;
    const now = (this.#options.now ?? Date.now)();
    this.#started ??= now;
    this.#played = Math.min(WELCOME_SCENE_MS, Math.max(0, now - this.#started));
    if (this.moving && this.#cancelFrame === undefined) {
      const setTimer = this.#options.setTimer ?? ((callback, delay) => {
        const timer = setTimeout(callback, delay); return () => clearTimeout(timer);
      });
      this.#cancelFrame = setTimer(() => {
        this.#cancelFrame = undefined;
        if (!this.#disposed) this.#options.requestRender();
      }, WELCOME_FRAME_MS);
    }
    return this.#played / WELCOME_SCENE_MS;
  }

  #paint(name: MarkName, progress: number, opacity: number): string[] {
    const colored = this.#colored();
    const mode = this.#theme.getColorMode();
    const background = this.#background ?? fallbackBackground[this.#theme.appearance];
    const palette = markPalette(themeMarkColors(this.#theme));
    const ansi = (ink: Exclude<import("./welcome-mark.js").Ink, ".">, bg = false): string => {
      const [r, g, b] = mixMark(background, palette[ink], opacity);
      return (bg ? backgroundAnsi : foregroundAnsi)({ kind: "rgb", r, g, b }, mode);
    };
    return renderMark(name, progress, this.#leaf, colored).map((row) => row.map(({ top, bottom, glyph }) => {
      if (!colored) return glyph;
      if (top === "." && bottom === ".") return "\x1b[39;49m ";
      const fg = top === "." ? bottom : top;
      if (fg === ".") return " ";
      const bg = glyph === "▀" && bottom !== "." ? ansi(bottom, true) : "\x1b[49m";
      return ansi(fg) + bg + glyph;
    }).join("") + (colored ? "\x1b[39;49m" : ""));
  }
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
  tui: Pick<TUI, "queryTerminalColors" | "onTerminalColorSchemeChange" | "requestRender">): Component & {
  emptyState: MouseRegion & { renderIn(width: number, rows: number): string[]; pause(): void };
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
  const emptyState = Object.assign(new MouseRegion({ render: (width) => header.renderStage(width),
    invalidate: () => header.invalidate() }, (event) => header.click(event)), {
    renderIn: (width: number, rows: number) => header.renderStage(width, rows), pause: () => header.pause(),
  });
  const mark = new MouseRegion(header, (event) => header.clickHeader(event));
  return { render: (width) => mark.render(width), handleMouse: (event) => mark.handleMouse(event), invalidate: () => header.invalidate(), emptyState, dispose: () => {
    disposed = true;
    stopListening();
    header.dispose();
  } };
}
