import { visibleWidth } from "@earendil-works/pi-tui";

const TESOTA_SHELL_THEME_NAMES = ["tesota-dark", "tesota-light", "terminal"] as const;

export type TesotaShellThemeName = typeof TESOTA_SHELL_THEME_NAMES[number];

export interface TesotaShellTheme {
  readonly name: TesotaShellThemeName;
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
}

// Adapted from the Tesota light/dark operator palettes in kiln-legacy-2026-09.
// The terminal variant leaves color selection to the user's terminal profile.
const themes: Readonly<Record<TesotaShellThemeName, TesotaShellTheme>> = Object.freeze({
  "tesota-dark": Object.freeze({
    name: "tesota-dark", muted: "#b9b7aa", accent: "#c6a8d2",
    success: "#9ab08f", warning: "#d5b36a", error: "#d88c8c", userBackground: "#2f2a35",
    selectionBackground: "#4b3d53", addedBackground: "#1d3324", removedBackground: "#3d1f24",
  }),
  "tesota-light": Object.freeze({
    name: "tesota-light", muted: "#5f6258", accent: "#6d4b78",
    success: "#4f624a", warning: "#6e602c", error: "#8e3b3b", userBackground: "#efe9f2",
    selectionBackground: "#e2d6e8", addedBackground: "#dcefe0", removedBackground: "#f6dfdf",
  }),
  terminal: Object.freeze({
    name: "terminal", muted: null, accent: null,
    success: null, warning: null, error: null, userBackground: null, selectionBackground: null,
    addedBackground: null, removedBackground: null,
  }),
});

export function parseTesotaShellTheme(value: string): TesotaShellThemeName | undefined {
  return TESOTA_SHELL_THEME_NAMES.find((name) => name === value);
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

export function bold(text: string): string { return `\x1b[1m${text}\x1b[22m`; }
function dim(text: string): string { return `\x1b[2m${text}\x1b[22m`; }

/** The theme's muted color, or the terminal's dim style when the theme leaves colors to the terminal. */
export function mutedText(text: string, theme: TesotaShellTheme): string {
  return theme.muted === null ? dim(text) : colorText(text, theme.muted);
}

/** A selected row, filled to the width: the theme's selection background, or reverse video when colors are the terminal's. */
export function selectedRow(line: string, width: number, theme: TesotaShellTheme): string {
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  return theme.selectionBackground === null ? `\x1b[7m${padded}\x1b[27m` : backgroundText(padded, theme.selectionBackground);
}
