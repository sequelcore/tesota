import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { mountWelcomeHeader, WELCOME_FRAME_MS, WELCOME_SCENE_MS, WELCOME_TAGLINE, WelcomeHeader, themeMarkColors,
  type WelcomeHeaderOptions } from "../src/welcome-header.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const braille = /[\u2801-\u28ff]/u;
const themes = new Map<string, Theme>();

beforeAll(async () => {
  // Loaded as the launcher loads Tesota: the package's root passed to Pi as an extension.
  const loader = new DefaultResourceLoader({ cwd: mkdtempSync(join(tmpdir(), "tesota-themes-")),
    agentDir: mkdtempSync(join(tmpdir(), "tesota-agent-")), additionalExtensionPaths: [packageRoot] });
  await loader.reload();
  const { themes: loaded, diagnostics } = loader.getThemes();
  expect(diagnostics).toEqual([]);
  for (const theme of loaded) if (theme.name !== undefined) themes.set(theme.name, theme);
}, 30_000);

function theme(name: string): Theme {
  const found = themes.get(name);
  if (found === undefined) throw new Error(`Pi did not load the theme ${name}`);
  return found;
}

function header(options: Partial<WelcomeHeaderOptions> & { name?: string } = {}) {
  const clock = { now: 0 };
  const timers: (() => void)[] = [];
  let renders = 0;
  const view = new WelcomeHeader("C:\\work\\tesota", theme(options.name ?? "tesota-dark"), {
    requestRender: () => { renders++; }, terminalRows: () => 60, now: () => clock.now,
    setTimer: (callback) => { timers.push(callback); return () => undefined; }, ...options,
  });
  /** Fires the pending frame, as Pi's render loop would, after a frame's time. */
  const tick = (): void => {
    clock.now += WELCOME_FRAME_MS;
    timers.shift()?.();
    view.render(100);
  };
  /** Plays the scene to its end, frame by frame. */
  const rest = (): void => { while (view.moving) tick(); };
  return { view, region: mountWelcomeHeader(view), timers, tick, rest, renders: () => renders };
}

/** A plain left click, in the header's own coordinates, as Pi's fullscreen mode routes it. */
function click(x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 100, height: 30,
    shift: false, alt: false, ctrl: false, clickCount: 1, ...extra };
}

/** The tree's center cell. */
function center(lines: readonly string[]): [number, number] {
  const rows = lines.flatMap((line, index) => braille.test(line) ? [index] : []);
  return [50, rows[Math.floor(rows.length / 2)]!];
}

function stage(lines: readonly string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).filter((line) => braille.test(line)).join("\n");
}

it("ships tesota-dark and tesota-light as Pi themes for their appearances", () => {
  expect(theme("tesota-dark").appearance).toBe("dark");
  expect(theme("tesota-light").appearance).toBe("light");
});

it.each(["tesota-dark", "tesota-light"])("gives %s every color Pi's theme schema requires, and nothing it does not know", (name) => {
  // Pi's command line validates themes strictly, but its loader only does so there; the schema it ships decides.
  const pi = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const schema = JSON.parse(readFileSync(join(pi, "modes", "interactive", "theme", "theme-schema.json"), "utf8")) as
    { properties: Record<string, unknown> & { colors: { required: string[]; properties: Record<string, unknown> } } };
  const json = JSON.parse(readFileSync(join(packageRoot, "themes", `${name}.json`), "utf8")) as
    Record<string, unknown> & { colors: Record<string, unknown> };
  expect(Object.keys(json).filter((key) => !(key in schema.properties))).toEqual([]);
  expect(schema.properties.colors.required.filter((color) => !(color in json.colors))).toEqual([]);
  expect(Object.keys(json.colors).filter((color) => !(color in schema.properties.colors.properties))).toEqual([]);
});

it("draws the tree centered above Tesota's name, folder and purpose", () => {
  const lines = header().view.render(100);
  const plain = lines.map((line) => stripTerminalSequences(line));
  const art = plain.filter((line) => braille.test(line));
  expect(art.length).toBeGreaterThanOrEqual(8);
  const left = Math.min(...art.map((line) => line.search(/\S/u)));
  const right = Math.max(...art.map((line) => line.trimEnd().length));
  expect(Math.abs(left - (100 - right))).toBeLessThanOrEqual(6);
  const name = plain.findIndex((line) => /^\s+Tesota \((v\d|dev)/u.test(line));
  expect(name).toBeGreaterThan(plain.findLastIndex((line) => braille.test(line)));
  expect(plain.slice(name + 1).map((line) => line.trim())).toEqual(["C:\\work\\tesota", WELCOME_TAGLINE]);
});

it("plays the wind once, frame by frame, then rests in its first pose and asks for no more frames", () => {
  const { view, timers, tick, renders } = header();
  const start = stage(view.render(100));
  expect(timers).toHaveLength(1);
  for (let step = 0; step < 40; step++) tick();
  expect(stage(view.render(100))).not.toBe(start);
  while (view.moving) tick();
  expect(renders()).toBeGreaterThanOrEqual(WELCOME_SCENE_MS / WELCOME_FRAME_MS);
  timers.length = 0;
  expect(stage(view.render(100))).toBe(start);
  expect(timers).toEqual([]);
});

it("colors the tree from the active theme's roles, and follows a change of theme", () => {
  expect(themeMarkColors(theme("tesota-dark"))).toMatchObject({ foliage: [0x9a, 0xb0, 0x8f], rim: [0xc6, 0xa8, 0xd2],
    foreground: [0xf2, 0xee, 0xe6] });
  const active = { current: theme("tesota-dark") };
  // Pi hands headers a theme that follows the active one; this stands in for it.
  const following = new Proxy({} as Theme, { get: (_target, key) => {
    const value: unknown = Reflect.get(active.current, key);
    return typeof value === "function" ? value.bind(active.current) : value;
  } });
  const view = new WelcomeHeader("work", following, { requestRender: () => undefined, terminalRows: () => 60,
    setTimer: () => () => undefined });
  const art = (lines: readonly string[]): string => lines.filter((line) => braille.test(line)).join("");
  const dark = art(view.render(100));
  expect(dark).toContain("\x1b[38;2;");
  active.current = theme("tesota-light");
  const light = art(view.render(100));
  expect(stripTerminalSequences(light)).toBe(stripTerminalSequences(dark));
  expect(light).not.toBe(dark);
});

it("keeps the tree to a third of the terminal, drops it where it would not fit, and never draws past the width", () => {
  const third = header({ terminalRows: () => 36 }).view.render(100);
  expect(third.filter((line) => braille.test(line)).length).toBeLessThanOrEqual(12);
  const short = header({ terminalRows: () => 12 }).view.render(100);
  expect(short.some((line) => braille.test(line))).toBe(false);
  expect(short.map((line) => stripTerminalSequences(line)).join("\n")).toContain("Tesota ");
  for (const width of [4, 20, 40, 64, 200]) {
    expect(header().view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
});

it("plays again with the tumbleweed when the resting tree is clicked, and comes back to rest", () => {
  const { view, region, timers, tick, rest } = header();
  const resting = stage(region.render(100));
  rest();
  const [x, y] = center(region.render(100));
  timers.length = 0;
  expect(region.handleMouse(click(x, y))).toEqual({ handled: true, render: true });
  expect(view.moving).toBe(true);
  region.render(100);
  expect(timers).toHaveLength(1);
  // A few seconds in, frame by frame, the tumbleweed is on the stage, where the wind alone would not put it.
  const wind = header();
  wind.view.render(100);
  for (let step = 0; step < 50; step++) { tick(); wind.tick(); }
  expect(stage(region.render(100))).not.toBe(stage(wind.view.render(100)));
  rest();
  timers.length = 0;
  expect(stage(region.render(100))).toBe(resting);
  expect(timers).toEqual([]);
});

it("does nothing new when the tree is clicked while it plays, the opening or a replay", () => {
  const clicked = header();
  const untouched = header();
  for (const scene of [clicked, untouched]) scene.view.render(100);
  const [x, y] = center(clicked.region.render(100));
  for (let step = 0; step < 20; step++) { clicked.tick(); untouched.tick(); }
  expect(clicked.region.handleMouse(click(x, y))).toEqual({ handled: true, render: true });
  for (let step = 0; step < 20; step++) { clicked.tick(); untouched.tick(); }
  expect(stage(clicked.view.render(100))).toBe(stage(untouched.view.render(100)));

  for (const scene of [clicked, untouched]) {
    scene.rest();
    scene.region.handleMouse(click(x, y));
  }
  for (let step = 0; step < 30; step++) { clicked.tick(); untouched.tick(); }
  clicked.region.handleMouse(click(x, y));
  for (let step = 0; step < 30; step++) { clicked.tick(); untouched.tick(); }
  expect(stage(clicked.view.render(100))).toBe(stage(untouched.view.render(100)));
});

it("leaves other gestures, and clicks beside the tree, to their usual owner", () => {
  const { view, region, rest } = header();
  rest();
  const lines = region.render(100);
  const [x, y] = center(lines);
  const text = lines.findIndex((line) => stripTerminalSequences(line).includes("Tesota "));
  for (const event of [click(x, y, { button: "right" }), click(x, y, { ctrl: true }), click(x, y, { type: "press" }),
    click(1, y), click(x, text)]) {
    expect(region.handleMouse(event)).toBeUndefined();
  }
  expect(view.moving).toBe(false);
  const short = header({ terminalRows: () => 12 });
  short.region.render(100);
  expect(short.region.handleMouse(click(50, 0))).toBeUndefined();
});

it("stops asking for frames once disposed", () => {
  const { view, region, timers } = header();
  region.render(100);
  region.dispose();
  timers.length = 0;
  view.render(100);
  expect(view.moving).toBe(false);
  expect(timers).toEqual([]);
});

it("never writes a folder's control characters to the terminal", () => {
  const view = new WelcomeHeader("work\x1b]0;title\x07", theme("tesota-dark"), { requestRender: () => undefined,
    terminalRows: () => 4 });
  const written = view.render(100).join("\n");
  expect(written).not.toContain("\x07");
  expect(written).not.toContain("\x1b]");
  expect(stripTerminalSequences(written)).toContain("work?]0;title?");
});
