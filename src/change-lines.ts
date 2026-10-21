import { readFile } from "node:fs/promises";
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
 * lines, and apart the files Git counts no lines for, such as images
 * (`binary`). A summary of the diff, never a measure of risk or of what was
 * verified.
 */
export interface ChangeLines {
  readonly implementation: LineCount;
  readonly tests: LineCount;
  readonly other: LineCount;
  readonly binary: readonly string[];
}

/** The lines in `content` as Git counts them: none when empty, and a last line without a newline still counts. */
function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
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
 * The lines of `changed`, the files a request changed relative to `root`,
 * by category (`changeCategory`): as `git diff --numstat` counts them against
 * `base`, and a file the base lacks, untracked or before the first commit,
 * counted as added whole; a file with a NUL byte, or one Git calls binary,
 * goes to `binary`. `unreadable` when Git cannot show the change.
 */
export async function changeLines(root: string, base: string | null, changed: readonly string[]): Promise<ChangeLines | "unreadable"> {
  const numstat = base === null ? "" : await gitOutput(root, ["-c", "core.quotePath=false", "diff", "--numstat", "-z", "--no-renames",
    "--no-ext-diff", "--no-textconv", "--relative", base]);
  if (numstat === undefined || numstat === "too_large") return "unreadable";
  const counted = new Map<string, LineCount | "binary">();
  for (const record of numstat.split("\0")) {
    const [added, removed, path] = record.split("\t");
    if (path === undefined) continue;
    counted.set(path, added === "-" ? "binary" : { added: Number(added), removed: Number(removed) });
  }
  const wanted = [...new Set(changed)];
  const generated = await generatedPaths(root, wanted);
  const totals: Record<ChangeCategory, { added: number; removed: number }> = {
    implementation: { added: 0, removed: 0 }, tests: { added: 0, removed: 0 }, other: { added: 0, removed: 0 } };
  const binary: string[] = [];
  for (const path of wanted.sort()) {
    let count = counted.get(path);
    if (count === undefined) {
      const content = await readFile(join(root, path), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      count = content.includes("\0") ? "binary" : { added: lineCount(content), removed: 0 };
    }
    if (count === "binary") { binary.push(path); continue; }
    const total = totals[changeCategory(isTestPath(path), generated.has(path), isSourcePath(path))];
    total.added += count.added;
    total.removed += count.removed;
  }
  return { ...totals, binary };
}
