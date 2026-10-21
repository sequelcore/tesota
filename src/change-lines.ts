import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { gitOutput } from "./git.js";
import { isSourcePath, isTestPath } from "./verification-changes.js";
import { type ChangeCategory, changeCategory } from "./verification/change-category-rule.js";

/** Lines added and removed. */
export interface LineCount {
  readonly added: number;
  readonly removed: number;
}

/**
 * A request's change in lines by where they are (#527): each category's text
 * lines; apart, the files Git counts no lines for, such as images
 * (`binary`); and the files the repository marks as generated, whatever
 * category they count in (`generated`). A summary of the diff, never a
 * measure of risk or of what was verified.
 */
export interface ChangeLines {
  readonly implementation: LineCount;
  readonly tests: LineCount;
  readonly other: LineCount;
  readonly binary: readonly string[];
  readonly generated: readonly string[];
}

/** The lines in `content` as Git counts them: none when empty, and a last line without a newline still counts. */
function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/**
 * `git diff --numstat -z --no-renames` read by path: each record is the
 * added and removed counts, `-` for a binary file, then the path, which may
 * itself hold tabs.
 */
export function numstatRecords(output: string): Map<string, LineCount | "binary"> {
  const counted = new Map<string, LineCount | "binary">();
  for (const record of output.split("\0")) {
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    counted.set(record.slice(second + 1), added === "-" ? "binary"
      : { added: Number(added), removed: Number(record.slice(first + 1, second)) });
  }
  return counted;
}

/** The paths of `paths` the repository marks as generated (`linguist-generated` in `.gitattributes`); none when Git cannot tell. */
async function generatedPaths(root: string, paths: readonly string[]): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const output = await gitOutput(root, ["check-attr", "-z", "--stdin", "linguist-generated"], `${paths.join("\0")}\0`);
  if (output === undefined || output === "too_large") return new Set();
  const fields = output.split("\0");
  const generated = new Set<string>();
  for (let k = 0; k + 2 < fields.length; k += 3) {
    if (fields[k + 2] === "set" || fields[k + 2] === "true") generated.add(fields[k] ?? "");
  }
  return generated;
}

/**
 * An untracked file's lines, all added, as Git would count them: a symbolic
 * link as the one line of its target's name, a file with a NUL byte as
 * binary; none when it is gone, and `unreadable` when it cannot be read.
 */
async function untrackedLines(path: string): Promise<LineCount | "binary" | "gone" | "unreadable"> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return { added: lineCount(await readlink(path)), removed: 0 };
    const content = await readFile(path, "utf8");
    return content.includes("\0") ? "binary" : { added: lineCount(content), removed: 0 };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unreadable";
  }
}

/**
 * The lines of `changed`, the files a request changed relative to `root`,
 * by category (`changeCategory`): as `git diff --numstat` counts them against
 * `base`; an untracked file, or any file before the first commit, counted as
 * added whole; a file Git calls binary, or an untracked one with a NUL byte,
 * goes to `binary`. A changed file Git finds no different from the base,
 * such as one the request restored, counts nothing. `unreadable` when Git
 * cannot show the change or a file cannot be read.
 */
export async function changeLines(root: string, base: string | null, changed: readonly string[]): Promise<ChangeLines | "unreadable"> {
  const numstat = base === null ? "" : await gitOutput(root, ["-c", "core.quotePath=false", "diff", "--numstat", "-z", "--no-renames",
    "--no-ext-diff", "--no-textconv", "--relative", base]);
  const untracked = base === null ? "" : await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (numstat === undefined || numstat === "too_large" || untracked === undefined || untracked === "too_large") return "unreadable";
  const counted = numstatRecords(numstat);
  const fresh = new Set(untracked.split("\0"));
  const wanted = [...new Set(changed)].sort();
  const generated = await generatedPaths(root, wanted);
  const totals: Record<ChangeCategory, { added: number; removed: number }> = {
    implementation: { added: 0, removed: 0 }, tests: { added: 0, removed: 0 }, other: { added: 0, removed: 0 } };
  const binary: string[] = [];
  for (const path of wanted) {
    let count = counted.get(path);
    if (count === undefined) {
      // Before the first commit every file is new; after it, one Git lists in neither is as the base has it, when the
      // base has it: a new file the request then ignored is in neither, and still counts whole.
      if (base !== null && !fresh.has(path) && (await gitOutput(root, ["cat-file", "-t", `${base}:./${path}`]))?.trim() === "blob") continue;
      const read = await untrackedLines(join(root, path));
      if (read === "unreadable") return "unreadable";
      if (read === "gone") continue;
      count = read;
    }
    if (count === "binary") { binary.push(path); continue; }
    const total = totals[changeCategory(isTestPath(path), generated.has(path), isSourcePath(path))];
    total.added += count.added;
    total.removed += count.removed;
  }
  return { ...totals, binary, generated: wanted.filter((path) => generated.has(path)) };
}
