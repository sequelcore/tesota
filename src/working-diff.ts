import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoRepositoryGitPrograms, isGitObjectId, operatorLineEndingSetting, runRepositoryGit,
  type RepositoryGitEnvironment } from "./repository-git.js";
import { isGitRepository } from "./source-shadow.js";

/**
 * Everything uncommitted in the operator's repository as a unified diff, as
 * `git diff HEAD` shows it with untracked files added: the Diff tab's working
 * tree source, as Claude Code's `/diff` shows the current changes.
 *
 * It reads and never writes the repository: the working tree is staged into a
 * temporary index whose new objects go to a temporary directory, borrowing
 * the repository's own, and both are removed after. Repository-local Git
 * programs are refused before any file's bytes are read, as every snapshot
 * Tesota takes refuses them, and Git runs without hooks or ambient config.
 * Undefined when there is no repository, as `isGitRepository` judges one from `home`, or Git cannot read it.
 */
export function workingTreeDiff(cwd: string, home?: string): string | undefined {
  // As Tesota judges a repository everywhere: one at a drive's root or the home folder is not the operator's project.
  if (!isGitRepository(resolve(cwd), home)) return undefined;
  let state: string | undefined;
  try {
    // From the top level, so the whole repository is read even when Tesota starts in one of its folders.
    const source = resolve(runRepositoryGit(resolve(cwd), ["rev-parse", "--show-toplevel"]).trim());
    const objects = resolve(source, runRepositoryGit(source, ["rev-parse", "--git-path", "objects"]).trim());
    if (!isAbsolute(objects)) return undefined;
    state = mkdtempSync(join(tmpdir(), "tesota-working-diff-"));
    mkdirSync(join(state, "objects"));
    const env: RepositoryGitEnvironment = { GIT_INDEX_FILE: join(state, "index"), GIT_OBJECT_DIRECTORY: join(state, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    assertNoRepositoryGitPrograms(source, env);
    let head: string | undefined;
    try { head = runRepositoryGit(source, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], env).trim(); } catch { head = undefined; }
    // With no commit yet, the base is the empty tree, written from the still-empty index into the temporary objects.
    if (head === undefined) head = runRepositoryGit(source, ["write-tree"], env).trim();
    else runRepositoryGit(source, ["read-tree", "HEAD"], env);
    if (!isGitObjectId(head)) return undefined;
    // As a snapshot reads it: HEAD's entries first, so tracked files ignore rules would skip stay, then every file.
    runRepositoryGit(source, ["-c", `core.autocrlf=${operatorLineEndingSetting(source)}`, "add", "--all", "--", "."], env);
    const tree = runRepositoryGit(source, ["write-tree"], env).trim();
    if (!isGitObjectId(tree)) return undefined;
    return runRepositoryGit(source, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", head, tree, "--"], env);
  } catch {
    return undefined;
  } finally {
    if (state !== undefined) rmSync(state, { recursive: true, force: true });
  }
}
