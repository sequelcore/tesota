export type ShellThemeName = "tesota-dark" | "tesota-light" | "vesper" | "sequel" | "automata" | "phosphor" | "terminal";
export const TESOTA_SHELL_THEME_NAMES = ["tesota-dark", "tesota-light", "vesper", "sequel", "automata", "phosphor", "terminal"] as const;

//@ ensures \result <==> (value === "tesota-dark" || value === "tesota-light" || value === "vesper" || value === "sequel" || value === "automata" || value === "phosphor" || value === "terminal")
export function acceptsShellTheme(value: string): boolean {
  return value === "tesota-dark" || value === "tesota-light" || value === "vesper" || value === "sequel" ||
    value === "automata" || value === "phosphor" || value === "terminal";
}
