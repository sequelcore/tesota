import { type Dirent, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { skipped } from "./projects.js";

/**
 * What the gate verifies in the folder Pi runs in (#384): a Git repository,
 * or a folder that is in none. `folder` is relative to the folder Pi runs in,
 * with forward slashes, and empty for that folder itself.
 */
export interface Unit {
  readonly folder: string;
  readonly repository: boolean;
}

/** Whether `root` is in a Git repository: it or a folder above it holds `.git`, as Git looks for one. */
function inRepository(root: string): boolean {
  for (let at = root; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * The units of the folder Pi runs in, `root`. In a Git repository, the
 * folder alone, as before. Otherwise, when Git repositories sit directly in
 * it, each of them, each other folder in it, and its own files, in name
 * order; folders below a child are not searched. Hidden folders and those
 * that hold dependencies or build output (`skipped`) are left out. A folder
 * with no repository directly in it is one folder in none, whole; one that
 * cannot be read has no unit.
 */
export function workspaceUnits(root: string): Unit[] {
  if (inRepository(root)) return [{ folder: "", repository: true }];
  let entries: Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const visible = entries.filter(({ name }) => !name.startsWith(".")).sort((a, b) => a.name < b.name ? -1 : 1);
  const folders = visible.filter((entry) => entry.isDirectory() && !skipped.has(entry.name))
    .map(({ name }) => ({ folder: name, repository: existsSync(join(root, name, ".git")) }));
  if (!folders.some(({ repository }) => repository)) return [{ folder: "", repository: false }];
  return [...visible.some((entry) => entry.isFile()) ? [{ folder: "", repository: false }] : [], ...folders];
}
