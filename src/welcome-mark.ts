// The lit, extruded and Braille-rasterized mark adapts the method of the Codex
// welcome blossom (codex-rs/tui/src/empty_state_animation, openai/codex c9b3924a62).
// The palo fierro scene, its creatures, materials and motion are Tesota's own.

export const MARK_MAX_COLUMNS = 60;
export const MARK_MAX_ROWS = 24;
/** Columns to rows of the stage the mark is drawn for; its projection assumes this proportion. */
export const MARK_STAGE_ROWS_PER_60_COLUMNS = 21;

const GRID = 160;
const EXTENT = 1.08;
const STEP = EXTENT * 2 / (GRID - 1);
const TAU = Math.PI * 2;
const DOT_BITS = [1, 8, 2, 16, 4, 32, 64, 128] as const;
const GRAIN_PHASE = 3.9;
/** Virtual-canvas units per unit of the scene, on the 800 by 550 stage, and the scene's height at its center. */
const SCALE = 245;
const CENTER_Y = 0.04;
/** The still camera looks slightly down, so the ground reads as a floor. */
const PITCH = -0.22;
const WIND_CYCLES = 10;
const WIND = 0.045;
/** The ground the roots and the saguaros stand on, and the tumbleweed bounces along. */
const GROUND = 0.8;
const TRUNK_X = -0.06;
/**
 * The tumbleweed's pass, blown along a line behind the trunk from beyond the right edge to beyond the left, in
 * bounces; each moment is a share of the scene.
 */
const TUMBLE_Z = -0.38;
const TUMBLE_RADIUS = 0.2;
const ENTER_X = 2.5;
const LEAVE_X = -2.7;
const BLOWN_IN = 0.06;
const BLOWN_OUT = 0.8;
const HOPS = 3.5;
const HOP = 0.3;
/**
 * When the tumbleweed rolls alone at a few dots tall, it is drawn at this many times the resolution, and a dot shows
 * only where its stems cover at least `COVERAGE` of it, so its tangle stays open instead of filling in.
 */
const SUPERSAMPLE = 3;
const COVERAGE = 0.4;
/** How far out from its center, as a share of its radius, its stems show when it rolls alone. */
const HOLLOW = 0.62;

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

/** What a point is made of, which picks its palette. */
const Stuff = { Foliage: 0, Wood: 1, Saguaro: 2, Distant: 3, Straw: 4 } as const;
type Stuff = typeof Stuff[keyof typeof Stuff];
/** What moves a point: the wind, in the crown, or the tumbleweed's roll and bounce. */
const Group = { Scene: 0, Tumbleweed: 1 } as const;
type Group = typeof Group[keyof typeof Group];

interface Part {
  readonly material: Material;
  readonly stuff: Stuff;
  /** How far the part stands in front of the trunk's plane. */
  readonly offset: number;
  readonly shape: (p: Point) => number;
}

const FORK: Point = [TRUNK_X, 0.22];

/**
 * The palo fierro as the welcome drew it: a low front crown on the left, a wide rear crown on the right and a
 * crown between them, over a short trunk that forks into three limbs, on spread roots. Each crown stands at its
 * own depth, so the camera's sway shows the tree's volume.
 */
const PARTS: readonly Part[] = [
  { material: FOLIAGE, stuff: Stuff.Foliage, offset: -0.2, shape: (p) => lobe(p, [0.34, -0.46], [0.66, 0.34], 11, 0.4) },
  { material: FOLIAGE, stuff: Stuff.Foliage, offset: 0.02, shape: (p) => lobe(p, [-0.02, -0.62], [0.4, 0.27], 9, 1.3) },
  { material: FOLIAGE, stuff: Stuff.Foliage, offset: 0.22, shape: (p) => lobe(p, [-0.52, -0.3], [0.44, 0.27], 10, 2.1) },
  { material: WOOD, stuff: Stuff.Wood, offset: 0, shape: (p) => [
    limb(p, [TRUNK_X, 0.6], FORK, 0.085, 0.065),
    limb(p, FORK, [-0.5, -0.24], 0.06, 0.028),
    limb(p, FORK, [0.0, -0.4], 0.05, 0.028),
    limb(p, FORK, [0.42, -0.26], 0.06, 0.028),
    limb(p, [TRUNK_X, 0.5], [-0.52, 0.76], 0.06, 0.02),
    limb(p, [TRUNK_X, 0.5], [0.4, 0.76], 0.06, 0.02),
    limb(p, [TRUNK_X, 0.56], [-0.1, GROUND], 0.07, 0.03),
  ].reduce((a, b) => smoothMax(a, b, 0.04)) },
];

type Vector = readonly [number, number, number];

/** A small seeded generator, so the tumbleweed's tangle is the same every time. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Surface points, fixed for every frame, each moved by its group before it is drawn. */
interface Samples {
  readonly count: number;
  /**
   * x, y, z, nx, ny, nz, grain, how much the wind moves it, and the sine and cosine of its place in the wind and of
   * four fifths of it, for each point; the wind then costs each frame no trigonometry per point.
   */
  readonly values: Float64Array;
  readonly stuff: Uint8Array;
  readonly group: Uint8Array;
}

const SAMPLE_VALUES = 12;
let samples: Samples | undefined;

function cross(a: Vector, b: Vector): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vector): Vector {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Every point of the scene, with its normal, grain and exposure to the wind. */
function surface(): Samples {
  if (samples !== undefined) return samples;
  const values: number[] = [];
  const stuff: number[] = [];
  const group: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: Stuff, moved: Group,
    wind: number): void => {
    // Each part of the crown sways on its own phase, set by where it stands.
    const phase = x * 2.1 + z * 3.3;
    values.push(x, y, z, nx, ny, nz, Math.sin(x * 23 + y * 19 + GRAIN_PHASE) * 0.01, wind,
      Math.sin(phase), Math.cos(phase), Math.sin(phase * 0.8), Math.cos(phase * 0.8));
    stuff.push(kind);
    group.push(moved);
  };
  // The crown's tips move most in the wind and the trunk's base not at all.
  const exposure = (y: number): number => Math.min(1, Math.max(0, (0.3 - y) / 1.2)) ** 1.6;
  const add = (x: number, y: number, offset: number, z: number, nx: number, ny: number, nz: number,
    kind: Stuff, bumpy: boolean): void => {
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
    push(x, y, z + offset, nx, ny, nz, kind, Group.Scene, exposure(y));
  };
  for (const part of PARTS) {
    const distance = new Float32Array(GRID * GRID);
    for (let row = 0; row < GRID; row++) {
      for (let column = 0; column < GRID; column++) {
        distance[row * GRID + column] = part.shape([column * STEP - EXTENT, row * STEP - EXTENT]);
      }
    }
    const { material, offset, stuff: kind } = part;
    const leaves = kind === Stuff.Foliage;
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
          add(x, y, offset, z, -gx * edge, -gy * edge, nz, kind, leaves);
          add(x, y, offset, -z, -gx * edge, -gy * edge, -nz, kind, leaves);
        }
        if (Math.abs(d) < STEP * 0.8) {
          const side = material.halfDepth - material.bevel;
          const layers = Math.ceil(side * 2 / STEP);
          for (let layer = 0; layer <= layers; layer++) {
            add(x - gx * d, y - gy * d, offset, layers === 0 ? 0 : -side + layer / layers * side * 2,
              -gx, -gy, 0, kind, false);
          }
        }
      }
    }
  }
  // Points on the volumes sit about two to a Braille dot; the distant saguaros, drawn smaller, need fewer.
  const near = STEP * 0.6;
  const far = STEP * 1.15;
  /** An ellipsoid's surface, turned by `tilt` in the x-y plane, with points `spacing` apart. */
  const ellipsoid = (center: Vector, [a, b, c]: Vector, tilt: number, kind: Stuff, moved: Group,
    spacing = near): void => {
    const rings = Math.max(6, Math.ceil(Math.PI * Math.max(a, b, c) / spacing));
    const [st, ct] = [Math.sin(tilt), Math.cos(tilt)];
    for (let ring = 0; ring <= rings; ring++) {
      const polar = ring / rings * Math.PI;
      const around = Math.max(1, Math.ceil(TAU * Math.max(a, b, c) * Math.sin(polar) / spacing));
      for (let step = 0; step < around; step++) {
        const azimuth = step / around * TAU;
        const [x, y, z] = [Math.sin(polar) * Math.cos(azimuth) * a, Math.cos(polar) * b, Math.sin(polar) * Math.sin(azimuth) * c];
        const [nx, ny, nz] = unit([x / (a * a), y / (b * b), z / (c * c)]);
        push(center[0] + x * ct - y * st, center[1] + x * st + y * ct, center[2] + z,
          nx * ct - ny * st, nx * st + ny * ct, nz, kind, moved, 0);
      }
    }
  };
  /** A tube from a to b tapering from ra to rb, ribbed when `ribs` is above 0, closed by a sphere at each end. */
  const tube = (a: Vector, b: Vector, ra: number, rb: number, kind: Stuff, moved: Group, ribs = 0,
    spacing = near): void => {
    const axis: Vector = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    const along = unit(axis);
    const across = unit(cross(along, Math.abs(along[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const third = cross(along, across);
    const steps = Math.max(2, Math.ceil(length / spacing));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const radius = ra + (rb - ra) * t;
      const around = Math.max(6, Math.ceil(TAU * radius / spacing));
      for (let turn = 0; turn < around; turn++) {
        const angle = turn / around * TAU;
        const rib = ribs > 0 ? 1 + 0.14 * Math.cos(angle * ribs) : 1;
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        const normal: Vector = [across[0] * c + third[0] * s, across[1] * c + third[1] * s, across[2] * c + third[2] * s];
        push(a[0] + axis[0] * t + normal[0] * radius * rib, a[1] + axis[1] * t + normal[1] * radius * rib,
          a[2] + axis[2] * t + normal[2] * radius * rib, normal[0], normal[1], normal[2], kind, moved, 0);
      }
    }
    ellipsoid(a, [ra, ra, ra], 0, kind, moved, spacing);
    ellipsoid(b, [rb, rb, rb], 0, kind, moved, spacing);
  };
  /** A saguaro: a ribbed column with arms that reach out, then turn up. */
  const saguaro = (base: Vector, height: number, radius: number, kind: Stuff,
    arms: readonly (readonly [side: number, at: number, reach: number, rise: number])[] = []): void => {
    const spacing = kind === Stuff.Distant ? far : near;
    tube(base, [base[0], base[1] - height, base[2]], radius, radius * 0.9, kind, Group.Scene, 10, spacing);
    for (const [side, at, reach, rise] of arms) {
      const elbow: Vector = [base[0] + side * reach, base[1] - height * at, base[2]];
      tube([base[0], base[1] - height * at, base[2]], elbow, radius * 0.7, radius * 0.7, kind, Group.Scene, 8, spacing);
      tube(elbow, [elbow[0], elbow[1] - rise, elbow[2]], radius * 0.7, radius * 0.65, kind, Group.Scene, 8, spacing);
    }
  };
  // A saguaro seedling in the palo fierro's shade: the nurse tree is what lets it grow.
  saguaro([-0.74, GROUND, 0.12], 0.24, 0.055, Stuff.Saguaro);
  // Grown saguaros further off, one of them behind the tree, so depth reads in what hides what.
  saguaro([1.4, GROUND, -1.3], 0.85, 0.08, Stuff.Distant, [[-1, 0.38, 0.2, 0.3], [1, 0.55, 0.18, 0.22]]);
  saguaro([-1.5, GROUND, -1.8], 0.95, 0.09, Stuff.Distant, [[1, 0.45, 0.22, 0.32]]);
  saguaro([0.5, GROUND, -2.4], 1.05, 0.09, Stuff.Distant, [[-1, 0.42, 0.22, 0.32], [1, 0.52, 0.2, 0.26]]);
  // The tumbleweed, in its own space around its center: a ball of thin, dry, tangled stems.
  const next = random(3371);
  for (let strand = 0; strand < 9; strand++) {
    const axis = unit([next() * 2 - 1, next() * 2 - 1, next() * 2 - 1]);
    const first = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const second = cross(axis, first);
    const radius = TUMBLE_RADIUS * (0.7 + next() * 0.35);
    const start = next() * TAU;
    const sweep = TAU * (0.5 + next() * 0.4);
    const kink = next() * TAU;
    const steps = Math.ceil(sweep * radius / (near * 0.8));
    for (let step = 0; step <= steps; step++) {
      const angle = start + step / steps * sweep;
      const r = radius * (1 + 0.08 * Math.sin(angle * 5 + kink));
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      const point: Vector = [r * (c * first[0] + s * second[0]), r * (c * first[1] + s * second[1]),
        r * (c * first[2] + s * second[2])];
      const [nx, ny, nz] = unit(point);
      push(point[0], point[1], point[2], nx, ny, nz, Stuff.Straw, Group.Tumbleweed, 0);
    }
  }
  samples = { count: stuff.length, values: Float64Array.from(values), stuff: Uint8Array.from(stuff),
    group: Uint8Array.from(group) };
  return samples;
}

export interface MarkPalette {
  readonly key: Rgb;
  readonly shadow: Rgb;
  readonly fill: Rgb;
}

export interface MarkLighting {
  readonly background: Rgb;
  /** One palette for each kind of stuff: foliage, wood, saguaro, plumage and markings. */
  readonly palettes: readonly MarkPalette[];
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
 * one the scene is ink, so shadows deepen toward the foreground and nothing is paler than a material's own color.
 * The seedling is the crown's green, a shade apart; saguaros further off fade toward the background, as distance
 * does in desert air; the tumbleweed is dry straw, from the bark.
 */
export function markLighting(background: Rgb, light: boolean, colors: MarkColors): MarkLighting {
  // A theme's role colors are tuned for text, so the lit side is lifted from them and the shadows fall away from them.
  const material = (color: Rgb): MarkPalette => {
    if (light) return { key: mix(color, background, 0.3), shadow: mix(color, colors.foreground, 0.5), fill: color };
    const key = mix(color, colors.foreground, 0.25);
    return { key, shadow: mix(key, background, 0.65), fill: mix(key, background, 0.35) };
  };
  const ink = light ? colors.foreground : background;
  return {
    background,
    palettes: [
      material(colors.foliage),
      material(colors.wood),
      material(mix(colors.foliage, ink, 0.25)),
      material(mix(mix(colors.foliage, ink, 0.25), background, 0.45)),
      material(light ? colors.wood : mix(colors.wood, colors.foreground, 0.4)),
    ],
    rim: colors.rim,
    highlight: light ? mix(colors.foliage, background, 0.4) : colors.foreground,
  };
}

function shade(light: MarkLighting, palette: MarkPalette, nx: number, ny: number, nz: number, depth: number,
  grain: number): number {
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

export interface MarkCell {
  /** Braille dots, as the offset from U+2800; 0 leaves the cell empty. */
  readonly dots: number;
  /** 0xRRGGBB, the average of the lit dots. */
  readonly rgb: number;
}

/** Where everything stands at one moment of the scene. */
interface Pose {
  /** Whether the tumbleweed is on the stage. */
  readonly visitor: boolean;
  /** The wind's reach and phase. */
  readonly wind: number;
  /** The sine and cosine of the gust's phase, and of four fifths of it. */
  readonly gustSine: number;
  readonly gustCosine: number;
  readonly slowSine: number;
  readonly slowCosine: number;
  /** The tumbleweed's center and the sine and cosine of how far it has rolled. */
  readonly tumble: Vector;
  readonly rollSine: number;
  readonly rollCosine: number;
}

/**
 * The scene at `progress`, from 0 to 1: the crown moves in a wind that rises and falls. With a `visitor`, the same
 * wind blows a tumbleweed through, bouncing and rolling from the right edge to the left behind the trunk. At 0 and
 * at 1 everything rests in the same pose, with the tumbleweed off the stage.
 */
function pose(progress: number, visitor: boolean): Pose {
  const p = Math.min(1, Math.max(0, progress));
  const t = Math.min(1, Math.max(0, (p - BLOWN_IN) / (BLOWN_OUT - BLOWN_IN)));
  const x = ENTER_X + (LEAVE_X - ENTER_X) * t;
  // Each bounce a little lower than the last, as the gust that lifted it passes.
  const lift = HOP * (1 - 0.35 * t) * Math.abs(Math.sin(Math.PI * HOPS * t));
  // Rolling left, its top turns toward where it goes.
  const roll = -(ENTER_X - x) / TUMBLE_RADIUS;
  return {
    visitor: visitor && p > BLOWN_IN && p < BLOWN_OUT,
    wind: WIND * Math.sin(Math.PI * p),
    gustSine: Math.sin(TAU * WIND_CYCLES * p), gustCosine: Math.cos(TAU * WIND_CYCLES * p),
    slowSine: Math.sin(TAU * WIND_CYCLES * p * 0.8), slowCosine: Math.cos(TAU * WIND_CYCLES * p * 0.8),
    tumble: [x, GROUND - TUMBLE_RADIUS - lift, TUMBLE_Z],
    rollSine: Math.sin(roll), rollCosine: Math.cos(roll),
  };
}

/** Moves a point of the given group into the scene at `at`, writing its position and normal into `out`. */
function place(at: Pose, values: Float64Array, k: number, moved: number, out: Float64Array): void {
  let x = values[k]!;
  const y = values[k + 1]!;
  let z = values[k + 2]!;
  const nx = values[k + 3]!;
  const ny = values[k + 4]!;
  const nz = values[k + 5]!;
  if (moved === Group.Scene) {
    const reach = values[k + 7]! * at.wind;
    if (reach !== 0) {
      // As in renderMark's projection, which moves these points itself.
      x += reach * (at.gustSine * values[k + 9]! + at.gustCosine * values[k + 8]!);
      z += reach * 0.6 * (at.slowCosine * values[k + 11]! - at.slowSine * values[k + 10]!);
    }
    out[0] = x; out[1] = y; out[2] = z; out[3] = nx; out[4] = ny; out[5] = nz;
    return;
  }
  const [s, c] = [at.rollSine, at.rollCosine];
  out[0] = at.tumble[0] + x * c - y * s;
  out[1] = at.tumble[1] + x * s + y * c;
  out[2] = at.tumble[2] + z;
  out[3] = nx * c - ny * s;
  out[4] = nx * s + ny * c;
  out[5] = nz;
}

/**
 * One frame of the palo fierro scene at `progress`, from 0 to 1, for a stage of `columns` by `rows` cells, with the
 * tumbleweed blowing through when `visitor` is set. Deterministic for its inputs; the caller owns timing.
 */
export function renderMark(columns: number, rows: number, progress: number, light: MarkLighting,
  visitor = false): MarkCell[] {
  if (columns > MARK_MAX_COLUMNS || rows > MARK_MAX_ROWS) throw new RangeError("the mark's stage is too large");
  const at = pose(progress, visitor);
  const [sx, cx] = [Math.sin(PITCH), Math.cos(PITCH)];
  const dotColumns = columns * 2;
  const dotRows = rows * 4;
  const dotWidth = 800 / dotColumns;
  const dotHeight = 550 / dotRows;
  const dots = dotColumns * dotRows;
  const depthBuffer = new Float32Array(dots).fill(Number.NEGATIVE_INFINITY);
  const winner = new Int32Array(dots);
  const colors = new Uint32Array(dots);
  const { count, values, stuff, group } = surface();
  const placed = new Float64Array(6);

  // Project every point, keeping the nearest at each dot; only the winners are lit afterwards.
  for (let point = 0; point < count; point++) {
    // The still scene is nearly every point; only the tumbleweed's few need the full move.
    const k = point * SAMPLE_VALUES;
    const moved = group[point]!;
    let x: number;
    let y: number;
    let z: number;
    if (moved === Group.Scene) {
      const reach = values[k + 7]! * at.wind;
      x = values[k]! + reach * (at.gustSine * values[k + 9]! + at.gustCosine * values[k + 8]!);
      y = values[k + 1]!;
      z = values[k + 2]! + reach * 0.6 * (at.slowCosine * values[k + 11]! - at.slowSine * values[k + 10]!);
    } else {
      if (!at.visitor) continue;
      place(at, values, k, moved, placed);
      x = placed[0]!;
      y = placed[1]!;
      z = placed[2]!;
    }
    const y2 = y * cx - z * sx;
    const z2 = y * sx + z * cx;
    const perspective = 4.4 / (4.4 - z2);
    const column = Math.floor((400 + x * SCALE * perspective) / dotWidth);
    const row = Math.floor((275 + (y2 - CENTER_Y) * SCALE * perspective) / dotHeight);
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
    place(at, values, k, group[point]!, placed);
    const [y, z, nx, ny, nz] = [placed[1]!, placed[2]!, placed[3]!, placed[4]!, placed[5]!];
    colors[i] = shade(light, light.palettes[stuff[point]!]!, nx, ny * cx - nz * sx, ny * sx + nz * cx,
      y * sx + z * cx, values[k + 6]!);
  }

  return brailleCells(columns, rows, depthBuffer, colors);
}

/** Packs a stage's dots, two by four to a cell, into braille cells colored by the average of their lit dots. */
function brailleCells(columns: number, rows: number, depthBuffer: Float32Array, colors: Uint32Array): MarkCell[] {
  const dotColumns = columns * 2;
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

/**
 * The tumbleweed alone, rolling right to left along a stage of `columns` by `rows` cells as `progress` goes from 0
 * to 1, lit as in the scene, for a working indicator. It fills the stage's height, wraps around the stage's edges,
 * and turns a whole number of times, so the frame at 1 is the frame at 0. It is drawn at `SUPERSAMPLE` times the
 * resolution and a dot shows where its stems cover `COVERAGE` of it, colored by their average. Deterministic for its
 * inputs; the caller owns timing.
 */
export function renderTumbleweed(columns: number, rows: number, progress: number, light: MarkLighting): MarkCell[] {
  const dotColumns = columns * 2;
  const dotRows = rows * 4;
  const fineColumns = dotColumns * SUPERSAMPLE;
  const fineRows = dotRows * SUPERSAMPLE;
  const scale = (fineRows - 1) / (TUMBLE_RADIUS * 2.3);
  const span = fineColumns / scale;
  const p = (progress % 1 + 1) % 1;
  const travel = p * span;
  // Rolling left, its top turns toward where it goes, as in the scene; whole turns keep the loop seamless.
  const roll = -TAU * Math.max(1, Math.round(span / (TAU * TUMBLE_RADIUS))) * p;
  const [s, c] = [Math.sin(roll), Math.cos(roll)];
  const [sx, cx] = [Math.sin(PITCH), Math.cos(PITCH)];
  const fineDepth = new Float32Array(fineColumns * fineRows).fill(Number.NEGATIVE_INFINITY);
  const fineColors = new Uint32Array(fineColumns * fineRows);
  const { count, values, group } = surface();
  for (let point = 0; point < count; point++) {
    if (group[point] !== Group.Tumbleweed) continue;
    const k = point * SAMPLE_VALUES;
    const [x0, y0, z, nx0, ny0, nz] = [values[k]!, values[k + 1]!, values[k + 2]!, values[k + 3]!, values[k + 4]!,
      values[k + 5]!];
    const [x, y] = [x0 * c - y0 * s, x0 * s + y0 * c];
    const [nx, ny] = [nx0 * c - ny0 * s, nx0 * s + ny0 * c];
    const y2 = y * cx - z * sx;
    const z2 = y * sx + z * cx;
    // The stems crossing its middle would fill it in at this size; its outer stems keep it an open ball.
    if (Math.hypot(x, y2) < TUMBLE_RADIUS * HOLLOW) continue;
    const row = Math.floor(fineRows / 2 + y2 * scale);
    if (row < 0 || row >= fineRows) continue;
    // The copies one stage-width to each side carry it across the edges as it wraps.
    for (const shift of [-span, 0, span]) {
      const column = Math.floor((span - travel + x + shift) * scale);
      if (column < 0 || column >= fineColumns) continue;
      const i = row * fineColumns + column;
      if (z2 <= fineDepth[i]!) continue;
      fineDepth[i] = z2;
      fineColors[i] = shade(light, light.palettes[Stuff.Straw]!, nx, ny * cx - nz * sx, ny * sx + nz * cx, z2,
        values[k + 6]!);
    }
  }
  const depthBuffer = new Float32Array(dotColumns * dotRows).fill(Number.NEGATIVE_INFINITY);
  const colors = new Uint32Array(dotColumns * dotRows);
  for (let row = 0; row < dotRows; row++) {
    for (let column = 0; column < dotColumns; column++) {
      let [covered, r, g, b] = [0, 0, 0, 0];
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const i = (row * SUPERSAMPLE + dy) * fineColumns + column * SUPERSAMPLE + dx;
          if (!Number.isFinite(fineDepth[i]!)) continue;
          const rgb = fineColors[i]!;
          r += rgb >> 16 & 255; g += rgb >> 8 & 255; b += rgb & 255;
          covered++;
        }
      }
      if (covered < COVERAGE * SUPERSAMPLE * SUPERSAMPLE) continue;
      const i = row * dotColumns + column;
      depthBuffer[i] = 0;
      colors[i] = Math.round(r / covered) << 16 | Math.round(g / covered) << 8 | Math.round(b / covered);
    }
  }
  return brailleCells(columns, rows, depthBuffer, colors);
}
