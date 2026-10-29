import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTerminalSequences, type TerminalColorMode, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import type { Theme } from "../src/contract.js";
import { shellTheme } from "../src/theme.js";
import { GREETINGS, mountWelcomeHeader, WelcomeHeader, WORDMARK } from "../src/welcome-header.js";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function theme(name: string, mode: TerminalColorMode = "truecolor"): Theme {
  return shellTheme(name === "tesota-light" ? "light" : "dark", mode);
}

/** The welcome block at `width` as the terminal shows it, without color. */
function shown(cwd: string, width: number, pick: (count: number) => number = () => 0): string[] {
  return new WelcomeHeader(cwd, theme("tesota-dark"), { pick }).block(width).map((row) => stripTerminalSequences(row));
}

/** The themes Tesota ships: one for a dark terminal and one for a light one. */
const shipped = { "tesota-dark": "dark", "tesota-light": "light" } as const;

it("ships a theme for each appearance, and only those", () => {
  expect(readdirSync(join(packageRoot, "themes")).toSorted()).toEqual(Object.keys(shipped).map((name) => `${name}.json`)
    .toSorted());
  for (const [name, appearance] of Object.entries(shipped)) expect(theme(name).appearance).toBe(appearance);
});

it("gives both themes the same tokens and surfaces, each a color the terminal can show", () => {
  const tokens = (name: string): string[] => {
    const file = JSON.parse(readFileSync(join(packageRoot, "themes", `${name}.json`), "utf8")) as
      { colors: Record<string, unknown>; export?: Record<string, unknown> };
    return [...Object.keys(file.colors), ...Object.keys(file.export ?? {})].toSorted();
  };
  expect(tokens("tesota-light")).toEqual(tokens("tesota-dark"));
  for (const name of Object.keys(shipped)) expect(Object.keys(theme(name).colors).toSorted()).toEqual(tokens(name));
});

it("draws nothing as a header: the welcome screen is the block the shell centers", () => {
  const view = new WelcomeHeader("/work/shop", theme("tesota-dark"));
  expect(view.render()).toEqual([]);
  const mounted = mountWelcomeHeader(view);
  expect(mounted.render(100)).toEqual([]);
  expect(mounted.emptyState.block(100)).toEqual(view.block(100));
});

it("opens with the wordmark, the version and folder under it, then a greeting, each row centered", () => {
  const rows = shown("/work/shop", 100);
  expect(rows.slice(0, 4).map((row) => row.trim())).toEqual(WORDMARK.map((row) => row.trim()));
  expect(rows[4]).toMatch(/^\s+v?\S+ · \/work\/shop$/u);
  expect(rows[5]).toBe("");
  expect(rows[6]?.trim()).toBe("What should we work on?");
  for (const row of rows.filter((row) => row !== "")) {
    const left = row.length - row.trimStart().length;
    expect(Math.abs(left - (100 - left - visibleWidth(row.trimStart())))).toBeLessThanOrEqual(1);
  }
});

it("gives way to the name where the wordmark does not fit, and never overflows", () => {
  const width = visibleWidth(WORDMARK[0]!) - 1;
  const rows = shown("/a/very/long/folder/name/for/a/narrow/terminal", width);
  expect(rows[0]?.trim()).toBe("Tesota");
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  expect(rows[1]).toContain("…");
});

it("shows a folder under the home folder from ~, as the footer does", () => {
  const written = shown(join(homedir(), "work", "shop"), 100).join("\n");
  expect(written).toContain(join("~", "work", "shop"));
  expect(written).not.toContain(homedir());
});

it("picks one greeting for the session, the same every time it is drawn", () => {
  const asked: number[] = [];
  const view = new WelcomeHeader("/work/shop", theme("tesota-dark"), { pick: (count) => { asked.push(count); return 2; } });
  expect(asked).toEqual([GREETINGS.length]);
  for (const _ of [1, 2]) expect(stripTerminalSequences(view.block(100).at(-1) ?? "").trim()).toBe(GREETINGS[2]);
  // A greeting asks, without naming the folder, which the row above already shows.
  for (const greeting of GREETINGS) expect(greeting).toMatch(/^[A-Z][^/\\]*\?$/u);
  // A pick outside the list still lands on a greeting.
  expect(shown("/work/shop", 100, () => 99).at(-1)?.trim()).toBe(GREETINGS.at(-1));
});

it("never writes a folder's control characters to the terminal", () => {
  const written = new WelcomeHeader("work\x1b]0;title\x07", theme("tesota-dark")).block(100).join("\n");
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

/** WCAG relative luminance contrast between two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

it.each(Object.keys(shipped))("keeps every text color of %s readable on its canvas and in the input band", (name) => {
  const { vars } = JSON.parse(readFileSync(join(packageRoot, "themes", `${name}.json`), "utf8")) as { vars: Record<string, string> };
  for (const role of ["text", "muted", "dim", "accent", "green", "gold", "rose"]) {
    for (const surface of ["canvas", "userBg"]) expect(contrast(vars[role]!, vars[surface]!), `${role} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
});
