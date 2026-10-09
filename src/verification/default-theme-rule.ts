/**
 * Whether the `tesota` command opens Pi in Tesota's light/dark theme pair:
 * only when the operator's settings could be read and name no theme, and they
 * did not pick one for this run with `--use-theme`. A theme they chose always
 * wins, and unreadable settings leave the choice to Pi.
 */
//@ ensures \result <==> settingsRead && !themeSet && !themeArgument
export function usesTesotaTheme(settingsRead: boolean, themeSet: boolean, themeArgument: boolean): boolean {
  return settingsRead && !themeSet && !themeArgument;
}
