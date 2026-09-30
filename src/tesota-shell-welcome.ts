import { readFileSync } from "node:fs";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { colorText, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { safeTerminalText } from "./tesota-shell-transcript.js";

type Logo = Readonly<{ width: number; rows: readonly string[]; tones: readonly string[] }>;

const main: Logo = {
  width: 34,
  rows: [
    "                   _.---._",
    "     _.-._    _.--.       '-._",
    " _.-'     '-.'    '-._        '-.",
    "(                     '-.        )",
    " '-.__               __.-'   _.-'",
    "    '--._ \\  |  /   _.--'",
    "           \\ | /",
    "            \\|/",
    "            \\ \\",
    "             | |          .",
    "            /   \\        '|'",
    "       __.-'  |  '-.__   . . . . .",
  ],
  tones: [
    "                   3333333",
    "     11111    22222       3333",
    " 1111     2222    2222        333",
    "1                     222        3",
    " 22222               22222   3333",
    "    33333 2  2  2   33333",
    "           2 2 2",
    "            222",
    "            2 2",
    "             2 2          1",
    "            2   2        111",
    "       22222  2  22222   3 3 3 3 3",
  ],
};

// The small forms keep the branching trunk and simplify the rear crown.
const compact: Logo = {
  width: 16,
  rows: [
    "        _.-._",
    " _.-._.-.    '.",
    "(          '.  )",
    "'-._ \\|/ _.'",
    "  '- | |  .-' .",
    "   _/ | \\_   '|'",
  ],
  tones: [
    "        33333",
    " 11111222    33",
    "1          22  3",
    "2222 222 222",
    "  33 2 2  333 1",
    "   22 2 22   111",
  ],
};

const symbol: Logo = {
  width: 5,
  rows: [" .-.", "(___)", " _|_"],
  tones: [" 111", "22222", " 222"],
};

/** The five states draw roots, trunk, rear volume, front crown, then the sprout. */
export const TESOTA_WELCOME_FRAMES: readonly (readonly string[])[] = [
  ["", "", "", "", "", "", "", "", "", "", "            /   \\", "       __.-'  |  '-.__"],
  ["", "", "", "", "", "          \\  |  /", "           \\ | /", "            \\|/", "            \\ \\",
    "             | |", "            /   \\", "       __.-'  |  '-.__"],
  ["                   _.---._", "             _.--''       '-._", "          .-'                 '-.",
    "                                 )", "                             _.-'", "          \\  |  /", "           \\ | /",
    "            \\|/", "            \\ \\", "             | |", "            /   \\", "       __.-'  |  '-.__"],
  ["                   _.---._", "     _.-._    _.--.       '-._", " _.-'     '-.'    '-._        '-.",
    "(                     '-.        )", " '-.__               __.-'   _.-'", "    '--._ \\  |  /   _.--'",
    "           \\ | /", "            \\|/", "            \\ \\", "             | |",
    "            /   \\", "       __.-'  |  '-.__   . . . . ."],
  main.rows,
].map((rows) => rows.map((row) => row.padEnd(main.width, " ")));

const compactWithoutSprout = compact.rows.map((row, index) =>
  index === 4 ? row.slice(0, 15) : index === 5 ? row.slice(0, 13) : row);
const compactFrames: readonly (readonly string[])[] = [
  ["", "", "", "", "", compactWithoutSprout[5] ?? ""],
  ["", "", "", ...compactWithoutSprout.slice(3)],
  [compact.rows[0] ?? "", "", "", ...compactWithoutSprout.slice(3)],
  compactWithoutSprout,
  compact.rows,
].map((rows) => rows.map((row) => row.padEnd(compact.width, " ")));

const symbolFrames: readonly (readonly string[])[] = [
  ["", "", symbol.rows[2] ?? ""],
  ["", "  |", symbol.rows[2] ?? ""],
  [symbol.rows[0] ?? "", "  |", symbol.rows[2] ?? ""],
  symbol.rows,
  symbol.rows,
].map((rows) => rows.map((row) => row.padEnd(symbol.width, " ")));

export const TESOTA_LOGOS: Readonly<Record<"main" | "compact" | "symbol", readonly string[]>> = Object.freeze({
  main: Object.freeze(main.rows.map((row) => row.padEnd(main.width, " "))),
  compact: Object.freeze(compact.rows.map((row) => row.padEnd(compact.width, " "))),
  symbol: Object.freeze(symbol.rows.map((row) => row.padEnd(symbol.width, " "))),
});

export const TESOTA_LOGO_TONES: Readonly<Record<"main" | "compact" | "symbol", readonly string[]>> = Object.freeze({
  main: Object.freeze(main.tones.map((row) => row.padEnd(main.width, " "))),
  compact: Object.freeze(compact.tones.map((row) => row.padEnd(compact.width, " "))),
  symbol: Object.freeze(symbol.tones.map((row) => row.padEnd(symbol.width, " "))),
});

const palettes = {
  dark: { rgb: ["#E6D3A3", "#A3B18A", "#74806F"], ansi256: [187, 144, 244] },
  light: { rgb: ["#8C6A1E", "#4E6146", "#65705F"], ansi256: [94, 59, 242] },
} as const;

export type WelcomeColorMode = "truecolor" | "ansi256" | "plain";

export function welcomeColorMode(env: NodeJS.ProcessEnv = process.env): WelcomeColorMode {
  if (env["NO_COLOR"] !== undefined || env["TERM"] === "dumb") return "plain";
  if (env["COLORTERM"]?.includes("truecolor") || env["COLORTERM"]?.includes("24bit")) return "truecolor";
  return env["TERM"]?.includes("256color") ? "ansi256" : "truecolor";
}

function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest &&
      typeof manifest.version === "string") return manifest.version;
  } catch { /* A source checkout without a manifest still has an identity. */ }
  return "dev";
}

function paint(row: string, tones: string, theme: TesotaShellTheme, mode: WelcomeColorMode): string {
  if (mode === "plain" || theme.appearance === "terminal") return row;
  const palette = palettes[theme.appearance];
  let output = "";
  for (let index = 0; index < row.length;) {
    const tone = tones[index];
    let end = index + 1;
    while (end < row.length && tones[end] === tone) end++;
    const segment = row.slice(index, end);
    if (tone === undefined || tone === " ") output += segment;
    else if (mode === "ansi256") output += `\x1b[38;5;${palette.ansi256[Number(tone) - 1]}m${segment}\x1b[39m`;
    else output += colorText(segment, palette.rgb[Number(tone) - 1] ?? null);
    index = end;
  }
  return output;
}

/** Ephemeral first-session identity; it never enters the saved conversation. */
export class WelcomeBanner implements Component {
  readonly #cwd: string;
  readonly #theme: TesotaShellTheme;
  readonly #height: () => number;
  readonly #mode: WelcomeColorMode;
  readonly #version: string;
  #frame: number;

  constructor(cwd: string, theme: TesotaShellTheme, height: () => number,
    options: { readonly reducedMotion?: boolean; readonly colorMode?: WelcomeColorMode } = {}) {
    this.#cwd = safeTerminalText(cwd);
    this.#theme = theme;
    this.#height = height;
    this.#mode = options.colorMode ?? welcomeColorMode();
    this.#version = packageVersion();
    this.#frame = options.reducedMotion === true ? TESOTA_WELCOME_FRAMES.length - 1 : 0;
  }

  advance(): boolean {
    if (this.#frame >= TESOTA_WELCOME_FRAMES.length - 1) return false;
    this.#frame++;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = this.#height();
    const chosen = width >= main.width && height >= 22 ? main :
      width >= compact.width && height >= 13 ? compact : width >= symbol.width && height >= 9 ? symbol : undefined;
    const title = `Tesota ${this.#version}`;
    const lines = [truncateToWidth(title, width), truncateToWidth(this.#cwd, width),
      truncateToWidth("Every turn is reviewed; reverting never overwrites your edits.", width), ""];
    if (chosen !== undefined) {
      const rows = chosen === main ? TESOTA_WELCOME_FRAMES[this.#frame] ?? TESOTA_LOGOS.main :
        chosen === compact ? compactFrames[this.#frame] ?? TESOTA_LOGOS.compact :
          symbolFrames[this.#frame] ?? TESOTA_LOGOS.symbol;
      for (const [index, row] of rows.entries()) {
        const tones = chosen === main ? [...row].map((character, column) => {
          if (character === " ") return " ";
          if (main.rows[index]?.[column] === character) return main.tones[index]?.[column] ?? "2";
          return this.#frame === 2 && index < 5 ? "3" : "2";
        }).join("") : chosen.tones[index]?.padEnd(chosen.width, " ") ?? "";
        lines.push(paint(row, tones, this.#theme, this.#mode));
      }
    }
    return lines;
  }
}
