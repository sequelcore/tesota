import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { runRepositoryGit as git, runRepositoryGitBytes as gitBytes } from "./repository-git.js";
import type { Workspace, WorkspaceChange, WorkspaceSnapshot } from "./workspace.js";
import { isRepositoryPath, isUnchangeableMode } from "./workspace-checkout.js";

/** Nothing was written to the source repository. */
export class ApplyConflictError extends Error {
  readonly paths: readonly string[];
  constructor(message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "ApplyConflictError";
    this.paths = paths;
  }
}

/** Some source writes may have happened; the journal records which. */
export class ApplyUncertainError extends Error {
  readonly applied: readonly string[];
  constructor(applied: readonly string[]) {
    super("Application did not finish; some files may have changed");
    this.name = "ApplyUncertainError";
    this.applied = applied;
  }
}

type LineEnding = "lf" | "crlf";

interface PlannedWrite {
  readonly change: WorkspaceChange;
  readonly target: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  readonly mode: number;
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

function isText(bytes: Buffer): boolean { return !bytes.includes(0); }

function toLf(bytes: Buffer): Buffer { return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1"); }

function toCrlf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"), "latin1");
}

/**
 * Whether the source file still holds the base content. A checkout that converts
 * LF to CRLF (for example with core.autocrlf) still counts as unchanged.
 */
function sourceMatchesBase(source: Buffer, base: Buffer): LineEnding | null {
  if (source.equals(base)) return "lf";
  if (isText(source) && isText(base) && !base.includes("\r\n") && source.includes("\r\n") &&
      toLf(source).equals(base)) return "crlf";
  return null;
}

async function readExisting(path: string): Promise<{ bytes: Buffer; mode: number } | null> {
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ApplyConflictError("Not a regular file", [path]);
  return { bytes: await readFile(path), mode: metadata.mode & 0o777 };
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = dirname(path);
  for (;;) {
    try { return await realpath(current); } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** The Git mode of a path in a tree, or an empty string when the path is absent. */
function treeMode(workspace: Workspace, tree: string, path: string): string {
  return git(workspace.checkout, ["ls-tree", tree, "--", path]).split(" ")[0] ?? "";
}

async function planWrites(workspace: Workspace, snapshot: WorkspaceSnapshot, source: string): Promise<PlannedWrite[]> {
  const planned: PlannedWrite[] = [];
  const conflicts: string[] = [];
  for (const change of snapshot.changes) {
    if (!isRepositoryPath(change.path)) throw new ApplyConflictError("Unsupported path", [change.path]);
    const target = join(source, ...change.path.split("/"));
    if (!contains(source, await nearestExistingParent(target))) throw new ApplyConflictError("Path leaves the repository", [change.path]);
    const existing = await readExisting(target);
    const baseMode = treeMode(workspace, snapshot.base, change.path);
    const newMode = treeMode(workspace, snapshot.tree, change.path);
    if (isUnchangeableMode(baseMode) || isUnchangeableMode(newMode)) {
      throw new ApplyConflictError("Symbolic links and submodules cannot be changed", [change.path]);
    }
    const reviewed = change.status === "deleted" ? null : gitBytes(workspace.checkout, ["cat-file", "blob", `${snapshot.tree}:${change.path}`]);
    const executable = newMode === "100755";
    if (change.status === "added") {
      if (existing !== null) { conflicts.push(change.path); continue; }
      planned.push({ change, target, before: null, after: reviewed, mode: executable ? 0o755 : 0o644 });
      continue;
    }
    const base = gitBytes(workspace.checkout, ["cat-file", "blob", `${snapshot.base}:${change.path}`]);
    const ending = existing === null ? null : sourceMatchesBase(existing.bytes, base);
    if (existing === null || ending === null) { conflicts.push(change.path); continue; }
    const after = reviewed === null ? null : ending === "crlf" && isText(reviewed) && !reviewed.includes("\r") ? toCrlf(reviewed) : reviewed;
    planned.push({ change, target, before: existing.bytes, after, mode: existing.mode });
  }
  if (conflicts.length > 0) throw new ApplyConflictError("These files changed in your repository since the workspace was created", conflicts);
  return planned;
}

async function stillUnchanged(write: PlannedWrite): Promise<boolean> {
  const current = await readExisting(write.target).catch(() => undefined);
  if (current === undefined) return false;
  return write.before === null ? current === null : current !== null && current.bytes.equals(write.before);
}

async function writeFile(write: PlannedWrite, after: Buffer): Promise<void> {
  await mkdir(dirname(write.target), { recursive: true });
  const temporary = join(dirname(write.target), `.tesota-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", write.mode);
  try { await file.writeFile(after); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, write.target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/**
 * Apply exactly the reviewed workspace content to the source repository. A file is
 * written only if the source still holds the content the workspace started from.
 */
export async function applyWorkspace(workspace: Workspace, snapshot: WorkspaceSnapshot): Promise<readonly WorkspaceChange[]> {
  const source = await realpath(workspace.source);
  if (workspace.snapshot().tree !== snapshot.tree || snapshot.base !== workspace.base) {
    throw new ApplyConflictError("The workspace changed after review");
  }
  const planned = await planWrites(workspace, snapshot, source);
  const journal = await open(join(workspace.directory, "applications.jsonl"), "a", 0o600);
  const applied: string[] = [];
  const record = async (entry: object): Promise<void> => {
    await journal.writeFile(JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n");
    await journal.sync();
  };
  try {
    for (const write of planned) {
      if (!(await stillUnchanged(write))) throw new ApplyConflictError("A file changed during application", [write.change.path]);
    }
    await record({ state: "started", base: snapshot.base, tree: snapshot.tree, changes: snapshot.changes });
    try {
      for (const write of planned) {
        if (write.after === null) await unlink(write.target);
        else await writeFile(write, write.after);
        applied.push(write.change.path);
      }
    } catch {
      await record({ state: "incomplete", applied }).catch(() => {});
      throw new ApplyUncertainError(applied);
    }
    await record({ state: "applied", applied });
  } finally { await journal.close(); }
  workspace.settle(snapshot, "Tesota: applied reviewed changes");
  return snapshot.changes;
}
