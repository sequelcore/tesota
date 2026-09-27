import type { WorkspaceChangeStatus, WorkspaceSnapshot } from "./workspace.js";

/**
 * Candidate line numbers read from a unified diff, as Git writes it for a
 * workspace snapshot or comparison, with any amount of context.
 */

/** What the candidate did to one file, as its diff shows it. */
export interface ChangedFile {
  readonly status: WorkspaceChangeStatus;
  /** Candidate lines the change added, and, where it only removed lines, the lines on each side of the removal. */
  readonly touched: ReadonlySet<number>;
  /** Candidate lines the change added. */
  readonly added: ReadonlySet<number>;
  /** False when the diff shows no lines for this file, such as a binary file or a path Git quoted. */
  readonly readable: boolean;
}

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Walk one diff's lines, reporting each hunk line with the candidate line it
 * shows: its own number for an added or unchanged line, and for a removed
 * line the number the next candidate line will have.
 */
function walk(lines: readonly string[], visit: (line: string, next: number) => void): number {
  let next = 0;
  let hunks = 0;
  for (const line of lines) {
    const header = hunkHeader.exec(line);
    if (header !== null) { next = Number(header[1]); hunks += 1; continue; }
    if (hunks === 0 || line.startsWith("\\")) continue;
    visit(line, next);
    if (!line.startsWith("-")) next += 1;
  }
  return hunks;
}

function readFile(status: WorkspaceChangeStatus, lines: readonly string[]): ChangedFile {
  const touched = new Set<number>();
  const added = new Set<number>();
  let run: "none" | "removed" | "changed" = "none";
  let runEnd = 0;
  // A pure removal leaves nothing added to point at; the lines around the gap are where it shows.
  const endRun = (): void => {
    if (run === "removed") for (const line of [runEnd - 1, runEnd]) if (line >= 1) touched.add(line);
    run = "none";
  };
  const hunks = walk(lines, (line, next) => {
    if (line.startsWith("+")) { run = "changed"; added.add(next); touched.add(next); return; }
    if (line.startsWith("-")) { if (run === "none") run = "removed"; runEnd = next; return; }
    endRun();
  });
  endRun();
  return { status, touched, added, readable: hunks > 0 };
}

function sections(diff: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { current = []; found.set(line, current); continue; }
    current?.push(line);
  }
  return found;
}

/** Each changed file's lines, keyed by path. A file whose section cannot be found or read has no lines. */
export function candidateLines(candidate: Pick<WorkspaceSnapshot, "changes" | "diff">): ReadonlyMap<string, ChangedFile> {
  const bySection = sections(candidate.diff);
  return new Map(candidate.changes.map((change) =>
    [change.path, readFile(change.status, bySection.get(`diff --git a/${change.path} b/${change.path}`) ?? [])]));
}

/**
 * The diff with each added and unchanged hunk line prefixed by its line
 * number in the candidate, so a model need not count from hunk headers.
 */
export function numberedDiff(diff: string): string {
  const out: string[] = [];
  let next = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; out.push(line); continue; }
    const header = hunkHeader.exec(line);
    if (header !== null) { next = Number(header[1]); inHunk = true; out.push(line); continue; }
    if (!inHunk || line.startsWith("\\") || line.length === 0) { out.push(line); continue; }
    if (line.startsWith("-")) { out.push(`${" ".repeat(6)}${line}`); continue; }
    out.push(`${String(next).padStart(5)} ${line}`);
    next += 1;
  }
  return out.join("\n");
}
