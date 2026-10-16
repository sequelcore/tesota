import {
  backgroundAnsi, type Color, type EditorTheme, foregroundAnsi, type MarkdownTheme, parseColor, type SelectListTheme,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import dark from "../../../../themes/tesota-dark.json" with { type: "json" };
import light from "../../../../themes/tesota-light.json" with { type: "json" };

/** A theme file as Tesota ships them, in Pi's format: named colors, and tokens that use them or a color of their own. */
interface ThemeFile {
  readonly name: string;
  readonly appearance: string;
  readonly vars?: Readonly<Record<string, string | number>>;
  readonly colors: Readonly<Record<string, string | number>>;
}

/** The colors the shell draws with, by token; a token a theme lacks draws in the terminal's own color. */
export type ThemeToken = keyof typeof dark.colors;

/** How the shell styles text (#444): Tesota's theme for the terminal's appearance, in the colors the terminal can show. */
export interface ShellTheme {
  readonly name: string;
  fg(token: ThemeToken, text: string): string;
  bg(token: ThemeToken, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
  readonly markdown: MarkdownTheme;
  readonly editor: EditorTheme;
  readonly selectList: SelectListTheme;
}

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

/** Tesota's theme for a dark or light terminal, drawn in `mode`'s colors. */
export function shellTheme(appearance: "dark" | "light", mode: TerminalColorMode): ShellTheme {
  const file: ThemeFile = appearance === "dark" ? dark : light;
  const colors = colorsOf(file);
  const fg = (token: ThemeToken, text: string): string => {
    const color = colors.get(token);
    return color === undefined ? text : `${foregroundAnsi(color, mode)}${text}\x1b[39m`;
  };
  const bg = (token: ThemeToken, text: string): string => {
    const color = colors.get(token);
    return color === undefined ? text : `${backgroundAnsi(color, mode)}${text}\x1b[49m`;
  };
  const bold = wrap("1", "22");
  const italic = wrap("3", "23");
  const underline = wrap("4", "24");
  const strikethrough = wrap("9", "29");
  const selectList: SelectListTheme = {
    selectedPrefix: (text) => fg("accent", text), selectedText: (text) => fg("accent", bold(text)),
    description: (text) => fg("muted", text), scrollInfo: (text) => fg("dim", text), noMatch: (text) => fg("muted", text),
  };
  return {
    name: file.name, fg, bg, bold, italic, underline, inverse: wrap("7", "27"), strikethrough,
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
