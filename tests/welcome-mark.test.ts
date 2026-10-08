import { expect, it } from "vitest";
import { MARK_MAX_COLUMNS, type MarkColors, markLighting, renderMark } from "../src/welcome-mark.js";

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
