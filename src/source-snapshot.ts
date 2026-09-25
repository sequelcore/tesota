import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoRepositoryGitPrograms, operatorLineEndingSetting, runRepositoryGit as git,
  runRepositoryGitBytes as gitBytes, type RepositoryGitEnvironment } from "./repository-git.js";

/** One file that differs between the source's working tree and its HEAD commit. */
export interface UncommittedChange {
  readonly status: "added" | "modified" | "deleted";
  readonly path: string;
  readonly executable: boolean;
  /** Content as Git would commit it; null for a deletion. */
  readonly content: Buffer | null;
}

const statusNames: Readonly<Record<string, UncommittedChange["status"]>> = { A: "added", M: "modified", D: "deleted" };

function parseRawDiff(value: string): { status: UncommittedChange["status"]; path: string; mode: string; blob: string }[] {
  const fields = value.split("\0");
  fields.pop();
  const entries: { status: UncommittedChange["status"]; path: string; mode: string; blob: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]?.split(" ");
    const path = fields[index + 1];
    const status = statusNames[header?.[4] ?? ""];
    const mode = header?.[1];
    const blob = header?.[3];
    if (header?.length !== 5 || path === undefined || status === undefined || mode === undefined || blob === undefined) {
      throw new Error("Unsupported uncommitted change");
    }
    entries.push({ status, path, mode, blob });
  }
  return entries;
}

/**
 * Capture tracked modifications, deletions and untracked files that are not
 * ignored, relative to `baseline`, as `git status` shows them. A temporary index and object directory
 * keep the source repository's index, refs and object store untouched.
 */
export async function captureUncommittedChanges(source: string, baseline: string,
  scratch: string): Promise<readonly UncommittedChange[]> {
  assertNoRepositoryGitPrograms(source);
  const objects = join(scratch, "objects");
  await mkdir(objects, { recursive: true });
  try {
    const sourceObjects = resolve(source, git(source, ["rev-parse", "--git-path", "objects"]).trim());
    if (!isAbsolute(sourceObjects)) throw new Error("Invalid source object directory");
    const env: RepositoryGitEnvironment = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects };
    const lineEndings = ["-c", `core.autocrlf=${operatorLineEndingSetting(source)}`];
    git(source, ["read-tree", baseline], env);
    git(source, [...lineEndings, "add", "--all", "--", "."], env);
    const entries = parseRawDiff(git(source, ["diff-index", "--cached", "--raw", "-z", "--no-renames", baseline, "--"], env));
    return entries.map((entry) => {
      if (entry.status !== "deleted" && entry.mode !== "100644" && entry.mode !== "100755") {
        throw new Error(`Uncommitted symbolic links and submodules are unsupported: ${entry.path}`);
      }
      return { status: entry.status, path: entry.path, executable: entry.mode === "100755",
        content: entry.status === "deleted" ? null : gitBytes(source, ["cat-file", "blob", entry.blob], env) };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
