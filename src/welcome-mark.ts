/** Owner-approved pixel grids (2026-10-25); ragged source rows padded with empty pixels. */
export const MARK_GRIDS = {
  "small": [
    "....ggg..gggg......",
    "..ggggggggggggggg..",
    ".gggggggggggggggggg",
    "gggggggggggggggggg.",
    ".ggGGGGGGGGGGG.....",
    "....GtG............",
    ".....t.............",
    "....ttt............"
  ],
  "small-bloom": [
    "....ggg..gggg..p...",
    "..ggggggggggggggg.p",
    ".gggggggggggggggggg",
    "gggggggggggggggggg.",
    ".ggGGGGGGGGGGG.....",
    "....GtG............",
    ".....t.............",
    "....ttt............"
  ],
  "favicon": [
    "................",
    "................",
    ".....ggg..ggg...",
    "...gggggggggggg.",
    "..gggggggggggggg",
    ".gggggggggggggg.",
    ".ggGGGGGGGGgg...",
    "....GtG.........",
    ".....t..........",
    ".....t..........",
    "....ttt.........",
    "................",
    "................",
    "................",
    "................",
    "................"
  ],
  "large": [
    "...............gggggg....ggggggg.................",
    "..........gggggggggggggggggggggggggg.............",
    ".......gggggggggggggggggggggggggggggggggg........",
    ".....ggggggggggggggggggggggggggggggggggggggg.....",
    "...ggggggggggggggggggggggggggggggggggggggggggg...",
    "..gggggggggGGGGGgggggggggggggggggGGGGGgggggggggg.",
    ".gggggggGGGGGGGGGGGgggggggggggGGGGGGGGGGGGgggggg.",
    ".ggggGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGgg..",
    "...gGGGGG..GGGGGtGGGGtGGGGG.......GGGGGGGGgg.....",
    "..........tt...t.t...t...............GG..........",
    "...........tt..t..t.t............................",
    "............tt.t..tt.............s...............",
    ".............tttt.tt............sss..............",
    "..............tttttt............sss..............",
    "..............tttttt............sss..............",
    ".............tttttttt...........sss..............",
    "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
  ],
  "large-bloom": [
    "...............gggggg...pggggggg...p.............",
    "..........gggggggggggggggggggggggggg..p..........",
    ".......gggggggggggggggggggggggggggggggggg........",
    ".....gggggggggggggggggggggggggggggggggggggggp....",
    "...ggggggggggggggggggggggggggggggggggggggggggg...",
    "..gggggggggGGGGGgggggggggggggggggGGGGGgggggggggg.",
    ".gggggggGGGGGGGGGGGgggggggggggGGGGGGGGGGGGgggggg.",
    ".ggggGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGgg..",
    "...gGGGGG..GGGGGtGGGGtGGGGG.......GGGGGGGGgg.....",
    "..........tt...t.t...t...............GG..........",
    "...........tt..t..t.t............................",
    "............tt.t..tt.............s...............",
    ".............tttt.tt............sss..............",
    "..............tttttt............sss..............",
    "..............tttttt............sss..............",
    ".............tttttttt...........sss..............",
    "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
  ]
} as const;
export type MarkName = keyof typeof MARK_GRIDS;
export type Ink = "." | "g" | "G" | "p" | "t" | "s" | "k";
export type Rgb = readonly [number, number, number];
export interface MarkColors {
  readonly foliage: Rgb;
  readonly wood: Rgb;
  readonly rim: Rgb;
  readonly foreground: Rgb;
  readonly muted: Rgb;
}

/** One short gesture; only crown pixels move. Timing belongs to the header. */
export function markPixels(name: MarkName, progress = 0, leaf = false): readonly string[] {
  const grid = MARK_GRIDS[name];
  if (progress < 1 / 16 || progress >= 1) return grid;
  const shift = Math.floor(progress * 6) % 2 === 0 ? -1 : 1;
  const width = grid[0].length;
  // The terminal viewport clips an overhang at its edge; trunks and ground never move.
  const out = grid.map((row) => [...row].map((ink) => "gGp".includes(ink) ? "." : ink));
  for (const [y, row] of grid.entries()) for (const [x, ink] of [...row].entries()) {
    if (!"gGp".includes(ink)) continue;
    const at = x + shift;
    if (at >= 0 && at < width && out[y]?.[at] === ".") out[y]![at] = ink;
  }
  if (leaf) {
    const small = name.startsWith("small");
    const x = small ? 15 : 36;
    const y = Math.min(grid.length - 2, (small ? 3 : 7) + Math.floor(progress * (small ? 4 : 8)));
    if (out[y]?.[x] === ".") out[y]![x] = "g";
  }
  return out.map((row) => row.join(""));
}

export interface MarkCell {
  readonly top: Ink;
  readonly bottom: Ink;
  readonly glyph: " " | "▀" | "▄" | "█";
}

/** Two pixel rows per terminal row. Different inks use foreground plus background. */
export function renderMark(name: MarkName, progress = 0, leaf = false, colored = true): MarkCell[][] {
  const grid = markPixels(name, progress, leaf);
  const width = grid[0]!.length;
  const rows: MarkCell[][] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const cells: MarkCell[] = [];
    for (let x = 0; x < width; x++) {
      const top = (grid[y]?.[x] ?? ".") as Ink;
      const bottom = (grid[y + 1]?.[x] ?? ".") as Ink;
      cells.push({ top, bottom, glyph: top === "." ? bottom === "." ? " " : "▄"
        : bottom === "." ? "▀" : !colored || top === bottom ? "█" : "▀" });
    }
    rows.push(cells);
  }
  return rows;
}

export function mixMark(from: Rgb, to: Rgb, share: number): Rgb {
  return [Math.round(from[0] + (to[0] - from[0]) * share), Math.round(from[1] + (to[1] - from[1]) * share),
    Math.round(from[2] + (to[2] - from[2]) * share)];
}

/** Flat role inks, with a darker success step for the shade. */
export function markPalette(colors: MarkColors): Readonly<Record<Exclude<Ink, ".">, Rgb>> {
  return { g: colors.foliage, G: mixMark(colors.foliage, [0, 0, 0], 0.25), p: colors.rim,
    t: colors.wood, s: mixMark(colors.foliage, colors.muted, 0.25), k: colors.muted };
}
