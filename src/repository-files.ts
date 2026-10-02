import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runRepositoryGit } from "./repository-git.js";
import { isTestPath } from "./verification-changes.js";

/** Files read for a proposal: enough for a large repository, never its whole history or its binaries. */
const maxFiles = 5_000;
const maxBytes = 256 * 1024;
const sourceFile = /\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|swift|sh|ps1)$/iu;

/**
 * The repository's tracked source files with their text, for proposals made
 * from what the code says (decision 053): none outside a Git repository, and
 * no text for a file too large to be source or unreadable.
 */
export function repositoryFiles(root: string): readonly Readonly<{ path: string; text: string | undefined; test: boolean }>[] {
  let listed: string;
  try { listed = runRepositoryGit(root, ["ls-files", "-z"]); } catch { return []; }
  return listed.split("\0").filter((path) => path.length > 0).slice(0, maxFiles).map((path) => {
    let text: string | undefined;
    if (sourceFile.test(path)) {
      try { if (statSync(join(root, path)).size <= maxBytes) text = readFileSync(join(root, path), "utf8"); } catch { text = undefined; }
    }
    return { path, text, test: isTestPath(path) };
  });
}
