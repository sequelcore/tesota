import { backgroundAnsi, type Color, colorToRgb, foregroundAnsi, type TerminalColorMode } from "@earendil-works/pi-tui";
import type { IndicatorAnimation, Theme, WorkingIndicator, WorkPhase } from "./contract.js";

/**
 * The working orb (#749): a small lit sphere in half blocks, four columns by two rows, so its pixels are square and
 * it is round. Each phase has its own motion, so the orb says what the run is doing: the model at work turns it, the
 * gate verifying scans it in the accent, compacting condenses it, and waiting to retry only pulses, dim.
 */
export const ORB_FRAME_MS = 80;
const COLUMNS = 4;
const ROWS = 2;
/** Samples per pixel along each axis, so the sphere's edge blends into the canvas and reads as round. */
const SAMPLES = 5;
type Rgb = readonly [number, number, number];
type Motion = "turn" | "scan" | "condense" | "wait";

const MOTIONS: Readonly<Record<WorkPhase, { readonly motion: Motion; readonly seconds: number; readonly accent: boolean }>> = {
  working: { motion: "turn", seconds: 2.4, accent: false },
  verifying: { motion: "scan", seconds: 1.6, accent: true },
  compacting: { motion: "condense", seconds: 2.0, accent: false },
  retrying: { motion: "wait", seconds: 3.2, accent: false },
};

/** A still sphere in the terminal's own color, for a terminal that shows no extended colors. */
const SILHOUETTE: readonly string[] = ["▗██▖", "▝██▘"];

const rgb = (color: Color | undefined, fallback: Rgb): Rgb => {
  if (color === undefined) return fallback;
  const { r, g, b } = colorToRgb(color);
  return [r, g, b];
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => {
  const k = Math.max(0, Math.min(1, t));
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
};

/** How much ink the sphere shows at (x, y) in [-1, 1]² when its loop is at `phase` in [0, 1); undefined outside it. */
function surface(motion: Motion, x0: number, y0: number, phase: number): number | undefined {
  const radius = motion === "condense" ? 1 - 0.32 * Math.sin(phase * Math.PI) ** 2 : 1;
  const x = x0 / radius, y = y0 / radius, rr = x * x + y * y;
  if (rr > 1) return undefined;
  const z = Math.sqrt(1 - rr);
  // Light from the top left, the way the eye reads a sphere at rest.
  const lit = Math.max(0, -0.35 * x - 0.45 * y + 0.82 * z);
  switch (motion) {
    // The lit side travels around the vertical axis: the edge of the light sweeps left to right, again and again.
    case "turn": {
      const angle = phase * Math.PI * 2;
      return 0.12 + 0.88 * Math.max(0, Math.sin(angle) * x - 0.25 * y + Math.cos(angle) * z);
    }
    // A bright band runs down the sphere, top to bottom, over its dim lit body.
    case "scan": return 0.18 + 0.35 * lit + 0.75 * Math.exp(-((y - (-1.3 + phase * 2.6)) ** 2) * 10);
    // The sphere draws in and recovers, brightening as it packs.
    case "condense": return 0.15 + 0.7 * lit + 0.25 * Math.sin(phase * Math.PI) ** 2;
    // A slow, low pulse; nothing moves.
    case "wait": return (0.1 + 0.45 * lit) * (0.55 + 0.45 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2)));
  }
}

/** One frame's rows: each cell's top pixel in the foreground and its bottom pixel in the background color. */
function frame(motion: Motion, phase: number, ink: Rgb, canvas: Rgb, mode: TerminalColorMode): string[] {
  const pixel = (column: number, row: number): Rgb => {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
      const x = ((column + (sx + 0.5) / SAMPLES) / COLUMNS - 0.5) * 2;
      const y = ((row + (sy + 0.5) / SAMPLES) / (ROWS * 2) - 0.5) * 2;
      const shown = surface(motion, x, y, phase);
      const [cr, cg, cb] = shown === undefined ? canvas : mix(canvas, ink, shown);
      r += cr; g += cg; b += cb;
    }
    const n = SAMPLES * SAMPLES;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  const ansi = ([r, g, b]: Rgb, as: typeof foregroundAnsi): string => as({ kind: "rgb", r, g, b }, mode);
  return Array.from({ length: ROWS }, (_, row) => Array.from({ length: COLUMNS }, (_, column) =>
    `${ansi(pixel(column, row * 2), foregroundAnsi)}${ansi(pixel(column, row * 2 + 1), backgroundAnsi)}▀`).join("") + "\x1b[39;49m");
}

const cache = new WeakMap<Theme, { readonly key: string; readonly indicator: WorkingIndicator }>();

/** The orb for each phase in the theme's colors and color mode, computed once per palette; the shell replays the frames. */
export function workingOrb(theme: Theme): WorkingIndicator {
  const mode = theme.getColorMode();
  const colored = theme.getBgAnsi("userMessageBg") !== "";
  const canvas = rgb(theme.colors["pageBg"], theme.appearance === "light" ? [250, 250, 250] : [15, 15, 16]);
  const text = rgb(theme.colors["text"], [128, 128, 128]);
  const accent = rgb(theme.colors["accent"], text);
  const key = JSON.stringify([colored, mode, canvas, text, accent]);
  const cached = cache.get(theme);
  if (cached?.key === key) return cached.indicator;
  const animation = (phase: WorkPhase): IndicatorAnimation => {
    if (!colored) return { frames: [SILHOUETTE], intervalMs: ORB_FRAME_MS };
    const { motion, seconds, accent: tinted } = MOTIONS[phase];
    const count = Math.round((seconds * 1000) / ORB_FRAME_MS);
    return { frames: Array.from({ length: count }, (_, index) => frame(motion, index / count, tinted ? accent : text, canvas, mode)),
      intervalMs: ORB_FRAME_MS };
  };
  const indicator: WorkingIndicator = { phases: { working: animation("working"), verifying: animation("verifying"),
    compacting: animation("compacting"), retrying: animation("retrying") } };
  cache.set(theme, { key, indicator });
  return indicator;
}
