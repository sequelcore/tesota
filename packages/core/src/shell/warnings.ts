import { type Component, type Focusable, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminalText } from "../../../../src/terminal-text.ts";
import type { ShellTheme } from "../../../../src/theme.ts";

/** A shell diagnostic identified independently of its current wording. */
export interface WarningEntry {
  readonly id: string;
  readonly details: string;
}

/** Use the footer's existing space; warning delivery never adds a row. */
export function withWarningNotice(lines: readonly string[], count: number, width: number, theme: ShellTheme): string[] {
  if (count === 0 || lines.length === 0) return [...lines];
  const budget = Math.max(0, width - 2);
  const choices = [`⚠ ${count} warning${count === 1 ? "" : "s"} · F2 to view`, `⚠ ${count} · F2`, `⚠ ${count}`];
  const notice = truncateToWidth(choices.find((text) => visibleWidth(text) <= budget) ?? choices[2] ?? "", budget, "");
  const row = lines.length > 1 && visibleWidth(lines[0] ?? "") === 0 ? 0 : lines.length - 1;
  const left = truncateToWidth(lines[row] ?? "", Math.max(0, budget - visibleWidth(notice) - 1), "");
  const fitted = left + " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(notice) - 1)) + theme.fg("warning", notice);
  return lines.map((line, index) => index === row ? truncateToWidth(fitted, width, "") : line);
}

interface WarningsOptions {
  readonly entries: WarningEntry[];
  readonly theme: ShellTheme;
  readonly rows: () => number;
  readonly dismiss: (entry: WarningEntry) => void;
  readonly copy: (text: string) => Promise<boolean>;
  readonly redraw: () => void;
  readonly close: () => void;
  readonly disposed: () => void;
}

/** Read retained diagnostics without giving keys to the draft or the running agent. */
export class WarningsView implements Component, Focusable {
  focused = false;
  private index = 0;
  private offset = 0;
  private maxOffset = 0;
  private feedback = "";
  private readonly options: WarningsOptions;

  constructor(options: WarningsOptions) { this.options = options; }

  render(width: number): string[] {
    const { entries, theme } = this.options;
    const entry = entries[this.index];
    const body = new Text(entry === undefined ? "No warnings in this session." : terminalText(entry.details), 1, 0).render(width);
    const height = Math.max(1, this.options.rows() - 4);
    this.maxOffset = Math.max(0, body.length - height);
    this.offset = Math.min(this.offset, this.maxOffset);
    const title = entry === undefined ? "Warnings" : `Warnings · ${this.index + 1} of ${entries.length}`;
    return [theme.bold(theme.fg("warning", title)), "", ...body.slice(this.offset, this.offset + height), "",
      theme.fg("dim", this.feedback || "Esc back · d dismiss · c copy · ←→ choose · ↑↓ scroll")]
      .map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "f2") || matchesKey(data, "ctrl+c")) { this.options.close(); return; }
    const entry = this.options.entries[this.index];
    if (data === "d" && entry !== undefined) {
      this.options.dismiss(entry);
      this.options.entries.splice(this.index, 1);
      this.index = Math.min(this.index, Math.max(0, this.options.entries.length - 1));
      this.offset = 0;
      if (this.options.entries.length === 0) this.options.close();
    } else if (data === "c" && entry !== undefined) {
      void this.options.copy(entry.details).then((copied) => {
        this.feedback = copied ? "Copied warning" : "Copy not confirmed";
        this.options.redraw();
      }, () => { this.feedback = "Copy not confirmed"; this.options.redraw(); });
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.index = Math.max(0, Math.min(this.options.entries.length - 1, this.index + (matchesKey(data, "left") ? -1 : 1)));
      this.offset = 0;
      this.feedback = "";
    } else if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset = Math.min(this.maxOffset, this.offset + 1);
  }

  invalidate(): void {}
  dispose(): void { this.options.disposed(); }
}
