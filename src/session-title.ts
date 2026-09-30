/**
 * A session's name (decision 036): at once the operator's first request
 * shortened, then a model's short title for it, unless the operator renamed
 * the session. Whether a name may replace another is `replacesTitle`.
 */

/** The longest name kept; the store allows 100 characters, and the rail shows about 20. */
export const TITLE_MAX_LENGTH = 60;
/** A shortened request stays short enough to read as a name, not as the request. */
const SEED_MAX_LENGTH = 48;

/** Text as one line of printable characters, without surrounding spaces. */
function oneLine(text: string): string {
  // Control characters, including escape sequences' introducers, never reach the terminal from a name.
  const printable = [...text].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code >= 127 && code <= 159 ? " " : character;
  }).join("");
  return printable.replace(/\s+/gu, " ").trim();
}

/** Cut at a word boundary when one is near, marking the cut. */
function shortened(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The first request as a name, shown until a model's title arrives; undefined when it holds no text. */
export function seedTitle(request: string): string | undefined {
  const line = oneLine(request.split(/\r?\n/u).find((part) => part.trim() !== "") ?? "");
  return line === "" ? undefined : shortened(line, SEED_MAX_LENGTH);
}

/** A title as given by a model or the operator, made safe to show; undefined when nothing is left. */
export function cleanTitle(title: string): string | undefined {
  const line = oneLine(title).replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "").replace(/[.。]+$/u, "").trim();
  return line === "" ? undefined : shortened(line, TITLE_MAX_LENGTH);
}
