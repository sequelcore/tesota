import {
  backgroundAnsi, type Color, foregroundAnsi, parseColor, type SelectListTheme,
  stripTerminalSequences, truncateToWidth, type TerminalColorMode, visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "./contract.js";
import dark from "../themes/tesota-dark.json" with { type: "json" };
import light from "../themes/tesota-light.json" with { type: "json" };

/** A theme file as Tesota ships them: named colors, and tokens that use them or a color of their own. */
interface ThemeFile {
  readonly name: string;
  readonly appearance: string;
  readonly vars?: Readonly<Record<string, string | number>>;
  readonly colors: Readonly<Record<string, string | number>>;
}

/** The colors the shell draws with, by token; a token a theme lacks draws in the terminal's own color. */
export type ThemeToken = ThemeColor;

/** How the shell styles text (#444): Tesota's theme for the terminal's appearance, in the colors the terminal can show. */
export type ShellTheme = Theme;

const wrap = (on: string, off: string) => (text: string): string => `\x1b[${on}m${text}\x1b[${off}m`;

/** Each token's color, a theme variable resolved; a value that is not a color is left to the terminal. */
function colorsOf(file: ThemeFile): Map<string, Color> {
  const colors = new Map<string, Color>();
  for (const [token, value] of Object.entries(file.colors)) {
    const resolved = typeof value === "string" && file.vars?.[value] !== undefined ? file.vars[value] : value;
    try { colors.set(token, parseColor(resolved as string | number)); } catch { /* not a color: the terminal's own */ }
  }
  return colors;
}

/** Finish a pi-tui list row at its owner's width; only the selected row gets a band, including any inset. */
export function listRow(theme: ShellTheme, line: string, width: number, inset = 0): string {
  const row = `${" ".repeat(inset)}${line}`;
  if (!stripTerminalSequences(line).startsWith("› ")) return row;
  const fitted = truncateToWidth(row, width, "");
  return theme.bg("selectedBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))));
}

/** Tesota's theme for a dark or light terminal, drawn in `mode`'s colors. */
export function shellTheme(appearance: "dark" | "light", mode: TerminalColorMode): ShellTheme {
  let file: ThemeFile = appearance === "dark" ? dark : light;
  let colors = colorsOf(file);
  const noColor = process.env["NO_COLOR"] !== undefined && process.env["NO_COLOR"] !== "";
  // pi-tui exposes truecolor/256color only; do not paint a quantized dark band on a basic ANSI palette.
  const plainBackground = noColor || (mode === "256color" && process.env["TERM"] !== undefined
    && !/256color|direct/iu.test(process.env["TERM"]!) && !/truecolor|24bit/iu.test(process.env["COLORTERM"] ?? ""));
  const fg = (token: ThemeToken, text: string): string => {
    const color = colors.get(token);
    return noColor || color === undefined ? text : `${foregroundAnsi(color, mode)}${text}\x1b[39m`;
  };
  const bgAnsi = (token: ThemeToken): string => {
    const color = colors.get(token);
    return plainBackground || color === undefined ? "" : backgroundAnsi(color, mode);
  };
  const bg = (token: ThemeToken, text: string): string => {
    const start = bgAnsi(token);
    return start === "" ? text : `${start}${text.replaceAll("\x1b[0m", `\x1b[0m${start}`).replaceAll("\x1b[49m", start)}\x1b[49m`;
  };
  const bold = wrap("1", "22");
  const italic = wrap("3", "23");
  const underline = wrap("4", "24");
  const strikethrough = wrap("9", "29");
  const selectList: SelectListTheme = {
    selectedPrefix: (text) => fg("text", text.replace(/^→ /u, "› ")), selectedText: (text) => fg("text", text.replace(/^→ /u, "› ")),
    description: (text) => fg("muted", text), scrollInfo: (text) => fg("dim", text), noMatch: (text) => fg("muted", text),
  };
  return {
    get name() { return file.name; },
    get appearance() { return file.appearance === "light" ? "light" : "dark"; },
    get colors() { return Object.fromEntries(colors); },
    getColorMode: () => mode,
    getBgAnsi: bgAnsi,
    use: (next) => {
      file = next === "dark" ? dark : light;
      colors = colorsOf(file);
    },
    fg, bg, bold, italic, underline, inverse: wrap("7", "27"), strikethrough,
    markdown: {
      heading: (text) => fg("mdHeading", bold(text)), link: (text) => fg("mdLink", underline(text)), linkUrl: (text) => fg("mdLinkUrl", text),
      code: (text) => fg("mdCode", text), codeBlock: (text) => fg("mdCodeBlock", text), codeBlockBorder: (text) => fg("mdCodeBlockBorder", text),
      quote: (text) => fg("mdQuote", italic(text)), quoteBorder: (text) => fg("mdQuoteBorder", text), hr: (text) => fg("mdHr", text),
      listBullet: (text) => fg("mdListBullet", text), bold, italic, strikethrough, underline,
    },
    editor: { borderColor: (text) => fg("border", text), selectList },
    selectList,
  };
}
