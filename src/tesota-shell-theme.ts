export const TESOTA_SHELL_THEME_NAMES = ["tesota-dark", "tesota-light", "terminal"] as const;

export type TesotaShellThemeName = typeof TESOTA_SHELL_THEME_NAMES[number];

export interface TesotaShellTheme {
  readonly name: TesotaShellThemeName;
  readonly muted: string | null;
  readonly accent: string | null;
  readonly success: string | null;
  readonly warning: string | null;
}

// Adapted from the Tesota light/dark operator palettes in kiln-legacy-2026-09.
// The terminal variant leaves color selection to the user's terminal profile.
const themes: Readonly<Record<TesotaShellThemeName, TesotaShellTheme>> = Object.freeze({
  "tesota-dark": Object.freeze({
    name: "tesota-dark", muted: "#b9b7aa", accent: "#c6a8d2",
    success: "#9ab08f", warning: "#d5b36a",
  }),
  "tesota-light": Object.freeze({
    name: "tesota-light", muted: "#5f6258", accent: "#6d4b78",
    success: "#4f624a", warning: "#6e602c",
  }),
  terminal: Object.freeze({
    name: "terminal", muted: null, accent: null,
    success: null, warning: null,
  }),
});

export function parseTesotaShellTheme(value: string): TesotaShellThemeName | undefined {
  return TESOTA_SHELL_THEME_NAMES.find((name) => name === value);
}

export function tesotaShellTheme(name: TesotaShellThemeName = "tesota-dark"): TesotaShellTheme {
  return themes[name];
}

export function colorText(text: string, color: string | null): string {
  if (color === null) return text;
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}
