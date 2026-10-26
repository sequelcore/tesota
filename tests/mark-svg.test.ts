import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { markSvg } from "../packages/core/scripts/mark-svg.js";
import { MARK_GRIDS, markPalette, type MarkName } from "../src/welcome-mark.js";
import { themeMarkColors } from "../src/welcome-header.js";
import { shellTheme } from "../src/theme.js";

it.each(["small", "small-bloom", "favicon", "large", "large-bloom"] as const)("generates valid font-free %s SVG with exact square pixels", (name: MarkName) => {
  const colors = markPalette(themeMarkColors(shellTheme("dark", "truecolor")));
  const source = markSvg(name, colors);
  const document = new JSDOM(source, { contentType: "image/svg+xml" }).window.document;
  expect(document.documentElement.localName).toBe("svg");
  expect(document.querySelectorAll("text, style, image, path")).toHaveLength(0);
  const grid = MARK_GRIDS[name];
  expect(document.documentElement.getAttribute("viewBox")).toBe(`0 0 ${grid[0].length} ${grid.length}`);
  const pixels = grid.map((row) => Array<string>(row.length).fill("."));
  const hex = (rgb: readonly number[]) => "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("");
  for (const rect of document.querySelectorAll("rect")) {
    const [x, y, width, height] = ["x", "y", "width", "height"].map((attr) => Number(rect.getAttribute(attr)));
    expect(height).toBe(1);
    const ink = Object.entries(colors).find(([, rgb]) => hex(rgb) === rect.getAttribute("fill"))?.[0];
    expect(ink).toBeDefined();
    for (let column = x!; column < x! + width!; column++) {
      expect(pixels[y!]?.[column]).toBe(".");
      pixels[y!]![column] = ink!;
    }
  }
  expect(pixels.map((row) => row.join(""))).toEqual(grid);
});

it.each([["tesota-mark", "large"], ["tesota-mark-bloom", "large-bloom"], ["tesota-favicon", "favicon"]] as const)(
  "keeps the published %s asset generated from its grid", (file, name) => {
    const colors = markPalette(themeMarkColors(shellTheme("dark", "truecolor")));
    expect(readFileSync(new URL(`../docs/assets/${file}.svg`, import.meta.url), "utf8")).toBe(markSvg(name, colors));
  });
