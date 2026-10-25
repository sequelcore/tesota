import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { MARK_GRIDS, markPalette, type Ink, type MarkName, type Rgb } from "../../../src/welcome-mark.js";
import { themeMarkColors } from "../../../src/welcome-header.js";
import { shellTheme } from "../../../src/theme.js";

/** Font-free square pixels, one rectangle per horizontal run of an ink. */
export function markSvg(name: MarkName, colors: Readonly<Record<Exclude<Ink, ".">, Rgb>>): string {
  const grid = MARK_GRIDS[name];
  const shapes: string[] = [];
  for (const [y, row] of grid.entries()) {
    for (let x = 0; x < row.length;) {
      const ink = row[x] as Ink;
      let end = x + 1;
      while (row[end] === ink) end++;
      if (ink !== ".") {
        const fill = "#" + colors[ink].map((n) => n.toString(16).padStart(2, "0")).join("");
        shapes.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill}"/>`);
      }
      x = end;
    }
  }
  return [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid[0].length} ${grid.length}" shape-rendering="crispEdges" role="img" aria-label="Tesota ironwood${name.includes("bloom") ? " in bloom" : ""}">`,
    ...shapes, "</svg>", ""].join("\n");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const colors = markPalette(themeMarkColors(shellTheme("dark", "truecolor")));
  for (const [file, name] of [["tesota-mark", "large"], ["tesota-mark-bloom", "large-bloom"], ["tesota-favicon", "favicon"]] as const) {
    writeFileSync(new URL(`../../../docs/assets/${file}.svg`, import.meta.url), markSvg(name, colors));
  }
}
