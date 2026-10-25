import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences, type TerminalColorMode, type TerminalColors, type TerminalColorScheme, type TuiMouseEvent,
  visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import type { Theme } from "../src/contract.js";
import { shellTheme } from "../src/theme.js";
import { mountWelcomeHeader, WELCOME_FRAME_MS, WELCOME_SCENE_MS, WELCOME_TAGLINE,
  WelcomeHeader, themeMarkColors, type WelcomeHeaderOptions } from "../src/welcome-header.js";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const braille = /[▀▄█]/u;

function theme(name: string, mode: TerminalColorMode = "truecolor"): Theme {
  return shellTheme(name === "tesota-light" ? "light" : "dark", mode);
}

function header(options: Partial<WelcomeHeaderOptions> & { name?: string } = {}) {
  const clock = { now: 0 };
  const timers: (() => void)[] = [];
  let renders = 0;
  const view = new WelcomeHeader("C:\\work\\tesota", theme(options.name ?? "tesota-dark"), {
    requestRender: () => { renders++; }, terminalRows: () => 60, stageShare: 1 / 3, now: () => clock.now,
    setTimer: (callback) => { timers.push(callback); return () => undefined; }, ...options,
  });
  /** Fires the pending frame, as Pi's render loop would, after a frame's time. */
  const tick = (): void => {
    clock.now += WELCOME_FRAME_MS;
    timers.shift()?.();
    view.renderStage(100);
  };
  /** Plays the scene to its end, frame by frame. */
  const rest = (): void => { while (view.moving) tick(); };
  const terminal = fakeTerminal(() => { renders++; });
  return { view, region: mountWelcomeHeader(view, terminal), terminal, timers, tick, rest, renders: () => renders };
}

/** A terminal that answers Pi's color queries when the test says so, on time or late, and turns light or dark. */
function fakeTerminal(requestRender: () => void) {
  const queries: { readonly answer: (colors: TerminalColors) => void; readonly late: (colors: TerminalColors) => void }[] =
    [];
  const schemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
  return {
    queries, schemeListeners, requestRender,
    queryTerminalColors: ({ onLateReply }: { timeoutMs: number; onLateReply?: (colors: TerminalColors) => void }) =>
      new Promise<TerminalColors>((answer) => { queries.push({ answer, late: (colors) => onLateReply?.(colors) }); }),
    onTerminalColorSchemeChange: (listener: (scheme: TerminalColorScheme) => void) => {
      schemeListeners.add(listener);
      return () => { schemeListeners.delete(listener); };
    },
  };
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

/** The themes Tesota ships: one for a dark terminal and one for a light one. */
const shipped = { "tesota-dark": "dark", "tesota-light": "light" } as const;

it("ships a theme for each appearance, and only those", () => {
  expect(readdirSync(join(packageRoot, "themes")).toSorted()).toEqual(Object.keys(shipped).map((name) => `${name}.json`)
    .toSorted());
  for (const [name, appearance] of Object.entries(shipped)) expect(theme(name).appearance).toBe(appearance);
});

it("gives both themes the same tokens, each a color the terminal can show", () => {
  const tokens = (name: string): string[] => Object.keys((JSON.parse(readFileSync(join(packageRoot, "themes", `${name}.json`), "utf8")) as
    { colors: Record<string, unknown> }).colors).toSorted();
  expect(tokens("tesota-light")).toEqual(tokens("tesota-dark"));
  for (const name of Object.keys(shipped)) expect(Object.keys(theme(name).colors).toSorted()).toEqual(tokens(name));
});

it("shows a folder under the home folder from ~, as the footer does", () => {
  const view = new WelcomeHeader(join(homedir(), "work", "shop"), theme("tesota-dark"), { requestRender: () => undefined,
    terminalRows: () => 60, stageShare: 1 / 3, now: () => 0, setTimer: () => () => undefined });
  const written = view.render(100).map((line) => stripTerminalSequences(line)).join("\n");
  expect(written).toContain(join("~", "work", "shop"));
  expect(written).not.toContain(homedir());
});

it("keeps the header at four rows, with the 19-column mark beside the three text rows", () => {
  const { view } = header();
  const plain = view.render(100).map(stripTerminalSequences);
  expect(plain).toHaveLength(4);
  expect(plain[0]!.slice(21)).toMatch(/^Tesota (v\d|dev)/u);
  expect(plain.slice(1, 3).map((row) => row.slice(21))).toEqual(["C:\\work\\tesota", WELCOME_TAGLINE]);
  expect(plain[3]!.slice(21).trim()).toBe("");
  const art = view.renderStage(100).map(stripTerminalSequences).filter((line) => braille.test(line));
  expect(art).toHaveLength(9);
  expect(art.at(-1)).toBe(" ".repeat(25) + "▀".repeat(49));
});

it("keeps the folder's last segment when the model and folder share a narrow row", () => {
  const { view } = header({ model: () => "a-long-model-name" });
  const row = stripTerminalSequences(view.render(61)[1]!.slice(0)).slice(21);
  expect(row).toBe("a-long-model-name · C:\\work\\tesota");
  const narrow = stripTerminalSequences(view.render(49)[1]!.slice(0)).slice(21);
  expect(narrow).toBe("a-long-model-name · …\\tesota");
});

it("rustles once in under a second, then returns exactly to static and schedules nothing", () => {
  const { view, timers, tick, renders } = header();
  const start = view.renderStage(100);
  expect(WELCOME_SCENE_MS).toBeLessThan(1000);
  expect(timers).toHaveLength(1);
  tick(); tick(); tick();
  expect(view.renderStage(100)).not.toEqual(start);
  while (view.moving) tick();
  expect(renders()).toBe(WELCOME_SCENE_MS / WELCOME_FRAME_MS);
  timers.length = 0;
  expect(view.renderStage(100)).toEqual(start);
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
    stageShare: 1 / 3, setTimer: () => () => undefined });
  const art = (lines: readonly string[]): string => lines.filter((line) => braille.test(line)).join("");
  const dark = art(view.renderStage(100));
  expect(dark).toContain("\x1b[38;2;");
  active.current = theme("tesota-light");
  const light = art(view.renderStage(100));
  expect(stripTerminalSequences(light)).toBe(stripTerminalSequences(dark));
  expect(light).not.toBe(dark);
});

it("draws the tree in 256 colors where the theme's terminal has no truecolor", () => {
  const art = (mode: TerminalColorMode): string => new WelcomeHeader("work", theme("tesota-dark", mode),
    { requestRender: () => undefined, terminalRows: () => 60, stageShare: 1 / 3, setTimer: () => () => undefined })
    .renderStage(100).filter((line) => braille.test(line)).join("");
  const indexed = art("256color");
  expect(indexed).toContain("\x1b[38;5;");
  expect(indexed).not.toContain("\x1b[38;2;");
  expect(stripTerminalSequences(indexed)).toBe(stripTerminalSequences(art("truecolor")));
});

it("sets Tesota's name in bold above the muted version, whatever color support the terminal reports", () => {
  const title = header().view.render(100).find((line) => stripTerminalSequences(line).includes("Tesota "))!;
  expect(title).toContain("\x1b[1mTesota\x1b[22m ");
});

it("centers a fixed 49-column, nine-row splash, omits it if it cannot fit, and never overflows", () => {
  for (const width of [60, 100, 200]) {
    const art = header().view.renderStage(width).map(stripTerminalSequences);
    const ground = art.find((row) => row.includes("▀".repeat(49)))!;
    expect(ground).toBe(" ".repeat(Math.floor((width - 49) / 2)) + "▀".repeat(49));
    expect(art.filter((line) => braille.test(line))).toHaveLength(9);
  }
  for (const width of [4, 20, 40, 64, 200]) {
    expect(header().view.renderStage(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(header().view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  expect(header({ terminalRows: () => 12 }).view.renderStage(100)).toEqual([]);
  expect(header().view.renderStage(48)).toEqual([]);
});

it("restarts on every splash click, adds a falling leaf, and restores the exact static frame", () => {
  const { view, region, timers, tick, rest } = header();
  const resting = view.renderStage(100);
  rest();
  const [x, y] = center(region.emptyState.render(100));
  expect(region.emptyState.handleMouse(click(x, y))).toEqual({ handled: true, render: true });
  expect(view.moving).toBe(true);
  view.renderStage(100);
  const opening = header(); opening.view.renderStage(100);
  for (let step = 0; step < 8; step++) { tick(); opening.tick(); }
  expect(stage(view.renderStage(100))).not.toBe(stage(opening.view.renderStage(100)));
  rest(); timers.length = 0;
  expect(view.renderStage(100)).toEqual(resting);
  expect(timers).toEqual([]);
});

it("restarts even mid-gesture and rustles on each header mark click, not on its text", () => {
  const { view, tick, rest } = header();
  view.render(100); view.renderStage(100);
  for (let step = 0; step < 8; step++) tick();
  expect(view.clickHeader(click(5, 1))).toEqual({ handled: true, render: true });
  for (let step = 0; step < 8; step++) tick();
  expect(view.moving).toBe(true);
  view.clickHeader(click(5, 1));
  rest();
  expect(view.clickHeader(click(22, 1))).toBeUndefined();
  expect(view.clickHeader(click(5, 1))).toEqual({ handled: true, render: true });
  expect(view.moving).toBe(true);
});

it("leaves other gestures, and clicks beside the tree, to their usual owner", () => {
  const { view, region, rest } = header();
  rest();
  const lines = region.emptyState.render(100);
  const [x, y] = center(lines);
  const text = lines.length;
  // A plain left press claims routing only; it never starts motion.
  expect(region.emptyState.handleMouse(click(x, y, { type: "press" }))).toEqual({ handled: true });
  expect(view.moving).toBe(false);
  region.render(100);
  expect(region.handleMouse?.(click(5, 1, { type: "press" }))).toEqual({ handled: true });
  expect(view.moving).toBe(false);
  for (const event of [click(x, y, { button: "right" }), click(x, y, { ctrl: true }),
    click(x, y, { type: "press", shift: true }), click(x, y, { type: "press", alt: true }),
    click(x, y, { type: "press", ctrl: true }), click(x, y, { type: "press", button: "right" }),
    click(1, y, { type: "press" }), click(1, y), click(x, text)]) {
    expect(region.emptyState.handleMouse(event)).toBeUndefined();
  }
  expect(view.moving).toBe(false);
  const short = header({ terminalRows: () => 12 });
  short.region.emptyState.render(100);
  expect(short.region.emptyState.handleMouse(click(50, 0))).toBeUndefined();
});

it("stops asking for frames once disposed", () => {
  const { view, region, timers } = header();
  region.emptyState.render(100);
  region.dispose();
  timers.length = 0;
  view.renderStage(100);
  expect(view.moving).toBe(false);
  expect(timers).toEqual([]);
});

it("lights the tree against the background the terminal reports, on time, late, or after it turns light or dark", async () => {
  const art = (lines: readonly string[]): string => lines.filter((line) => braille.test(line)).join("");
  const { view, terminal, renders } = header();
  expect(terminal.queries).toHaveLength(1);
  const fallback = art(view.renderStage(100));
  // No reported background keeps the palette's own canvas.
  terminal.queries[0]!.answer({});
  await Promise.resolve();
  expect(art(view.renderStage(100))).toBe(fallback);
  // A late reply, as over a slow link, still applies.
  const before = renders();
  terminal.queries[0]!.late({ background: { r: 12, g: 12, b: 12 } });
  expect(renders()).toBe(before + 1);
  const campbell = art(view.renderStage(100));
  expect(stripTerminalSequences(campbell)).toBe(stripTerminalSequences(fallback));
  expect(campbell).not.toBe(fallback);
  // The terminal turning light asks again, and its new background is used.
  for (const listener of terminal.schemeListeners) listener("light");
  expect(terminal.queries).toHaveLength(2);
  terminal.queries[1]!.answer({ background: { r: 32, g: 32, b: 32 } });
  await Promise.resolve();
  expect(art(view.renderStage(100))).toBe(fallback);
});

it("stops listening to the terminal once disposed", async () => {
  const { view, region, terminal } = header();
  const fallback = view.renderStage(100).join("\n");
  region.dispose();
  expect(terminal.schemeListeners.size).toBe(0);
  terminal.queries[0]!.answer({ background: { r: 12, g: 12, b: 12 } });
  await Promise.resolve();
  expect(view.renderStage(100).join("\n")).toBe(fallback);
});

it("never writes a folder's control characters to the terminal", () => {
  const view = new WelcomeHeader("work\x1b]0;title\x07", theme("tesota-dark"), { requestRender: () => undefined,
    terminalRows: () => 4, stageShare: 1 / 3 });
  const written = view.render(100).join("\n");
  expect(written).not.toContain("\x07");
  expect(written).not.toContain("\x1b]");
  expect(stripTerminalSequences(written)).toContain("work?]0;title?");
});

it.each([["Tesota Dark", "tesota-dark"], ["Tesota Light", "tesota-light"]])(
  "draws the %s terminal scheme in the same colors for every terminal, on its theme's canvas", (scheme, name) => {
    const schemes = join(packageRoot, "terminal-schemes");
    const windows = (JSON.parse(readFileSync(join(schemes, "windows-terminal", "tesota.json"), "utf8")) as
      { schemes: Record<string, string>[] }).schemes.find((entry) => entry["name"] === scheme)!;
    const colors = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white"];
    const sixteen = [...colors.map((color) => windows[color]), ...colors.map((color) =>
      windows[`bright${color[0]!.toUpperCase()}${color.slice(1)}`])];
    const ghostty = readFileSync(join(schemes, "ghostty", scheme), "utf8");
    expect(sixteen.map((_, index) => ghostty.match(new RegExp(`^palette = ${index}=(#[0-9a-f]{6})$`, "mu"))?.[1]))
      .toEqual(sixteen);
    const wezterm = readFileSync(join(schemes, "wezterm", `${scheme}.toml`), "utf8");
    const list = (key: string): string[] =>
      JSON.parse(wezterm.match(new RegExp(String.raw`^${key} = (\[.*\])$`, "mu"))![1]!) as string[];
    expect([...list("ansi"), ...list("brights")]).toEqual(sixteen);
    const theme = JSON.parse(readFileSync(join(packageRoot, "themes", `${name}.json`), "utf8")) as
      { vars: Record<string, string> };
    for (const [key, value] of [["background", theme.vars["canvas"]], ["foreground", theme.vars["text"]]] as const) {
      expect(windows[key]).toBe(value);
      expect(ghostty).toContain(`${key} = ${value}\n`);
      expect(wezterm).toContain(`${key} = "${value}"\n`);
    }
  });


it.each([{ NO_COLOR: "1" }, { TERM: "ansi", COLORTERM: "" }])("uses a default-foreground static silhouette without extended colors: %j", (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  try {
    let now = 0;
    const view = new WelcomeHeader("work", shellTheme("dark", "256color"), {
      requestRender: () => undefined, terminalRows: () => 60, stageShare: 1 / 3,
      now: () => now, setTimer: () => () => undefined,
    });
    view.renderStage(100);
    while (view.moving) { now += 100; view.renderStage(100); }
    const faded = view.renderStage(100).join("\n");
    expect(faded).not.toContain("\x1b[2m");
    expect(view.moving).toBe(false);
    expect(faded).not.toContain("\x1b[38;");
    expect(faded).not.toContain("\x1b[48;");
    expect(faded).toMatch(braille);
  } finally { vi.unstubAllEnvs(); }
});

it("keeps the splash at 30% throughout opening, click, and rest", () => {
  const { view, rest } = header();
  const start = view.renderStage(100).join("\n");
  // Canopy success [154,176,143], blended 30% over [32,32,32].
  expect(start).toContain("\x1b[38;2;69;75;65m");
  rest();
  expect(view.renderStage(100).join("\n")).toBe(start);
  const [x, y] = center(view.renderStage(100)); view.click(click(x, y));
  expect(view.renderStage(100).join("\n")).toBe(start);
});


it("draws the first static frame immediately even when mounted, without waiting for a timer", () => {
  const { region } = header();
  expect(region.emptyState.renderIn(100, 20).join("\n")).toMatch(braille);
});

it("does not schedule or replay motion in no-color mode", () => {
  vi.stubEnv("NO_COLOR", "1");
  try {
    const { view, timers } = header();
    view.render(100); const start = view.renderStage(100);
    expect(view.moving).toBe(false); expect(timers).toEqual([]);
    expect(view.clickHeader(click(5, 1))).toBeUndefined();
    const [x, y] = center(start); expect(view.click(click(x, y))).toBeUndefined();
    expect(view.renderStage(100)).toEqual(start);
  } finally { vi.unstubAllEnvs(); }
});
