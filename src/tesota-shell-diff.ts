import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bold, colorText, mutedText, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { safeTerminalText } from "./tesota-shell-transcript.js";

/**
 * A candidate's diff in the result panel, drawn as a diff view: a summary of
 * the files with their added and removed counts, then each file's changes with
 * line numbers, added and removed rows tinted across the panel, and code
 * highlighted by language. It reads git's unified diff as the workspace
 * produces it (`--no-renames`, without binary patches).
 */

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The line's number before the change; absent for an added line. */
  readonly oldLine?: number;
  /** The line's number after the change; absent for a removed line. */
  readonly newLine?: number;
  readonly text: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export interface DiffFile {
  readonly path: string;
  readonly status: "added" | "deleted" | "modified";
  readonly binary: boolean;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
}

/** A path as git writes it: bare, or quoted with C escapes and octal bytes when it has unusual characters. */
function gitPath(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  const bytes: number[] = [];
  const escapes: Readonly<Record<string, number>> = { n: 10, t: 9, r: 13, "\"": 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? "";
    if (char !== "\\") { bytes.push(...Buffer.from(char)); continue; }
    const octal = /^[0-7]{3}/u.exec(body.slice(index + 1));
    if (octal !== null) { bytes.push(Number.parseInt(octal[0], 8)); index += 3; continue; }
    const next = body[index + 1] ?? "";
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `a/path` or `b/path` from a `---` or `+++` line; undefined for `/dev/null`. */
function sidePath(value: string): string | undefined {
  const path = gitPath(value.trim());
  return path === "/dev/null" ? undefined : path.replace(/^[ab]\//u, "");
}

interface FileDraft {
  path: string;
  status: DiffFile["status"];
  binary: boolean;
  added: number;
  removed: number;
  hunks: { header: string; lines: DiffLine[] }[];
}

function fileHeaderPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  // Unquoted paths repeat as `a/<path> b/<path>`; the second half names the file.
  if (rest.startsWith("\"")) return sidePath(rest.slice(rest.indexOf("\" \"") + 2)) ?? rest;
  return rest.slice(rest.length / 2 + 1).replace(/^b\//u, "");
}

/** The files of a unified diff, with each line's old and new numbers. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: FileDraft[] = [];
  let file: FileDraft | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: fileHeaderPath(line), status: "modified", binary: false, added: 0, removed: 0, hunks: [] };
      files.push(file);
      continue;
    }
    if (file === undefined) continue;
    const hunk = file.hunks.at(-1);
    if (hunk === undefined) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("Binary files ")) file.binary = true;
      else if (line.startsWith("--- ")) file.path = sidePath(line.slice(4)) ?? file.path;
      else if (line.startsWith("+++ ")) file.path = sidePath(line.slice(4)) ?? file.path;
    }
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (range !== null) {
      oldLine = Number(range[1]);
      newLine = Number(range[2]);
      file.hunks.push({ header: line, lines: [] });
      continue;
    }
    if (hunk === undefined) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "added", newLine: newLine++, text: line.slice(1) });
      file.added += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "removed", oldLine: oldLine++, text: line.slice(1) });
      file.removed += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return files;
}

/** Re-apply a background after every reset inside `line`, so highlighted code keeps its row's tint. */
function tinted(line: string, width: number, color: string | null): string {
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  if (color === null) return padded;
  const start = `\x1b[48;2;${[1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16)).join(";")}m`;
  return `${start}${padded.replaceAll("\x1b[0m", `\x1b[0m${start}`).replaceAll("\x1b[49m", start)}\x1b[49m`;
}

function counts(added: number, removed: number, theme: TesotaShellTheme): string {
  return `${colorText(`+${added}`, theme.success)} ${colorText(`-${removed}`, theme.error)}`;
}

export class DiffView implements Component {
  readonly #theme: TesotaShellTheme;
  #files: readonly DiffFile[] = [];
  /** The lines last drawn and their width: highlighting a large diff on every frame would slow the whole shell. */
  #cached: { width: number; lines: string[] } | undefined;
  constructor(theme: TesotaShellTheme) { this.#theme = theme; }
  /** File contents and names can hold terminal control sequences; they are made inert before anything is drawn. */
  setDiff(diff: string | undefined): void {
    this.#files = diff === undefined ? [] : parseUnifiedDiff(safeTerminalText(diff));
    this.#cached = undefined;
  }
  invalidate(): void { this.#cached = undefined; }

  render(width: number): string[] {
    if (this.#cached?.width === width) return this.#cached.lines;
    const lines = this.#lines(width);
    this.#cached = { width, lines };
    return lines;
  }

  #lines(width: number): string[] {
    if (this.#files.length === 0 || width < 20) return [];
    const theme = this.#theme;
    const added = this.#files.reduce((sum, file) => sum + file.added, 0);
    const removed = this.#files.reduce((sum, file) => sum + file.removed, 0);
    const lines = [` ${bold(`${this.#files.length} ${this.#files.length === 1 ? "file" : "files"} changed`)} ` +
      counts(added, removed, theme)];
    for (const file of this.#files) {
      const count = file.binary ? mutedText("binary", theme) : counts(file.added, file.removed, theme);
      const room = Math.max(1, width - 3 - visibleWidth(count));
      const path = file.path.length > room ? `…${file.path.slice(file.path.length - room + 1)}` : file.path;
      lines.push(` ${mutedText(path, theme)}${" ".repeat(Math.max(1, width - 2 - visibleWidth(path) - visibleWidth(count)))}${count}`);
    }
    for (const file of this.#files) lines.push("", ...this.#renderFile(file, width));
    return lines;
  }

  #renderFile(file: DiffFile, width: number): string[] {
    const theme = this.#theme;
    const status = file.status === "modified" ? "" : mutedText(` (${file.status})`, theme);
    // Each file is a block between rules, its name on a row of its own, so files stay apart in a long diff.
    const rule = mutedText("─".repeat(width), theme);
    const lines = [rule, ` ${bold(file.path)}${status}`, rule];
    if (file.binary) return [...lines, mutedText("   Binary file, not shown.", theme)];
    const numbers = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.newLine ?? line.oldLine ?? 0));
    const digits = String(Math.max(1, ...numbers)).length;
    const language = theme.accent === null ? undefined : getLanguageFromPath(file.path);
    for (const [index, hunk] of file.hunks.entries()) {
      if (index > 0) lines.push(mutedText(` ${"".padStart(digits)} ⋯`, theme));
      for (const line of hunk.lines) lines.push(...this.#renderLine(line, digits, language, width));
    }
    return lines;
  }

  #renderLine(line: DiffLine, digits: number, language: string | undefined, width: number): string[] {
    const theme = this.#theme;
    const sign = line.kind === "added" ? colorText("+", theme.success) : line.kind === "removed" ? colorText("-", theme.error) : " ";
    const number = String(line.newLine ?? line.oldLine ?? "").padStart(digits);
    const gutter = ` ${line.kind === "context" ? mutedText(number, theme) : number} ${sign} `;
    const gutterWidth = digits + 4;
    const code = line.text.replaceAll("\t", "  ");
    const highlighted = language === undefined ? code : highlightCode(code, language).join("");
    const rows = wrapTextWithAnsi(highlighted, Math.max(1, width - gutterWidth));
    const background = line.kind === "added" ? theme.addedBackground : line.kind === "removed" ? theme.removedBackground : null;
    return rows.map((row, index) => tinted(`${index === 0 ? gutter : " ".repeat(gutterWidth)}${row}`, width, background));
  }
}
