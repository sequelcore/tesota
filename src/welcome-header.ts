import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "./contract.js";
import { homeRelative } from "./footer.js";
import { host } from "./host.js";

/** What Tesota is, in one sentence, for `--help`. */
export const TAGLINE = "A coding agent that checks its code, challenges its specs, and flags where they may miss your request.";

/** Tesota's name in lowercase block letters, four rows of four columns each, one column apart. */
const LETTERS: Readonly<Record<string, readonly string[]>> = {
  t: [" ▄  ", "▀█▀▀", " █  ", " ▀▀▀"], e: ["    ", "█▀▀█", "█▀▀▀", "▀▀▀▀"], s: ["    ", "█▀▀▀", "▀▀▀█", "▀▀▀▀"],
  o: ["    ", "█▀▀█", "█  █", "▀▀▀▀"], a: ["    ", "▀▀▀█", "█▀▀█", "▀▀▀▀"],
};
export const WORDMARK: readonly string[] = [0, 1, 2, 3].map((row) => [..."tesota"].map((letter) => LETTERS[letter]![row]).join(" "));

/** The questions the welcome screen opens with: calm, short, one per session. */
export const GREETINGS: readonly string[] = ["What should we work on?", "What are we changing today?", "Where should we start?",
  "What needs fixing?", "What do you want checked?"];

export interface WelcomeHeaderOptions {
  /** Which of the greetings this session opens with, given how many there are; a random one by default. */
  readonly pick?: (count: number) => number;
}

/**
 * The welcome screen (#749): Tesota's wordmark, its version and folder, and a
 * greeting, centered by the shell with the input under it until the first
 * message. Nothing is drawn as a header; the model and folder stay in the footer.
 */
export class WelcomeHeader implements Component {
  readonly #cwd: string;
  readonly #theme: Theme;
  readonly #version = host().version;
  readonly #greeting: string;

  constructor(cwd: string, theme: Theme, options: WelcomeHeaderOptions = {}) {
    this.#cwd = Array.from(homeRelative(cwd), (character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? "?" : character;
    }).join("");
    this.#theme = theme;
    const pick = options.pick ?? ((count) => Math.floor(Math.random() * count));
    this.#greeting = GREETINGS[Math.min(GREETINGS.length - 1, Math.max(0, pick(GREETINGS.length)))]!;
  }

  render(): string[] { return []; }
  invalidate(): void {}

  /** The welcome block at `width`, each row centered; the wordmark gives way to the name where it does not fit. */
  block(width: number): string[] {
    const theme = this.#theme;
    const version = /^\d/u.test(this.#version) ? `v${this.#version}` : this.#version;
    const room = Math.max(0, width - visibleWidth(version) - 3);
    const cwdWidth = visibleWidth(this.#cwd);
    const cwd = cwdWidth <= room ? this.#cwd : room <= 1 ? "" : `…${sliceByColumn(this.#cwd, cwdWidth - room + 1, room - 1)}`;
    const name = visibleWidth(WORDMARK[0]!) <= width ? WORDMARK.map((row) => theme.fg("text", row)) : [theme.bold("Tesota")];
    const rows = [...name, theme.fg("dim", version) + (cwd === "" ? "" : theme.fg("dim", " · ") + theme.fg("muted", cwd)), "",
      theme.fg("muted", this.#greeting)];
    return rows.map((row) => row === "" ? row : " ".repeat(Math.max(0, Math.floor((width - visibleWidth(row)) / 2))) + row);
  }
}

/** The header as the shell mounts it: nothing in the header's row, and the welcome block for the empty screen. */
export function mountWelcomeHeader(header: WelcomeHeader): Component & { emptyState: { block(width: number): string[] } } {
  return { render: () => [], invalidate: () => undefined, emptyState: { block: (width) => header.block(width) } };
}
