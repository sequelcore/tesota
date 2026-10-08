/**
 * The lines a unified diff, as Git writes it with any amount of context,
 * adds and removes in each file.
 */

export type ChangeStatus = "added" | "modified" | "deleted";

/** What a change did to one file, as its diff shows it. */
export interface ChangedFile {
  readonly path: string;
  readonly status: ChangeStatus;
  /** The lines the change added, without the diff's marker. */
  readonly added: readonly string[];
  /** The lines the change removed, without the diff's marker. */
  readonly removed: readonly string[];
}

const hunkHeader = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u;

function readFile(path: string, status: ChangeStatus, lines: readonly string[]): ChangedFile {
  const added: string[] = [];
  const removed: string[] = [];
  let hunks = 0;
  for (const line of lines) {
    if (hunkHeader.test(line)) { hunks += 1; continue; }
    // Before the first hunk come the file's headers; `\` marks a missing newline at the end of a file.
    if (hunks === 0) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { path, status, added, removed };
}

function sections(diff: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) { current = []; found.set(line, current); continue; }
    current?.push(line);
  }
  return found;
}

/**
 * Each change's lines, read from `diff`, written with Git's `a/` and `b/`
 * prefixes. A file whose section cannot be found or shows no lines, such as
 * a binary file or a path Git quoted, has none.
 */
export function changedLines(diff: string, changes: readonly Pick<ChangedFile, "path" | "status">[]): ChangedFile[] {
  const bySection = sections(diff);
  return changes.map(({ path, status }) =>
    readFile(path, status, bySection.get(`diff --git a/${path} b/${path}`) ?? []));
}
