import { linesThatFit } from "./truncate-rule.ts";

/** Pi's limits for what one tool call returns to the model. */
export const maxLines: number = 2000;
export const maxBytes: number = 50 * 1024;

export interface Kept {
  readonly text: string;
  /** How many whole lines were kept, and how many there were. */
  readonly lines: number;
  readonly total: number;
  readonly truncated: boolean;
}

/** The sizes in UTF-8 bytes of the first i lines together, a newline after each line but the last. */
function sizes(lines: readonly string[]): number[] {
  const result = [0];
  for (const [index, line] of lines.entries()) {
    result.push((result[index] ?? 0) + Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0));
  }
  return result;
}

/** The longest start of `text` within `bytes` UTF-8 bytes that does not split a character. */
function utf8Head(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** The longest end of `text` within `bytes` UTF-8 bytes that does not split a character. */
function utf8Tail(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/** The first lines of `lines` that fit the limits; part of the first line when not even it fits. */
export function keepHead(lines: readonly string[]): Kept {
  const count = linesThatFit(sizes(lines), maxLines, maxBytes);
  if (count === 0 && lines.length > 0) {
    return { text: utf8Head(lines[0] ?? "", maxBytes), lines: 0, total: lines.length, truncated: true };
  }
  return { text: lines.slice(0, count).join("\n"), lines: count, total: lines.length, truncated: count < lines.length };
}

/** The last lines of `lines` that fit the limits; the end of the last line when not even it fits. */
export function keepTail(lines: readonly string[]): Kept {
  const count = linesThatFit(sizes([...lines].reverse()), maxLines, maxBytes);
  if (count === 0 && lines.length > 0) {
    return { text: utf8Tail(lines.at(-1) ?? "", maxBytes), lines: 0, total: lines.length, truncated: true };
  }
  return { text: lines.slice(lines.length - count).join("\n"), lines: count, total: lines.length, truncated: count < lines.length };
}
