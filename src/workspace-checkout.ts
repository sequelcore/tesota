import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { DEFAULT_FOLDERS_ROOT, isGitRepository, openFolder } from "./folder-source.js";
import { isGitObjectId, runRepositoryGit as git } from "./repository-git.js";
import { SourceSnapshot, UnsupportedSourceChange, type SourceChange } from "./source-snapshot.js";

const checkoutRecordSchema = z.strictObject({
  format: z.literal("tesota-workspace-checkout"),
  version: z.literal(1),
  source: z.string().refine(isAbsolute),
  baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  state: z.enum(["preparing", "ready", "failed"]),
  /** A folder's private repository when the source is a plain folder (decision 032). */
  tracking: z.string().refine(isAbsolute).optional(),
});
type CheckoutRecord = z.infer<typeof checkoutRecordSchema>;

/** A verified, independent clone and the repository it came from. */
export interface WorkspaceCheckout {
  readonly directory: string;
  readonly checkout: string;
  readonly source: string;
  readonly baseline: string;
  readonly head: string;
  /** Uncommitted source changes the workspace started with, committed on top of the baseline. */
  readonly included: readonly { readonly status: SourceChange["status"]; readonly path: string }[];
  /** A folder's private repository when the source is a plain folder (decision 032); absent for a repository. */
  readonly tracking?: string;
}

export const DEFAULT_WORKSPACES_ROOT: string = join(homedir(), ".tesota", "workspaces");

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function plainDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(absolute, actual) !== "") {
    throw new Error("Workspace directory redirected");
  }
  return actual;
}

async function saveRecord(directory: string, record: CheckoutRecord): Promise<void> {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(directory, "checkout.json"));
}

async function readRecord(directory: string): Promise<CheckoutRecord> {
  const path = join(directory, "checkout.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error("Invalid workspace record");
  const file = await open(path, "r");
  try {
    const parsed = checkoutRecordSchema.safeParse(JSON.parse(await file.readFile("utf8")));
    if (!parsed.success) throw new Error("Invalid workspace record");
    return parsed.data;
  } finally { await file.close(); }
}

/**
 * Accept regular files, symbolic links and submodule entries. Workspaces check
 * links out as plain files holding the link text (`core.symlinks=false`) and
 * leave submodules uninitialized; changes to either are refused at application.
 */
function validateTree(checkout: string, baseline: string): void {
  const entries = git(checkout, ["ls-tree", "-r", "-z", "--full-tree", baseline]).split("\0").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !/^(?:(?:100644|100755|120000) blob|160000 commit) [a-f0-9]+\t/.test(entry))) {
    throw new Error("Workspaces require a commit with regular files, symbolic links or submodules");
  }
}

/** Git modes that a workspace represents but never changes in the source. */
export function isUnchangeableMode(mode: string): boolean {
  return mode === "120000" || mode === "160000";
}

async function independentCheckout(directory: string): Promise<{ checkout: string; head: string }> {
  const checkout = await plainDirectory(join(directory, "repo"));
  const dotGit = await plainDirectory(join(checkout, ".git"));
  const identity = git(checkout, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir",
    "HEAD^{commit}"]).trimEnd().split(/\r?\n/u);
  const [topLevel, gitDirectory, commonDirectory, head] = identity;
  if (identity.length !== 4 || topLevel === undefined || gitDirectory === undefined ||
      commonDirectory === undefined || head === undefined || relative(checkout, topLevel) !== "" ||
      relative(dotGit, gitDirectory) !== "" || resolve(checkout, commonDirectory) !== dotGit ||
      !isGitObjectId(head) || git(checkout, ["remote"]).trim() !== "") {
    throw new Error("Workspace Git storage is not independent");
  }
  for (const file of ["objects/info/alternates", "objects/info/http-alternates"]) {
    try { await lstat(join(dotGit, file)); } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Workspace object storage is shared");
  }
  return { checkout, head };
}

async function prepareRoot(path: string): Promise<string> {
  const root = resolve(path);
  let ancestor = root;
  for (;;) {
    try { await lstat(ancestor); break; } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  await plainDirectory(ancestor);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return plainDirectory(root);
}

/** A relative, forward-slash repository path that stays inside the tree and outside `.git`. */
export function isRepositoryPath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

/** Write source changes into a checkout's working tree. */
export async function writeSourceChanges(checkout: string, changes: readonly SourceChange[]): Promise<void> {
  for (const change of changes) {
    if (!isRepositoryPath(change.path)) throw new Error("Unsupported source path");
    const target = join(checkout, ...change.path.split("/"));
    if (change.content === null) { await rm(target, { force: true }); continue; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, change.content, { mode: change.executable ? 0o755 : 0o644 });
  }
}

const commitIdentity = ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "-c", "commit.gpgsign=false"];

/** Commit everything in the checkout when anything changed, and return HEAD. */
export function commitAll(checkout: string, message: string): string {
  git(checkout, ["add", "--all"]);
  if (git(checkout, ["diff", "--cached", "--name-only", "-z"]).length > 0) {
    git(checkout, [...commitIdentity, "commit", "--quiet", "--no-verify", "-m", message]);
  }
  const head = git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!isGitObjectId(head)) throw new Error("Invalid workspace commit");
  return head;
}

/** Where a workspace keeps its private snapshot of the source. */
export function sourceSnapshotDirectory(directory: string): string { return join(directory, "source-snapshot"); }

/** Whether the source is a Git repository or a plain folder (decision 032). */
export type SourceKind = "repository" | "folder";

/** Where a folder's private repository lives, and what the source is when the caller has decided; otherwise it is detected. */
export interface SourceOptions {
  readonly foldersRoot?: string;
  readonly kind?: SourceKind;
}

/** The source's identity: a Git repository's top level and HEAD, or a folder and its private repository's commit. */
async function sourceIdentity(sourceDirectory: string, foldersRoot: string, kind: SourceKind | undefined):
  Promise<{ source: string; baseline: string; tracking?: string }> {
  if (kind === "folder" || kind === undefined && !isGitRepository(sourceDirectory)) {
    const { folder, tracking, head } = await openFolder(sourceDirectory, foldersRoot);
    return { source: folder, baseline: head, tracking };
  }
  const identity = git(resolve(sourceDirectory), ["rev-parse", "--show-toplevel", "HEAD^{commit}"])
    .trimEnd().split(/\r?\n/u);
  const [topLevel, baseline] = identity;
  if (identity.length !== 2 || topLevel === undefined || baseline === undefined || !isGitObjectId(baseline)) {
    throw new Error("Invalid source identity");
  }
  return { source: await realpath(topLevel), baseline };
}

/**
 * Clone the source's committed HEAD without its refs, remotes, config or hooks,
 * then add its uncommitted, non-ignored changes as one commit on top. A plain
 * folder is cloned from its private repository (decision 032).
 */
export async function createWorkspaceCheckout(sourceDirectory: string,
  workspacesRoot: string = DEFAULT_WORKSPACES_ROOT, options: SourceOptions = {}): Promise<WorkspaceCheckout> {
  const { source, baseline, tracking } = await sourceIdentity(sourceDirectory, options.foldersRoot ?? DEFAULT_FOLDERS_ROOT,
    options.kind);
  validateTree(tracking ?? source, baseline);
  const requestedRoot = resolve(workspacesRoot);
  if (contains(source, requestedRoot) || contains(requestedRoot, source)) {
    throw new Error("Workspace storage must be separate from the source repository");
  }
  const root = await prepareRoot(requestedRoot);
  const directory = join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const record: CheckoutRecord = { format: "tesota-workspace-checkout", version: 1, source, baseline, state: "preparing",
    ...tracking === undefined ? {} : { tracking } };
  await saveRecord(directory, record);
  try {
    const template = join(directory, "empty-template");
    await mkdir(template);
    const checkout = join(directory, "repo");
    git(directory, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--no-tags", "--depth", "1",
      "--single-branch", "--config", "core.symlinks=false", `--template=${template}`, "--", tracking ?? source, checkout]);
    validateTree(checkout, baseline);
    git(checkout, ["checkout", "--detach", baseline, "--"]);
    git(checkout, ["remote", "remove", "origin"]);
    const cloned = await independentCheckout(directory);
    if (cloned.head !== baseline || git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length !== 0) {
      throw new Error("Workspace checkout mismatch");
    }
    const snapshot = await SourceSnapshot.open(source, sourceSnapshotDirectory(directory), tracking);
    const tree = snapshot.capture();
    const included = snapshot.changes(baseline, tree);
    await writeSourceChanges(cloned.checkout, included);
    const head = commitAll(cloned.checkout, "Tesota: uncommitted changes from the source repository");
    await snapshot.record(tree);
    await saveRecord(directory, { ...record, state: "ready" });
    return { directory, checkout: cloned.checkout, source, baseline, head,
      included: included.map((change) => ({ status: change.status, path: change.path })),
      ...tracking === undefined ? {} : { tracking } };
  } catch (error) {
    await saveRecord(directory, { ...record, state: "failed" }).catch(() => {});
    if (error instanceof UnsupportedSourceChange) throw error;
    throw new Error(`Workspace creation failed; incomplete state retained at ${directory}`);
  }
}

/** A directory under the workspaces root, described by its record when it has a readable one. */
export type WorkspaceEntry =
  | Readonly<{ kind: "workspace"; directory: string; state: "preparing" | "ready" | "failed"; source: string }>
  | Readonly<{ kind: "unreadable"; directory: string }>;

const workspaceNamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** List workspace directories without trusting or changing them. */
export async function listWorkspaceCheckouts(root: string = DEFAULT_WORKSPACES_ROOT): Promise<readonly WorkspaceEntry[]> {
  let names: string[];
  try { names = await readdir(root); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries: WorkspaceEntry[] = [];
  for (const name of names.sort()) {
    const directory = join(root, name);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    if (!workspaceNamePattern.test(name)) continue;
    try {
      const record = await readRecord(directory);
      entries.push({ kind: "workspace", directory, state: record.state, source: record.source });
    } catch { entries.push({ kind: "unreadable", directory }); }
  }
  return entries;
}

/** Verify a saved workspace before reuse; its record describes it but grants nothing. */
export async function inspectWorkspaceCheckout(path: string): Promise<WorkspaceCheckout> {
  const directory = await plainDirectory(path);
  const record = await readRecord(directory);
  if (record.state !== "ready") throw new Error(`Workspace is ${record.state}; retained at ${directory}`);
  const { checkout, head } = await independentCheckout(directory);
  const root = dirname(directory);
  if (contains(record.source, root) || contains(root, record.source) ||
      contains(record.source, checkout) || contains(checkout, record.source)) throw new Error("Workspace overlaps source");
  return { directory, checkout, source: record.source, baseline: record.baseline, head, included: [],
    ...record.tracking === undefined ? {} : { tracking: record.tracking } };
}
