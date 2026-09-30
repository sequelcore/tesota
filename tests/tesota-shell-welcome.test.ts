import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";
import { WELCOME_FADED_OPACITY, WELCOME_FRAME_MS, WELCOME_SCENE_MS, WelcomeBanner, welcomeColorMode, type WelcomeBannerOptions }
  from "../src/tesota-shell-welcome.js";
import { MARK_MAX_COLUMNS, markLighting, renderMark } from "../src/welcome-mark.js";
import { themeMarkColors } from "../src/tesota-shell-welcome.js";

const braille = /[\u2801-\u28ff]/u;
const light = markLighting([22, 21, 26], false, themeMarkColors(tesotaShellTheme("tesota-dark")));

function banner(options: Partial<WelcomeBannerOptions> & { clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: 0 };
  const frames: number[] = [];
  const view = new WelcomeBanner("C:\\work\\tesota", tesotaShellTheme("tesota-dark"), {
    viewportHeight: () => 30, colorMode: "truecolor", requestFrame: (delay) => { frames.push(delay); },
    now: () => clock.now, ...options,
  });
  return { view, clock, frames };
}

function stage(lines: readonly string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).filter((line) => braille.test(line)).join("\n");
}

it("plays the scene and rests in the pose it started from", () => {
  const start = renderMark(60, 21, 0, light);
  expect(start.some((cell) => cell.dots !== 0)).toBe(true);
  expect(renderMark(60, 21, 1, light)).toEqual(start);
  for (const moment of [0.25, 0.5, 0.75]) expect(renderMark(60, 21, moment, light)).not.toEqual(start);
  expect(() => renderMark(MARK_MAX_COLUMNS + 1, 21, 0, light)).toThrow(RangeError);
});

it("fills the empty conversation with the tree centered above a centered header", () => {
  const { view } = banner();
  const lines = view.render(100);
  expect(lines).toHaveLength(30);
  const art = lines.map((line) => stripTerminalSequences(line)).filter((line) => braille.test(line));
  expect(art.length).toBeGreaterThanOrEqual(8);
  const left = Math.min(...art.map((line) => line.search(/\S/u)));
  const right = Math.max(...art.map((line) => line.trimEnd().length));
  expect(Math.abs(left - (100 - right))).toBeLessThanOrEqual(6);
  const plain = lines.map((line) => stripTerminalSequences(line));
  const header = plain.findIndex((line) => line.includes("Tesota "));
  expect(header).toBeGreaterThan(plain.findLastIndex((line) => braille.test(line)));
  expect(plain[header]!.search(/\S/u)).toBeGreaterThan(30);
  expect(plain.slice(0, plain.findIndex((line) => line.trim() !== "")).length).toBeGreaterThan(0);
  expect(plain.at(-1)).toBe("");
});

it("plays only while the terminal has focus, and pauses faded without asking for frames", () => {
  let focused = true;
  const { view, clock, frames } = banner({ focused: () => focused });
  // Frame by frame, as the shell draws it; the wind starts calm, so the crown needs a moment to move.
  const play = (count: number): void => {
    for (let step = 0; step < count; step++) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  };
  const first = stage(view.render(100));
  play(40);
  const moving = stage(view.render(100));
  expect(moving).not.toBe(first);
  expect(frames.length).toBeGreaterThan(0);

  focused = false;
  view.render(100);
  clock.now += 1_000;
  for (let step = 0; step < 10; step++) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  const paused = view.render(100);
  expect(stage(paused)).toBe(moving);
  // Faded toward the dark background: no channel of the lit tree stays above the faded share of full white.
  const channels = paused.filter((line) => braille.test(line)).join("").split("\x1b[38;2;").slice(1)
    .flatMap((color) => color.slice(0, color.indexOf("m")).split(";").map(Number));
  expect(channels.length).toBeGreaterThan(0);
  expect(Math.max(...channels)).toBeLessThanOrEqual(26 + (255 - 22) * WELCOME_FADED_OPACITY);
  frames.length = 0;
  view.render(100);
  expect(frames).toEqual([]);

  focused = true;
  view.render(100);
  play(10);
  expect(stage(view.render(100))).not.toBe(moving);
});

it("pauses without color while the operator types, and colors again once the draft is gone", () => {
  let drafting = false;
  const { view, clock } = banner({ drafting: () => drafting });
  const art = (lines: readonly string[]): string => lines.filter((line) => braille.test(line)).join("");
  view.render(100);
  clock.now += WELCOME_FRAME_MS * 6;
  const before = stage(view.render(100));
  drafting = true;
  const typed = view.render(100);
  expect(art(typed)).not.toContain("[38;");
  expect(art(typed)).toContain("[2m");
  for (let step = 0; step < 12; step++) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(stage(view.render(100))).toBe(before);
  drafting = false;
  expect(art(view.render(100))).toContain("[38;2;");
});

it("fades at rest too while the terminal is unfocused, and returns to full strength with focus", () => {
  let focused = true;
  const { view, clock, frames } = banner({ focused: () => focused });
  const brightest = (lines: readonly string[]): number => Math.max(...lines.filter((line) => braille.test(line))
    .join("").split("[38;2;").slice(1).flatMap((color) => color.slice(0, color.indexOf("m")).split(";").map(Number)));
  view.render(100);
  for (let elapsed = 0; elapsed <= WELCOME_SCENE_MS; elapsed += WELCOME_FRAME_MS) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  const rest = brightest(view.render(100));
  focused = false;
  view.render(100);
  for (let step = 0; step < 10; step++) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(brightest(view.render(100))).toBeLessThanOrEqual(26 + (255 - 22) * WELCOME_FADED_OPACITY);
  expect(view.moving).toBe(false);
  frames.length = 0;
  view.render(100);
  expect(frames).toEqual([]);
  focused = true;
  view.render(100);
  for (let step = 0; step < 10; step++) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(brightest(view.render(100))).toBe(rest);
});

it("comes to rest after the scene, at full strength, and then asks for no frames", () => {
  const { view, clock, frames } = banner();
  const start = stage(view.render(100));
  for (let elapsed = 0; elapsed <= WELCOME_SCENE_MS; elapsed += WELCOME_FRAME_MS) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(view.moving).toBe(false);
  frames.length = 0;
  expect(stage(view.render(100))).toBe(start);
  expect(frames).toEqual([]);
});

it("starts settled and still when motion is reduced", () => {
  const { view, frames } = banner({ reducedMotion: true });
  expect(view.moving).toBe(false);
  view.render(100);
  expect(frames).toEqual([]);
});

it("leaves at dismissal, keeping only the header as the conversation's first entry", () => {
  const { view } = banner();
  view.dismiss();
  const raw = view.render(100);
  const lines = raw.map((line) => stripTerminalSequences(line));
  // Indented as entries are; the transcript's own spacing separates it from the next one.
  expect(lines).toEqual([expect.stringMatching(/^ Tesota \((v\d|dev)/u), " C:\\work\\tesota",
    " Every turn is reviewed; reverting never overwrites your edits."]);
  // The name in bold, the version muted as the lines beneath it.
  expect(raw[0]).toContain("\x1b[1mTesota\x1b[22m \x1b[38;2;");
  expect(view.moving).toBe(false);
});

it("drops the tree where it would not fit, and never draws past the width", () => {
  const short = banner({ viewportHeight: () => 9 }).view.render(100);
  expect(short.some((line) => braille.test(line))).toBe(false);
  expect(short.map((line) => stripTerminalSequences(line)).join("\n")).toContain("Tesota ");
  for (const width of [4, 20, 40, 64, 200]) {
    expect(banner().view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
});

it("draws in the terminal's colors for the terminal theme and without color when asked", () => {
  const terminal = new WelcomeBanner("work", tesotaShellTheme("terminal"), { viewportHeight: () => 30, colorMode: "truecolor" });
  const plain = new WelcomeBanner("work", tesotaShellTheme("tesota-dark"), { viewportHeight: () => 30, colorMode: "plain" });
  for (const view of [terminal, plain]) {
    const art = view.render(100).filter((line) => braille.test(line)).join("");
    expect(art).not.toContain("\x1b[38;");
  }
  const ansi = new WelcomeBanner("work", tesotaShellTheme("tesota-light"), { viewportHeight: () => 30, colorMode: "ansi256" });
  expect(ansi.render(100).join("")).toContain("\x1b[38;5;");
  expect(welcomeColorMode({ TERM: "dumb" })).toBe("plain");
  expect(welcomeColorMode({ TERM: "xterm-256color" })).toBe("ansi256");
});

function click(x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 100, height: 30,
    shift: false, alt: false, ctrl: false, clickCount: 1, ...extra };
}

/** The banner's center cell, where the tree stands. */
function center(lines: readonly string[]): [number, number] {
  const rows = lines.flatMap((line, index) => braille.test(line) ? [index] : []);
  return [50, rows[Math.floor(rows.length / 2)]!];
}

it("plays again when the resting scene is clicked, and comes back to rest", () => {
  const { view, clock, frames } = banner();
  const resting = stage(view.render(100));
  for (let elapsed = 0; elapsed <= WELCOME_SCENE_MS; elapsed += WELCOME_FRAME_MS) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(view.moving).toBe(false);
  const [x, y] = center(view.render(100));
  expect(view.handleMouse(click(x, y))).toEqual({ handled: true, render: true });
  expect(view.moving).toBe(true);
  // A few seconds in, frame by frame, the tumbleweed is on the stage.
  for (let step = 0; step < 50; step++) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(stage(view.render(100))).not.toBe(resting);
  frames.length = 0;
  for (let elapsed = 0; elapsed <= WELCOME_SCENE_MS; elapsed += WELCOME_FRAME_MS) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  expect(view.moving).toBe(false);
  expect(stage(view.render(100))).toBe(resting);
});

it("leaves other gestures, and clicks beside the tree, to their usual owner", () => {
  const { view, clock } = banner();
  for (let elapsed = 0; elapsed <= WELCOME_SCENE_MS; elapsed += WELCOME_FRAME_MS) { clock.now += WELCOME_FRAME_MS; view.render(100); }
  const [x, y] = center(view.render(100));
  for (const event of [click(x, y, { button: "right" }), click(x, y, { ctrl: true }), click(x, y, { type: "press" }),
    click(1, y), click(x, 0)]) {
    expect(view.handleMouse(event)).toBeUndefined();
  }
  expect(view.moving).toBe(false);
  const still = banner({ reducedMotion: true }).view;
  expect(still.handleMouse(click(...center(still.render(100))))).toBeUndefined();
  view.dismiss();
  view.render(100);
  expect(view.handleMouse(click(x, y))).toBeUndefined();
});

it("colors the tree from the active theme's roles, and follows a theme changed in place", () => {
  const dark = tesotaShellTheme("tesota-dark");
  expect(themeMarkColors(dark)).toMatchObject({ foliage: [0x9a, 0xb0, 0x8f], rim: [0xc6, 0xa8, 0xd2], foreground: [0xf2, 0xee, 0xe6] });
  expect(themeMarkColors(tesotaShellTheme("terminal"))).toEqual(themeMarkColors(dark));
  const colorsOf = (lines: readonly string[]): string => lines.filter((line) => braille.test(line)).join("");
  const theme = { ...tesotaShellTheme("tesota-dark") };
  const view = new WelcomeBanner("work", theme, { viewportHeight: () => 30, colorMode: "truecolor", reducedMotion: true });
  const before = colorsOf(view.render(100));
  Object.assign(theme, tesotaShellTheme("phosphor"));
  const after = colorsOf(view.render(100));
  expect(stripTerminalSequences(after)).toBe(stripTerminalSequences(before));
  expect(after).not.toBe(before);
});

it("blows the tumbleweed through only when asked, and has it gone again when the scene rests", () => {
  const rest = renderMark(60, 21, 0, light);
  expect(renderMark(60, 21, 0.35, light, true)).not.toEqual(renderMark(60, 21, 0.35, light));
  expect(renderMark(60, 21, 1, light, true)).toEqual(rest);
  expect(renderMark(60, 21, 0.9, light, true)).toEqual(renderMark(60, 21, 0.9, light));
});
