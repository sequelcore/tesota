import { expect, it } from "vitest";
import { MARK_MAX_COLUMNS, type MarkColors, markLighting, renderMark, renderTumbleweed } from "../src/welcome-mark.js";

/** The tesota-dark theme's colors for the mark, from its success, warning, muted, accent and foreground roles. */
const dark: MarkColors = { foliage: [154, 176, 143], wood: [199, 181, 138], rim: [198, 168, 210], foreground: [242, 238, 230] };
const light = markLighting([22, 21, 26], false, dark);

it("plays the scene and rests in the pose it started from", () => {
  const start = renderMark(60, 21, 0, light);
  expect(start.some((cell) => cell.dots !== 0)).toBe(true);
  expect(renderMark(60, 21, 1, light)).toEqual(start);
  for (const moment of [0.25, 0.5, 0.75]) expect(renderMark(60, 21, moment, light)).not.toEqual(start);
  expect(() => renderMark(MARK_MAX_COLUMNS + 1, 21, 0, light)).toThrow(RangeError);
});

it("blows the tumbleweed through only when asked, and has it gone again when the scene rests", () => {
  const rest = renderMark(60, 21, 0, light);
  expect(renderMark(60, 21, 0.35, light, true)).not.toEqual(renderMark(60, 21, 0.35, light));
  expect(renderMark(60, 21, 1, light, true)).toEqual(rest);
  expect(renderMark(60, 21, 0.9, light, true)).toEqual(renderMark(60, 21, 0.9, light));
});

it("rolls the tumbleweed alone across a one-row stage and loops back to its first frame", () => {
  const first = renderTumbleweed(4, 1, 0, light);
  expect(first).toHaveLength(4);
  expect(renderTumbleweed(4, 1, 1, light)).toEqual(first);
  expect(renderTumbleweed(4, 1, 0.3, light)).toEqual(renderTumbleweed(4, 1, 0.3, light));
  const frames = Array.from({ length: 20 }, (_, frame) => renderTumbleweed(4, 1, frame / 20, light));
  expect(new Set(frames.map((cells) => JSON.stringify(cells))).size).toBe(20);
  // It travels: where its dots are moves from cell to cell over the pass.
  const heaviest = frames.map((cells) => cells.reduce((best, cell, index) =>
    dotCount(cell.dots) > dotCount(cells[best]!.dots) ? index : best, 0));
  expect(new Set(heaviest).size).toBeGreaterThan(2);
});

it("keeps the rolling tumbleweed an open tangle rather than a solid block", () => {
  for (let frame = 0; frame < 20; frame++) {
    const lit = renderTumbleweed(4, 1, frame / 20, light).reduce((sum, cell) => sum + dotCount(cell.dots), 0);
    expect(lit).toBeGreaterThan(0);
    // The ball spans about two of the four cells; filled solid it would light 16 dots.
    expect(lit).toBeLessThan(13);
  }
});

function dotCount(dots: number): number {
  let count = 0;
  for (let bits = dots; bits !== 0; bits &= bits - 1) count++;
  return count;
}
