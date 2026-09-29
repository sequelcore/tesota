import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertNoRepositoryGitPrograms, isGitObjectId, operatorLineEndingSetting, runRepositoryGit as git,
  runRepositoryGitBytes as gitBytes, type RepositoryGitEnvironment } from "./repository-git.js";
import { refreshShadow, shadowEnvironment } from "./source-shadow.js";

/** One file that differs between two captured states of the source. */
export interface SourceChange {
  readonly status: "added" | "modified" | "deleted";
  readonly path: string;
  readonly executable: boolean;
  /** Content as Git would commit it; null for a deletion. */
  readonly content: Buffer | null;
}

/** A source change Tesota cannot carry into a workspace, such as a new symbolic link. */
export class UnsupportedSourceChange extends Error {
  constructor(path: string) {
    super(`Changed symbolic links and submodules cannot be copied into a workspace: ${path}`);
    this.name = "UnsupportedSourceChange";
  }
}

const statusNames: Readonly<Record<string, SourceChange["status"]>> = { A: "added", M: "modified", D: "deleted" };

function parseRawDiff(value: string): { status: SourceChange["status"]; path: string; mode: string; blob: string }[] {
  const fields = value.split("\0");
  fields.pop();
  const entries: { status: SourceChange["status"]; path: string; mode: string; blob: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]?.split(" ");
    const path = fields[index + 1];
    const status = statusNames[header?.[4] ?? ""];
    const mode = header?.[1];
    const blob = header?.[3];
    if (header?.length !== 5 || path === undefined || mode === undefined || blob === undefined) {
      throw new Error("Invalid Git change report");
    }
    if (status === undefined) throw new UnsupportedSourceChange(path);
    entries.push({ status, path, mode, blob });
  }
  return entries;
}

/**
 * What the source's working tree holds, as `git status` sees it: tracked
 * changes, deletions and untracked files that are not ignored, all read
 * through the source's shadow repository. A private index and object
 * directory keep the shadow's own index untouched; they persist so Git's stat
 * cache makes later captures cheap.
 */
export class SourceSnapshot {
  readonly #source: string;
  readonly #shadow: string;
  readonly #state: string;
  readonly #env: RepositoryGitEnvironment;

  private constructor(source: string, shadow: string, state: string, env: RepositoryGitEnvironment) {
    this.#source = source;
    this.#shadow = shadow;
    this.#state = state;
    this.#env = env;
  }

  /**
   * `objects` says where captured trees are written: a private directory in
   * the state directory, borrowing the shadow's objects, for a workspace; the
   * shadow itself for a session working in the source, whose turns' trees
   * the shadow keeps.
   */
  static async open(source: string, stateDirectory: string, shadow: string, objects: "private" | "shadow" = "private"):
    Promise<SourceSnapshot> {
    await mkdir(stateDirectory, { recursive: true });
    const view = shadowEnvironment(source, shadow);
    const index = { ...view, GIT_INDEX_FILE: join(stateDirectory, "index") };
    if (objects === "shadow") return new SourceSnapshot(source, shadow, stateDirectory, index);
    const own = join(stateDirectory, "objects");
    await mkdir(own, { recursive: true });
    const shadowObjects = resolve(source, git(source, ["rev-parse", "--git-path", "objects"], view).trim());
    if (!isAbsolute(shadowObjects)) throw new Error("Invalid source object directory");
    return new SourceSnapshot(source, shadow, stateDirectory, { ...index, GIT_OBJECT_DIRECTORY: own,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: shadowObjects });
  }

  /** Capture the working tree now and return its Git tree id. */
  capture(): string {
    refreshShadow(this.#source, this.#shadow);
    assertNoRepositoryGitPrograms(this.#source, shadowEnvironment(this.#source, this.#shadow));
    // Reading HEAD keeps tracked files that ignore rules would otherwise skip, and a
    // repository's symbolic links where Git keeps them as plain files.
    // --reset reuses stat information for unchanged entries and, without -u,
    // never touches the working tree.
    git(this.#source, ["read-tree", ...(existsSync(join(this.#state, "index")) ? ["--reset"] : []), "HEAD"], this.#env);
    git(this.#source, ["-c", `core.autocrlf=${operatorLineEndingSetting(this.#source)}`, "add", "--all", "--", "."], this.#env);
    const tree = git(this.#source, ["write-tree"], this.#env).trim();
    if (!isGitObjectId(tree)) throw new Error("Invalid source tree");
    return tree;
  }

  /** Files that differ between two captured trees or commits, with their new content. */
  changes(from: string, to: string): readonly SourceChange[] {
    const entries = parseRawDiff(git(this.#source, ["diff-tree", "-r", "-z", "--raw", "--no-renames", from, to, "--"], this.#env));
    return entries.map((entry) => {
      if (entry.status !== "deleted" && entry.mode !== "100644" && entry.mode !== "100755") {
        throw new UnsupportedSourceChange(entry.path);
      }
      return { status: entry.status, path: entry.path, executable: entry.mode === "100755",
        content: entry.status === "deleted" ? null : gitBytes(this.#source, ["cat-file", "blob", entry.blob], this.#env) };
    });
  }

  /** The tree the workspace last took from the source, or null before the first record. */
  async recorded(): Promise<string | null> {
    try {
      const tree = (await readFile(join(this.#state, "tree"), "utf8")).trim();
      return isGitObjectId(tree) ? tree : null;
    } catch { return null; }
  }

  async record(tree: string): Promise<void> {
    if (!isGitObjectId(tree)) throw new Error("Invalid source tree");
    await writeFile(join(this.#state, "tree"), `${tree}\n`, { mode: 0o600 });
  }
}
