import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Render untrusted words without letting their controls repaint terminal-owned UI. */
export function terminalText(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/gu, "\n")
    .replace(/\p{Cc}/gu, (character) => character === "\n" || character === "\t" ? character : "�");
}
