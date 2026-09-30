// The lit, extruded and Braille-rasterized mark adapts the method of the Codex
// welcome blossom (codex-rs/tui/src/empty_state_animation, openai/codex c9b3924a62).
// The palo fierro silhouette, its materials and palettes are Tesota's own.

export const MARK_MAX_COLUMNS = 60;
export const MARK_MAX_ROWS = 24;
/** Columns to rows of the stage the mark is drawn for; its projection assumes this proportion. */
export const MARK_STAGE_ROWS_PER_60_COLUMNS = 21;

const GRID = 160;
const EXTENT = 1.08;
const STEP = EXTENT * 2 / (GRID - 1);
const TAU = Math.PI * 2;
const DOT_BITS = [1, 8, 2, 16, 4, 32, 64, 128] as const;
const WOBBLE = 0.11;
const GRAIN_PHASE = 3.9;
/** Virtual-canvas units per unit of the mark, on the 800 by 550 stage. */
const SCALE = 250;

export type Rgb = readonly [number, number, number];

interface Material {
  /** Half the slab's thickness, and the radius of the rounded edge that meets its faces. */
  readonly halfDepth: number;
  readonly bevel: number;
}

/** Foliage is a thick, rounded cushion; wood is thin enough that its bevel makes it a limb. */
const FOLIAGE: Material = { halfDepth: 0.26, bevel: 0.2 };
const WOOD: Material = { halfDepth: 0.075, bevel: 0.07 };

type Point = readonly [number, number];

/** Signed distance to an ellipse, approximate but monotone; positive inside. */
function ellipse([x, y]: Point, [cx, cy]: Point, [rx, ry]: Point): number {
  return (1 - Math.hypot((x - cx) / rx, (y - cy) / ry)) * Math.min(rx, ry);
}

/** A limb from a to b whose radius tapers from ra to rb; positive inside. */
function limb([x, y]: Point, [ax, ay]: Point, [bx, by]: Point, ra: number, rb: number): number {
  const [px, py, dx, dy] = [x - ax, y - ay, bx - ax, by - ay];
  const h = Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return ra + (rb - ra) * h - Math.hypot(px - dx * h, py - dy * h);
}

function smoothMax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + 0.5 * (a - b) / k));
  return b + (a - b) * h + k * h * (1 - h);
}

/** A crown lobe with a scalloped, leafy edge. */
function lobe(p: Point, center: Point, radii: Point, leaves: number, turn: number): number {
  const angle = Math.atan2((p[1] - center[1]) / radii[1], (p[0] - center[0]) / radii[0]);
  return ellipse(p, center, radii) + Math.sin(angle * leaves + turn) * 0.022;
}

interface Part {
  readonly material: Material;
  readonly foliage: boolean;
  /** How far the part stands in front of the trunk's plane. */
  readonly offset: number;
  readonly shape: (p: Point) => number;
}

const FORK: Point = [-0.06, 0.22];

/**
 * The palo fierro as the welcome drew it: a low front crown on the left, a wide rear crown on the right and a
 * crown between them, over a short trunk that forks into three limbs, on spread roots. Each crown stands at its
 * own depth, so turning shows the tree's volume.
 */
const PARTS: readonly Part[] = [
  { material: FOLIAGE, foliage: true, offset: -0.2, shape: (p) => lobe(p, [0.34, -0.46], [0.66, 0.34], 11, 0.4) },
  { material: FOLIAGE, foliage: true, offset: 0.02, shape: (p) => lobe(p, [-0.02, -0.62], [0.4, 0.27], 9, 1.3) },
  { material: FOLIAGE, foliage: true, offset: 0.22, shape: (p) => lobe(p, [-0.52, -0.3], [0.44, 0.27], 10, 2.1) },
  { material: WOOD, foliage: false, offset: 0, shape: (p) => [
    limb(p, [-0.06, 0.6], FORK, 0.085, 0.065),
    limb(p, FORK, [-0.5, -0.24], 0.06, 0.028),
    limb(p, FORK, [0.0, -0.4], 0.05, 0.028),
    limb(p, FORK, [0.42, -0.26], 0.06, 0.028),
    limb(p, [-0.06, 0.5], [-0.52, 0.76], 0.06, 0.02),
    limb(p, [-0.06, 0.5], [0.4, 0.76], 0.06, 0.02),
    limb(p, [-0.06, 0.56], [-0.1, 0.8], 0.07, 0.03),
  ].reduce((a, b) => smoothMax(a, b, 0.04)) },
];

/** A surface point in the mark's own space, fixed for every frame. */
interface Samples {
  readonly count: number;
  /** x, y, z, nx, ny, nz and grain for each point. */
  readonly values: Float64Array;
  /** 1 for foliage, 0 for wood. */
  readonly foliage: Uint8Array;
}

const SAMPLE_VALUES = 7;
let samples: Samples | undefined;

/** Every point on the parts' faces, bevels and sides, in drawing order, with its bumped normal and grain. */
function surface(): Samples {
  if (samples !== undefined) return samples;
  const values: number[] = [];
  const foliage: number[] = [];
  const add = (x: number, y: number, offset: number, z: number, nx: number, ny: number, nz: number,
    leaves: boolean, bumpy: boolean): void => {
    if (bumpy) {
      // Leaf clumps: a low, irregular swell across the crown's faces.
      const u = x * 7.3 + y * 2.1;
      const v = y * 8.9 - x * 1.7;
      z += Math.sign(z) * (Math.sin(u) * 0.03 + Math.sin(v) * 0.022);
      nx -= nz * (Math.cos(u) * 0.22 - Math.cos(v) * 0.05);
      ny -= nz * (Math.cos(u) * 0.06 + Math.cos(v) * 0.2);
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length; ny /= length; nz /= length;
    }
    values.push(x, y, z + offset, nx, ny, nz, Math.sin(x * 23 + y * 19 + GRAIN_PHASE) * 0.01);
    foliage.push(leaves ? 1 : 0);
  };
  for (const part of PARTS) {
    const distance = new Float32Array(GRID * GRID);
    for (let row = 0; row < GRID; row++) {
      for (let column = 0; column < GRID; column++) {
        distance[row * GRID + column] = part.shape([column * STEP - EXTENT, row * STEP - EXTENT]);
      }
    }
    const { material, offset } = part;
    for (let row = 1; row < GRID - 1; row++) {
      for (let column = 1; column < GRID - 1; column++) {
        const i = row * GRID + column;
        const d = distance[i]!;
        if (d < -STEP) continue;
        const x = column * STEP - EXTENT;
        const y = row * STEP - EXTENT;
        const dx = distance[i + 1]! - distance[i - 1]!;
        const dy = distance[i + GRID]! - distance[i - GRID]!;
        const length = Math.hypot(dx, dy) || 1;
        const gx = dx / length;
        const gy = dy / length;
        if (d > 0) {
          const edge = Math.min(1, Math.max(0, 1 - d / material.bevel));
          const nz = Math.sqrt(1 - edge * edge);
          const z = material.halfDepth - material.bevel + material.bevel * nz;
          add(x, y, offset, z, -gx * edge, -gy * edge, nz, part.foliage, part.foliage);
          add(x, y, offset, -z, -gx * edge, -gy * edge, -nz, part.foliage, part.foliage);
        }
        if (Math.abs(d) < STEP * 0.8) {
          const side = material.halfDepth - material.bevel;
          const layers = Math.ceil(side * 2 / STEP);
          for (let layer = 0; layer <= layers; layer++) {
            add(x - gx * d, y - gy * d, offset, layers === 0 ? 0 : -side + layer / layers * side * 2,
              -gx, -gy, 0, part.foliage, false);
          }
        }
      }
    }
  }
  samples = { count: foliage.length, values: Float64Array.from(values), foliage: Uint8Array.from(foliage) };
  return samples;
}

export interface MarkPalette {
  readonly key: Rgb;
  readonly shadow: Rgb;
  readonly fill: Rgb;
}

export interface MarkLighting {
  readonly background: Rgb;
  readonly foliage: MarkPalette;
  readonly wood: MarkPalette;
  readonly rim: Rgb;
  readonly highlight: Rgb;
}

/** The colors a lighting is built from: each material's own, the light along its edges, and the terminal's text. */
export interface MarkColors {
  readonly foliage: Rgb;
  readonly wood: Rgb;
  readonly rim: Rgb;
  /** The gloss on a dark background, and the ink shadows deepen toward on a light one. */
  readonly foreground: Rgb;
}

function mix(from: Rgb, to: Rgb, share: number): Rgb {
  return [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share, from[2] + (to[2] - from[2]) * share];
}

/**
 * Studio lighting over a dark or light terminal background. On a dark background shadows sink toward it; on a light
 * one the mark is ink, so shadows deepen toward the foreground and nothing is paler than a material's own color.
 */
export function markLighting(background: Rgb, light: boolean, colors: MarkColors): MarkLighting {
  // A theme's role colors are tuned for text, so the lit side is lifted from them and the shadows fall away from them.
  const material = (color: Rgb): MarkPalette => {
    if (light) return { key: mix(color, background, 0.3), shadow: mix(color, colors.foreground, 0.5), fill: color };
    const key = mix(color, colors.foreground, 0.25);
    return { key, shadow: mix(key, background, 0.65), fill: mix(key, background, 0.35) };
  };
  return {
    background,
    foliage: material(colors.foliage),
    wood: material(colors.wood),
    rim: colors.rim,
    highlight: light ? mix(colors.foliage, background, 0.4) : colors.foreground,
  };
}

function shade(light: MarkLighting, palette: MarkPalette, [nx, ny, nz]: readonly [number, number, number],
  depth: number, grain: number): number {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const diffuse = clamp(nx * -0.41 + ny * -0.564 + nz * 0.718 + grain);
  const bounce = clamp(nx * 0.55 + ny * 0.2 - nz * 0.35) * (1 - diffuse) * 0.38;
  const edge = (1 - Math.abs(Math.min(1, Math.max(-1, nz)))) ** 2.4 * clamp(nx * 0.85 - ny * 0.38) * 0.82;
  const gloss = clamp(nx * -0.22 + ny * -0.302 + nz * 0.928) ** 18 * 0.6;
  const base = (1 - bounce) * (1 - edge) * (1 - gloss);
  const gain = Math.min(1, Math.max(0.68, 0.9 + depth * 0.18));
  let rgb = 0;
  for (let i = 0; i < 3; i++) {
    const value = palette.shadow[i]! * (1 - diffuse) * base + palette.key[i]! * diffuse * base +
      palette.fill[i]! * bounce * (1 - edge) * (1 - gloss) + light.rim[i]! * edge * (1 - gloss) +
      light.highlight[i]! * gloss;
    const background = light.background[i]!;
    rgb = rgb << 8 | Math.min(255, Math.max(0, Math.round(background + (value - background) * gain)));
  }
  return rgb;
}

function smooth(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface MarkCell {
  /** Braille dots, as the offset from U+2800; 0 leaves the cell empty. */
  readonly dots: number;
  /** 0xRRGGBB, the average of the lit dots. */
  readonly rgb: number;
}

/**
 * One frame of the mark turning about its trunk: two eased turns per loop, resting face-on at every half loop.
 * Deterministic for its inputs; the caller owns timing.
 */
export function renderMark(columns: number, rows: number, phase: number, light: MarkLighting): MarkCell[] {
  if (columns > MARK_MAX_COLUMNS || rows > MARK_MAX_ROWS) throw new RangeError("the mark's stage is too large");
  const loop = ((phase % 1) + 1) % 1;
  const second = loop >= 0.5 ? 1 : 0;
  const rotation = (second + smooth((loop * 2 - second) / 0.82)) * TAU;
  const [sx, cx] = [Math.sin(Math.sin(rotation) * WOBBLE), Math.cos(Math.sin(rotation) * WOBBLE)];
  const [sy, cy] = [Math.sin(rotation), Math.cos(rotation)];
  const roll = Math.sin(loop * TAU) * 0.045;
  const [sz, cz] = [Math.sin(roll), Math.cos(roll)];
  const dotColumns = columns * 2;
  const dotRows = rows * 4;
  const dotWidth = 800 / dotColumns;
  const dotHeight = 550 / dotRows;
  const dots = dotColumns * dotRows;
  const depthBuffer = new Float32Array(dots).fill(Number.NEGATIVE_INFINITY);
  const winner = new Int32Array(dots);
  const colors = new Uint32Array(dots);
  const { count, values, foliage } = surface();

  // Project every point, keeping the nearest at each dot; only the winners are lit afterwards.
  for (let point = 0; point < count; point++) {
    const k = point * SAMPLE_VALUES;
    const x = values[k]!;
    const y = values[k + 1]!;
    const z = values[k + 2]!;
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    const x3 = x1 * cz - y2 * sz;
    const y3 = x1 * sz + y2 * cz;
    const perspective = 4.4 / (4.4 - z2);
    const column = Math.floor((400 + x3 * SCALE * perspective) / dotWidth);
    const row = Math.floor((275 + (y3 - 0.02) * SCALE * perspective) / dotHeight);
    if (column < 0 || column >= dotColumns || row < 0 || row >= dotRows) continue;
    const i = row * dotColumns + column;
    if (z2 <= depthBuffer[i]!) continue;
    depthBuffer[i] = z2;
    winner[i] = point;
  }
  for (let i = 0; i < dots; i++) {
    if (depthBuffer[i] === Number.NEGATIVE_INFINITY) continue;
    const point = winner[i]!;
    const k = point * SAMPLE_VALUES;
    const [x, y, z] = [values[k]!, values[k + 1]!, values[k + 2]!];
    const [nx, ny, nz] = [values[k + 3]!, values[k + 4]!, values[k + 5]!];
    const z2 = y * sx + (-x * sy + z * cy) * cx;
    const nx1 = nx * cy + nz * sy;
    const nz1 = -nx * sy + nz * cy;
    const ny2 = ny * cx - nz1 * sx;
    const nz2 = ny * sx + nz1 * cx;
    colors[i] = shade(light, foliage[point] === 1 ? light.foliage : light.wood,
      [nx1 * cz - ny2 * sz, nx1 * sz + ny2 * cz, nz2], z2, values[k + 6]!);
  }

  const cells: MarkCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let [dots, count, r, g, b] = [0, 0, 0, 0, 0];
      for (const [point, bit] of DOT_BITS.entries()) {
        const i = (row * 4 + (point >> 1)) * dotColumns + column * 2 + (point & 1);
        if (!Number.isFinite(depthBuffer[i]!)) continue;
        dots |= bit;
        const rgb = colors[i]!;
        r += rgb >> 16 & 255; g += rgb >> 8 & 255; b += rgb & 255;
        count++;
      }
      cells.push({ dots, rgb: count === 0 ? 0 :
        Math.round(r / count) << 16 | Math.round(g / count) << 8 | Math.round(b / count) });
    }
  }
  return cells;
}
