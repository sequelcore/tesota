import { expect, it } from "vitest";
import { WelcomeHeader } from "../src/welcome-header.js";
import { MARK_GRIDS } from "../src/welcome-mark.js";
import { shellTheme } from "../src/theme.js";

it("blends every foreground and background pixel ink to exactly 30% throughout the gesture", () => {
  const inks: Readonly<Record<string, readonly number[]>> = {
    g: [154, 176, 143], G: [116, 132, 107], t: [199, 181, 138], s: [162, 178, 150], k: [185, 183, 170],
  };
  let now = 0;
  const view = new WelcomeHeader("shop", shellTheme("dark", "truecolor"), { terminalRows: () => 60, stageShare: 0.5,
    now: () => now, requestRender: () => undefined, setTimer: () => () => undefined });
  // Independent role RGB oracle, read from the shipped theme; every filled half-block cell emits its fg,
  // and two different inks in a cell also emit the lower pixel's bg.
  const expected: number[][] = [];
  for (let y = 0; y < 17; y += 2) for (let x = 0; x < 49; x++) {
    const top = MARK_GRIDS.large[y]?.[x] ?? ".";
    const bottom = MARK_GRIDS.large[y + 1]?.[x] ?? ".";
    const fg = top === "." ? bottom : top;
    if (fg === ".") continue;
    expected.push([38, ...inks[fg]!.map((n) => Math.round(32 + (n - 32) * 0.30))]);
    if (top !== "." && bottom !== "." && top !== bottom) {
      expected.push([48, ...inks[bottom]!.map((n) => Math.round(32 + (n - 32) * 0.30))]);
    }
  }
  // eslint-disable-next-line no-control-regex -- inspect both terminal pixel colors
  const colors = (text: string) => [...text.matchAll(/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/gu)].map((match) => match.slice(1).map(Number));
  const start = view.renderStage(100).join("\n");
  expect(colors(start)).toEqual(expected);
  now = 800; expect(view.renderStage(100).join("\n")).toBe(start);
  view.click({ type: "click", button: "left", x: 50, y: 15, shift: false, alt: false, ctrl: false } as never);
  view.renderStage(100); now += 400;
  const animated = colors(view.renderStage(100).join("\n"));
  const allowed = new Set(expected.map((color) => color.slice(1).join(",")));
  expect(animated.length).toBeGreaterThan(0);
  for (const color of animated) expect(allowed.has(color.slice(1).join(","))).toBe(true);
  now += 400; expect(view.renderStage(100).join("\n")).toBe(start);
});
