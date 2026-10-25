import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MARK_GRIDS, markPixels, renderMark, type MarkName } from "../src/welcome-mark.js";

// Independent approved oracle, copied verbatim from the owner's final file.
const fixture = readFileSync(new URL("./fixtures/tesota-mark-final.txt", import.meta.url), "utf8");
const grids = [...fixture.matchAll(/^# (small|small-bloom|favicon|large|large-bloom)\r?\n([.gGptsk\r\n]+)/gmu)]
  .map((match) => [match[1] as MarkName, match[2]!.trim().split(/\r?\n/u)] as const);

it.each(grids)("renders every pixel of %s in half blocks, padding ragged rows", (name, raw) => {
  const width = Math.max(...raw.map((row) => row.length));
  const expected = raw.map((row) => row.padEnd(width, "."));
  expect(MARK_GRIDS[name]).toEqual(expected);
  const cells = renderMark(name);
  const actual: string[] = [];
  for (const row of cells) {
    actual.push(row.map((cell) => cell.top).join(""), row.map((cell) => cell.bottom).join(""));
    for (const cell of row) expect(cell.glyph).toBe(cell.top === "." ? cell.bottom === "." ? " " : "▄"
      : cell.bottom === "." ? "▀" : cell.top === cell.bottom ? "█" : "▀");
  }
  expect(actual.slice(0, expected.length)).toEqual(expected);
  if (expected.length % 2) expect(actual.at(-1)).toBe(".".repeat(width));
});

it("keeps the silhouette, including protruding blossoms, without color", () => {
  const silhouette = (name: MarkName) => renderMark(name, 0, false, false).map((row) => row.map((cell) => cell.glyph).join(""));
  expect(silhouette("small")).toEqual(["  ▄▄███▄▄████▄▄▄▄  ", "▄█████████████████▀", " ▀▀▀███▀▀▀▀▀▀▀     ", "    ▄█▄            "]);
  expect(silhouette("small-bloom")).not.toEqual(silhouette("small"));
  for (const name of Object.keys(MARK_GRIDS) as MarkName[]) {
    const pixels = markPixels(name);
    const cells = renderMark(name, 0, false, false);
    for (const [y, row] of cells.entries()) for (const [x, cell] of row.entries()) {
      expect(cell.glyph).toBe(pixels[y * 2]?.[x] !== "." ? pixels[y * 2 + 1]?.[x] !== undefined && pixels[y * 2 + 1]?.[x] !== "." ? "█" : "▀"
        : pixels[y * 2 + 1]?.[x] !== undefined && pixels[y * 2 + 1]?.[x] !== "." ? "▄" : " ");
    }
  }
});

it.each(["small", "small-bloom", "large", "large-bloom"] as const)("rustles %s twice, drops one leaf only on click, and restores every pixel", (name) => {
  const start = markPixels(name);
  expect(markPixels(name, 1, true)).toEqual(start);
  expect(markPixels(name, 0, true)).toEqual(start);
  for (const progress of [0.15, 0.35, 0.55, 0.75]) expect(markPixels(name, progress)).not.toEqual(start);
  expect(markPixels(name, 0.5, true)).not.toEqual(markPixels(name, 0.5, false));
  for (const [y, row] of start.entries()) for (const [x, ink] of [...row].entries()) {
    if (ink === "t" || ink === "s" || ink === "k") expect(markPixels(name, 0.5)[y]?.[x]).toBe(ink);
  }
});
