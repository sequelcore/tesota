import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Editor } from "@earendil-works/pi-tui";

/** The editor class Tesota's filled editor extends: Pi's `CustomEditor` on Pi, which carries Pi's app keys; pi-tui's on the engine. */
export type EditorBase = new (tui: TUI, theme: EditorTheme, keybindings: never, options?: { paddingX?: number }) => Editor;

/**
 * The values Tesota's interface takes from the program that runs it, rather
 * than from Pi directly (#446): Pi's entry (`extension.ts`) gives Pi's own,
 * and the engine's shell gives its own, so on the engine Pi is never loaded.
 * Temporary until slice 11 of #432 removes Pi: then `src/` takes the shell's
 * directly and this goes.
 */
export interface HostParts {
  readonly EditorBase: EditorBase;
  /** The keys bound to an action, as the operator would press them. */
  readonly keyText: (action: string) => string;
  /** The host's name and version, as a receipt records what ran. */
  readonly version: string;
  /** The shell commands run in: its path and arguments, and whether it reads the command from its input instead. */
  readonly shellConfig: () => { shell: string; args: string[]; commandTransport?: "argv" | "stdin" };
}

let given: HostParts | undefined;

/** Gives Tesota its host's parts, once, before its extension loads. */
export function provideHost(parts: HostParts): void { given = parts; }

/** The host's parts; a program that loads Tesota without giving them is a mistake. */
export function host(): HostParts {
  if (given === undefined) throw new Error("Tesota's host gave it no parts: load it through src/extension.ts on Pi, or the engine's shell.");
  return given;
}
