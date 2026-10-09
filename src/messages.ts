import type { ExtensionAPI, MessageRenderOptions, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, type Component, sliceByColumn, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";

/** Where a receipt line's text starts, after its two-space margin and fourteen-column label. */
const RECEIPT_TEXT_COLUMN = 16;
/** The digits of a content hash the terminal shows; the stored receipt keeps all 64. */
const SHOWN_HASH_DIGITS = 12;

/** `line` broken at spaces into rows of `width` columns, every row after the first indented by `indent` columns. */
export function hang(line: string, width: number, indent: number): string[] {
  const rows: string[] = [];
  let rest = line;
  let lead = "";
  while (visibleWidth(lead + rest) > width) {
    const room = Math.max(1, width - visibleWidth(lead));
    const head = sliceByColumn(rest, 0, room + 1);
    const space = head.lastIndexOf(" ");
    // A word longer than the row, such as a hash or a path, is cut at the row's end.
    const cut = space > 0 ? space : sliceByColumn(rest, 0, room).length;
    rows.push(lead + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    lead = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
  }
  rows.push(lead + rest);
  return rows;
}

/** Message text whose long lines wrap under their own text: by the line's indent, or at `column` when it is given. */
class HangingText implements Component {
  readonly #lines: readonly string[];
  readonly #style: (line: string) => string;
  readonly #column: number | undefined;

  constructor(lines: readonly string[], style: (line: string) => string, column?: number) {
    this.#lines = lines;
    this.#style = style;
    this.#column = column;
  }

  render(width: number): string[] {
    return this.#lines.flatMap((line) => {
      const indent = this.#column ?? line.length - line.trimStart().length;
      return hang(line, width, indent).map(this.#style);
    });
  }

  invalidate(): void {}
}

function card(theme: Theme, options: MessageRenderOptions, title: string, body: Component): Component {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(title, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(body);
  return box;
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function text(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");
}

/** A receipt label's color: what holds in the success color, what does not in the error color, what is open in gold. */
function labelColor(label: string): ThemeColor {
  if (/^(?:proved|passed|exercises|contract)$/u.test(label)) return "success";
  if (label.startsWith("NOT ")) return "error";
  if (label === "model judged" || label === "not judged") return "accent";
  if (label === "no code") return "muted";
  return label === "" ? "customMessageText" : "warning";
}

/** A content hash cut to its first digits, for the terminal. */
export function shortHash(line: string): string {
  return line.replace(/(content sha256 )([0-9a-f]{64})/u, (_all, prefix: string, hash: string) =>
    `${prefix}${hash.slice(0, SHOWN_HASH_DIGITS)}…`);
}

/** One row of the receipt with its label colored. */
function receiptRow(theme: Theme, row: string): string {
  return theme.fg(labelColor(row.slice(0, RECEIPT_TEXT_COLUMN).trim()), row.slice(0, RECEIPT_TEXT_COLUMN)) +
    theme.fg("customMessageText", row.slice(RECEIPT_TEXT_COLUMN));
}

/**
 * How Tesota's session messages look: what the gate sends back to the agent
 * and the receipt it settles with, each under a styled title instead of Pi's
 * raw `[customType]` label, wrapping with a hanging indent. The receipt shows
 * a content hash's first digits; the entry keeps the whole hash.
 */
export function registerMessages(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("tesota-gate", (message, options, theme) => card(theme, options,
    `${theme.fg("customMessageLabel", bold("Tesota"))}${theme.fg("muted", " · sent back to the agent")}`,
    new HangingText(text(message.content).split("\n"), (line) => theme.fg("customMessageText", line))));
  pi.registerMessageRenderer("tesota-receipt", (message, options, theme) => {
    const [, ...lines] = text(message.content).split("\n");
    return card(theme, options, theme.fg("customMessageLabel", bold("Tesota receipt")),
      new HangingText(lines.map(shortHash), (row) => receiptRow(theme, row), RECEIPT_TEXT_COLUMN));
  });
}
