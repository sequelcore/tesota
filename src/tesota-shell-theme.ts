import { colorToHex, mixColors, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { acceptsShellTheme, type ShellThemeName } from "./verification/shell-theme-rule.js";

export { TESOTA_SHELL_THEME_NAMES } from "./verification/shell-theme-rule.js";

export type TesotaShellThemeName = ShellThemeName;

export interface TesotaShellTheme {
  readonly name: TesotaShellThemeName;
  readonly appearance: "dark" | "light" | "terminal";
  readonly foreground: string | null;
  readonly muted: string | null;
  readonly accent: string | null;
  readonly success: string | null;
  readonly warning: string | null;
  readonly error: string | null;
  /** Background of the operator's own messages, so they stand apart from the agent's. */
  readonly userBackground: string | null;
  /** Full-row highlight for the selected shell command. */
  readonly selectionBackground: string | null;
  /** Tints of added and removed rows in the diff view. */
  readonly addedBackground: string | null;
  readonly removedBackground: string | null;
  /** Surface of a panel over the layout, such as Accounts: a second neutral layer, raised from the terminal's own. */
  readonly panelBackground: string | null;
  /** The terminal background the theme is drawn for, which its side surfaces step from until the terminal reports its own. */
  readonly canvas: string | null;
}

// Adapted from the Tesota light/dark operator palettes in kiln-legacy-2026-09.
// The terminal variant leaves color selection to the user's terminal profile.
const themes: Readonly<Record<TesotaShellThemeName, TesotaShellTheme>> = Object.freeze({
  "tesota-dark": Object.freeze({
    name: "tesota-dark", appearance: "dark", foreground: "#f2eee6", muted: "#b9b7aa", accent: "#c6a8d2",
    success: "#9ab08f", warning: "#d5b36a", error: "#d88c8c", userBackground: "#2f2a35",
    selectionBackground: "#4b3d53", addedBackground: "#1d3324", removedBackground: "#3d1f24",
    panelBackground: "#312b38", canvas: "#202020",
  }),
  "tesota-light": Object.freeze({
    name: "tesota-light", appearance: "light", foreground: "#24211f", muted: "#5f6258", accent: "#6d4b78",
    success: "#4f624a", warning: "#6e602c", error: "#8e3b3b", userBackground: "#e4d9e9",
    selectionBackground: "#d3c2dc", addedBackground: "#dcefe0", removedBackground: "#f6dfdf",
    panelBackground: "#faf7fb", canvas: "#edede5",
  }),
  vesper: Object.freeze({
    name: "vesper", appearance: "dark", foreground: "#ffffff", muted: "#a0a0a0", accent: "#ffc799",
    success: "#72d68b", warning: "#e7d078", error: "#ff8080", userBackground: "#2a2522",
    selectionBackground: "#49392d", addedBackground: "#1d3324", removedBackground: "#3d1f24",
    panelBackground: "#2d2824", canvas: "#202020",
  }),
  sequel: Object.freeze({
    name: "sequel", appearance: "dark", foreground: "#f4f1e9", muted: "#b8b0a4", accent: "#b3a58e",
    success: "#91c29a", warning: "#e5c16f", error: "#e09a91", userBackground: "#28251f",
    selectionBackground: "#423a2e", addedBackground: "#1d3324", removedBackground: "#3d1f24",
    panelBackground: "#2e2a24", canvas: "#202020",
  }),
  automata: Object.freeze({
    name: "automata", appearance: "light", foreground: "#211f1b", muted: "#4d4b3f", accent: "#494333",
    success: "#344d37", warning: "#584917", error: "#80291e", userBackground: "#dedac7",
    selectionBackground: "#ada585", addedBackground: "#d2dfc9", removedBackground: "#efd3c6",
    panelBackground: "#e6e3d2", canvas: "#ccc8b1",
  }),
  phosphor: Object.freeze({
    name: "phosphor", appearance: "dark", foreground: "#d5e8d8", muted: "#8aab91", accent: "#3dff7c",
    success: "#9bd2ad", warning: "#f2c66d", error: "#f08caf", userBackground: "#19291e",
    selectionBackground: "#254331", addedBackground: "#1a3524", removedBackground: "#3c202d",
    panelBackground: "#1d2e23", canvas: "#202020",
  }),
  terminal: Object.freeze({
    name: "terminal", appearance: "terminal", foreground: null, muted: null, accent: null,
    success: null, warning: null, error: null, userBackground: null, selectionBackground: null,
    addedBackground: null, removedBackground: null, panelBackground: null, canvas: null,
  }),
});

export function parseTesotaShellTheme(value: string): TesotaShellThemeName | undefined {
  return acceptsShellTheme(value) ? value as TesotaShellThemeName : undefined;
}

export function tesotaShellTheme(name: TesotaShellThemeName = "tesota-dark"): TesotaShellTheme {
  return themes[name];
}

function rgb(color: string): string {
  return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16)).join(";");
}

export function colorText(text: string, color: string | null): string {
  return color === null ? text : `\x1b[38;2;${rgb(color)}m${text}\x1b[39m`;
}

export function backgroundText(text: string, color: string | null): string {
  return color === null ? text : `\x1b[48;2;${rgb(color)}m${text}\x1b[49m`;
}

/**
 * A line on a panel's surface. Styles inside it that end a background, such
 * as a selected row's, would open a hole to the layout beneath, so the
 * surface is laid again after each.
 */
export function surfaceText(line: string, color: string | null): string {
  if (color === null) return line;
  const surface = `\x1b[48;2;${rgb(color)}m`;
  return `${surface}${line.replaceAll("\x1b[49m", surface).replaceAll("\x1b[0m", `\x1b[0m${surface}`)}\x1b[49m`;
}

/**
 * A line of the layout beneath an open panel: its own styles removed and
 * the rest faint in the muted color, so only the panel holds the eye.
 */
export function fadedText(line: string, theme: TesotaShellTheme): string {
  const text = stripTerminalSequences(line);
  return `\x1b[2m${theme.muted === null ? text : colorText(text, theme.muted)}\x1b[22m`;
}

export function bold(text: string): string { return `\x1b[1m${text}\x1b[22m`; }
function dim(text: string): string { return `\x1b[2m${text}\x1b[22m`; }

/** The theme's muted color, or the terminal's dim style when the theme leaves colors to the terminal. */
export function mutedText(text: string, theme: TesotaShellTheme): string {
  return theme.muted === null ? dim(text) : colorText(text, theme.muted);
}

/** A selected row, filled to the width: the theme's selection background, or reverse video when colors are the terminal's. */
export function selectedRow(line: string, width: number, theme: TesotaShellTheme): string {
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  // A full reset inside the row, as truncation leaves before its ellipsis, would end the selection's colors there:
  // they are laid again after each, so the whole row stays selected.
  const selection = theme.selectionBackground === null ? "\x1b[7m"
    : `\x1b[48;2;${rgb(theme.selectionBackground)}m${theme.foreground === null ? "" : `\x1b[38;2;${rgb(theme.foreground)}m`}`;
  const kept = padded.replaceAll("\x1b[0m", `\x1b[0m${selection}`);
  return theme.selectionBackground === null ? `\x1b[7m${kept}\x1b[27m` :
    backgroundText(colorText(kept, theme.foreground), theme.selectionBackground);
}

/**
 * The shell's structural surfaces, stepped from the terminal's own background
 * so they sit evenly on any terminal: `side`, a little toward the text color,
 * under the sidebar and the result panel beside the conversation, which stays
 * on the terminal's background as the main content; and `rule`, further, for
 * the line between them. Mixing in sRGB keeps a neutral background neutral;
 * hue is left to what carries meaning, as the operator's own messages and
 * input. Without colors, as the terminal theme, only the rule shows.
 */
export interface ShellSurfaces {
  readonly side: string | null;
  readonly rule: string | null;
}

const SIDE_STEP = 0.06;
const RULE_STEP = 0.24;

export function shellSurfaces(theme: TesotaShellTheme, canvas?: string): ShellSurfaces {
  const base = canvas ?? theme.canvas;
  const foreground = theme.foreground;
  if (base === null || foreground === null) return { side: null, rule: theme.muted };
  const step = (amount: number): string => colorToHex(mixColors(parseColor(base), parseColor(foreground), amount, "srgb"));
  return { side: step(SIDE_STEP), rule: step(RULE_STEP) };
}

export const TESOTA_SHELL_THEME_DESCRIPTIONS: Readonly<Record<TesotaShellThemeName, string>> = {
  "tesota-dark": "Dark · ironwood and lavender",
  "tesota-light": "Light · ivory and lavender",
  vesper: "Dark · charcoal and peach",
  sequel: "Dark · warm neutrals and sand",
  automata: "Light · parchment and ink",
  phosphor: "Dark · green phosphor, distinct status colors",
  terminal: "Your terminal's colors",
};
