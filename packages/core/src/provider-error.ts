import { terminalText } from "../../../src/terminal-text.ts";

/** A bounded provider diagnostic for terminal output, never a raw credential or terminal control. */
export function providerError(text: string): string {
  const redacted = text
    .replace(/(\b[a-z][a-z\d+.-]*:(?:\\?\/){2}[^\s"'<>?]+)\?[^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:[A-Za-z]+\s+)?[^\s"',;}\\]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[^\s"',;\\]+/gi, "$1[redacted]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret)["']?\s*[:=]\s*["']?)(?!Bearer\s)[^\s"',;}\\]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-|sess-|AIza|ghp_|gho_|gsk_|xai-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
  const safe = terminalText(redacted).replace(/\s+/gu, " ");
  return safe.length > 2000 ? `${safe.slice(0, 1999)}…` : safe;
}
