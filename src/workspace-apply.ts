import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { runRepositoryGit as git, runRepositoryGitBytes as gitBytes } from "./repository-git.js";
import { applicationAdmission, applicationOutcome, commitStep, type PathContent, restoreStep }
  from "./verification/application-rule.js";
import type { Workspace, WorkspaceChange, WorkspaceSnapshot } from "./workspace.js";
import { DEFAULT_WORKSPACES_ROOT, isRepositoryPath, isUnchangeableMode } from "./workspace-checkout.js";

/**
 * Where applications keep their journal and a copy of every original and every
 * reviewed file (decision 042): beside the workspaces, outside the source and
 * outside any one workspace, so they outlive the session that applied them.
 */
export const DEFAULT_APPLICATIONS_ROOT: string = join(dirname(DEFAULT_WORKSPACES_ROOT), "applications");
/** Finished applications are removed from the store after this many days. */
export const APPLICATION_RETENTION_DAYS = 30;

/** Nothing was written to the source repository. */
export class ApplyConflictError extends Error {
  readonly paths: readonly string[];
  constructor(message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "ApplyConflictError";
    this.paths = paths;
  }
}

/** Application stopped after writing, and everything it wrote was undone. */
export class ApplyRolledBackError extends Error {
  readonly paths: readonly string[];
  constructor(message: string, paths: readonly string[]) {
    super(message);
    this.name = "ApplyRolledBackError";
    this.paths = paths;
  }
}

/** What one path of an unfinished application holds now. */
export interface ApplicationPathState {
  readonly path: string;
  /**
   * `original` and `applied` are the application's own content; `changed` is
   * anything else; `unknown` when an error left no way to tell.
   */
  readonly state: "original" | "applied" | "changed" | "unknown";
}

/** A partial effect remains in the source; `tesota recover` undoes or finishes it. */
export class ApplyRecoveryError extends Error {
  readonly id: string;
  readonly paths: readonly ApplicationPathState[];
  constructor(id: string, paths: readonly ApplicationPathState[]) {
    super("Application stopped partway and could not be undone");
    this.name = "ApplyRecoveryError";
    this.id = id;
    this.paths = paths;
  }
}

/** A finished application, and source paths outside it that changed while it ran. */
export interface AppliedWork {
  readonly changes: readonly WorkspaceChange[];
  readonly alsoChanged: readonly string[];
}

type LineEnding = "lf" | "crlf";

interface PlannedWrite {
  readonly change: WorkspaceChange;
  readonly target: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  readonly mode: number;
}

interface ManifestPath {
  readonly path: string;
  readonly status: WorkspaceChange["status"];
  readonly mode: number;
}

interface Manifest {
  readonly id: string;
  readonly source: string;
  readonly base: string;
  readonly tree: string;
  readonly startedAt: string;
  readonly paths: readonly ManifestPath[];
  /** Directories created for added files, deepest first, removed again when undone if empty. */
  readonly directories: readonly string[];
}

/** One application as its store holds it: each path with its original and reviewed content. */
interface Recorded {
  readonly directory: string;
  readonly manifest: Manifest;
  readonly writes: readonly PlannedWrite[];
}

type JournalState = "prepared" | "applied" | "rolled_back" | "recovery_required" | "resolved";
const finished: ReadonlySet<string> = new Set(["applied", "rolled_back", "resolved"]);

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

function isText(bytes: Buffer): boolean { return !bytes.includes(0); }

function toLf(bytes: Buffer): Buffer { return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1"); }

function toCrlf(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"), "latin1");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
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
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ApplyConflictError("Not a regular file", [path]);
  return { bytes: await readFile(path), mode: metadata.mode & 0o777 };
}

/** Missing directories above `path`, deepest first, and the nearest one that exists. */
async function missingParents(path: string): Promise<{ existing: string; missing: string[] }> {
  const missing: string[] = [];
  let current = dirname(path);
  for (;;) {
    try { return { existing: await realpath(current), missing }; } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(current);
      current = parent;
    }
  }
}

/** The Git mode of a path in a tree, or an empty string when the path is absent. */
function treeMode(workspace: Workspace, tree: string, path: string): string {
  return git(workspace.checkout, ["ls-tree", tree, "--", path]).split(" ")[0] ?? "";
}

/** One change's write, `conflict` when the source no longer holds its base, or undefined when it writes nothing. */
async function planChange(workspace: Workspace, snapshot: WorkspaceSnapshot, source: string, change: WorkspaceChange):
  Promise<{ write: PlannedWrite; directories: readonly string[] } | "conflict" | undefined> {
  if (!isRepositoryPath(change.path)) throw new ApplyConflictError("Unsupported path", [change.path]);
  const target = join(source, ...change.path.split("/"));
  const parents = await missingParents(target);
  if (!contains(source, parents.existing)) throw new ApplyConflictError("Path leaves the repository", [change.path]);
  // Decided from Git's record before the file is read, so a link is refused the same way on every platform.
  const baseMode = treeMode(workspace, snapshot.base, change.path);
  const newMode = treeMode(workspace, snapshot.tree, change.path);
  if (isUnchangeableMode(baseMode) || isUnchangeableMode(newMode)) {
    throw new ApplyConflictError("Symbolic links and submodules cannot be changed", [change.path]);
  }
  const existing = await readExisting(target);
  const reviewed = change.status === "deleted" ? null : gitBytes(workspace.checkout, ["cat-file", "blob", `${snapshot.tree}:${change.path}`]);
  if (change.status === "added") {
    if (existing !== null) return "conflict";
    return { write: { change, target, before: null, after: reviewed, mode: newMode === "100755" ? 0o755 : 0o644 },
      directories: parents.missing.map((directory) => relative(source, directory)) };
  }
  const base = gitBytes(workspace.checkout, ["cat-file", "blob", `${snapshot.base}:${change.path}`]);
  const ending = existing === null ? null : sourceMatchesBase(existing.bytes, base);
  if (existing === null || ending === null) return "conflict";
  const after = reviewed === null ? null : ending === "crlf" && isText(reviewed) && !reviewed.includes("\r") ? toCrlf(reviewed) : reviewed;
  // A change Git sees only in the mode keeps the source's mode, so it writes nothing.
  if (after !== null && after.equals(existing.bytes)) return undefined;
  return { write: { change, target, before: existing.bytes, after, mode: existing.mode }, directories: [] };
}

async function planWrites(workspace: Workspace, snapshot: WorkspaceSnapshot, source: string):
  Promise<{ writes: PlannedWrite[]; directories: string[] }> {
  const writes: PlannedWrite[] = [];
  const directories = new Set<string>();
  const conflicts: string[] = [];
  for (const change of snapshot.changes) {
    const planned = await planChange(workspace, snapshot, source, change);
    if (planned === "conflict") conflicts.push(change.path);
    else if (planned !== undefined) {
      writes.push(planned.write);
      for (const directory of planned.directories) directories.add(directory);
    }
  }
  if (conflicts.length > 0) throw new ApplyConflictError("These files changed in your repository since the workspace was created", conflicts);
  // Deepest first, so undoing removes a child before its parent.
  return { writes, directories: [...directories].sort((left, right) => right.length - left.length) };
}

/** What `target` holds, judged against one write's original and reviewed content. */
async function contentAt(write: PlannedWrite): Promise<PathContent> {
  let current: Buffer | null;
  try { current = (await readExisting(write.target))?.bytes ?? null; } catch { return "other"; }
  const same = (expected: Buffer | null): boolean => expected === null ? current === null : current?.equals(expected) === true;
  if (same(write.before)) return "before";
  return same(write.after) ? "after" : "other";
}

function sibling(target: string, tag: string, kind: "tmp" | "hold"): string {
  return join(dirname(target), `.tesota-${tag}.${kind}`);
}

/**
 * Give `from`'s content the name `to` without ever replacing a file there:
 * a hard link fails if the name exists. A volume without hard links, such as
 * FAT32, or a link the system refuses, gets a copy created exclusively
 * instead, which also never replaces a file. False when the name is taken.
 */
async function linkNew(from: string, to: string): Promise<boolean> {
  try { await link(from, to); return true; } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(errorCode(error) ?? "")) throw error;
  }
  const content = await readFile(from);
  let file: FileHandle;
  try { file = await open(to, "wx", (await lstat(from)).mode & 0o777); } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  return true;
}

/** Put `content` at `target` without ever replacing a file there, written and synced beside it first. */
async function install(target: string, content: Buffer, mode: number, tag: string): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = sibling(target, tag, "tmp");
  await rm(temporary, { force: true });
  const file = await open(temporary, "wx", mode);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  try { return await linkNew(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
}

/**
 * What an exchange did to its path: `done`, `untouched` when the path holds
 * what it held before the attempt, or `partial` when Tesota moved content
 * away and could not put anything back, which only the store then keeps.
 */
type Exchanged = "done" | "untouched" | "partial";

/**
 * Replace `expected` at `target` with `content` (null: remove it), never
 * replacing or removing anything else. The file is first moved aside, which
 * is atomic and keeps whatever was there, then compared: a file that differs,
 * such as an edit made a moment before, is put back untouched. A file some
 * program recreates while the name is free makes the install fail rather than
 * be replaced.
 */
async function exchange(target: string, expected: Buffer | null, content: Buffer | null, mode: number,
  tag: string): Promise<Exchanged> {
  if (expected === null) return content === null || await install(target, content, mode, tag) ? "done" : "untouched";
  const hold = sibling(target, tag, "hold");
  try { await rename(target, hold); } catch { return "untouched"; }
  const held = await readFile(hold).catch(() => null);
  if (held === null || !held.equals(expected)) {
    if (!(await linkNew(hold, target).catch(() => false))) return "partial";
    await unlink(hold).catch(() => {});
    return "untouched";
  }
  // The held content is the application's own original or reviewed file, which the store keeps.
  const installed = content === null || await install(target, content, mode, tag);
  await unlink(hold).catch(() => {});
  return installed ? "done" : "partial";
}

class Journal {
  readonly #file: FileHandle;
  private constructor(file: FileHandle) { this.#file = file; }
  static async open(directory: string): Promise<Journal> {
    return new Journal(await open(join(directory, "journal.jsonl"), "a", 0o600));
  }
  async write(entry: Readonly<{ state: JournalState; how?: string }> |
    Readonly<{ step: "intended" | "done" | "untouched"; path: string }>):
    Promise<void> {
    await this.#file.writeFile(`${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
    await this.#file.sync();
  }
  async close(): Promise<void> { await this.#file.close(); }
}

/**
 * The journal's states, and the paths the application touched: those whose
 * last step is `intended` or `done`. A path whose attempt left it as it was
 * ends with `untouched`, and one a crash interrupted ends with `intended`, so
 * it counts as touched whatever it holds.
 */
async function readJournal(directory: string): Promise<{ states: readonly string[]; touched: ReadonlySet<string> }> {
  const text = await readFile(join(directory, "journal.jsonl"), "utf8").catch(() => "");
  const states: string[] = [];
  const steps = new Map<string, string>();
  for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry !== "object" || entry === null) continue;
    if ("state" in entry && typeof entry.state === "string") states.push(entry.state);
    if ("step" in entry && "path" in entry && typeof entry.step === "string" && typeof entry.path === "string") {
      steps.set(entry.path, entry.step);
    }
  }
  return { states, touched: new Set([...steps].filter(([, step]) => step !== "untouched").map(([path]) => path)) };
}

/** Prepared, and not yet applied, undone or resolved: a partial effect may remain. */
function unfinishedState(states: readonly string[]): boolean {
  return states.includes("prepared") && !states.some((state) => finished.has(state));
}

async function syncedWrite(path: string, content: Buffer | string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

/** Copy every original and every reviewed file into the store, then journal the application as prepared. */
async function prepare(root: string, manifest: Manifest, writes: readonly PlannedWrite[]): Promise<Journal> {
  const directory = join(root, manifest.id);
  await mkdir(join(directory, "before"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "after"), { recursive: true, mode: 0o700 });
  for (const [index, write] of writes.entries()) {
    if (write.before !== null) await syncedWrite(join(directory, "before", String(index)), write.before);
    if (write.after !== null) await syncedWrite(join(directory, "after", String(index)), write.after);
  }
  await syncedWrite(join(directory, "application.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const journal = await Journal.open(directory);
  await journal.write({ state: "prepared" });
  return journal;
}

async function readManifest(directory: string): Promise<Manifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, "application.json"), "utf8")) as Manifest;
    return typeof value.id === "string" && typeof value.source === "string" && Array.isArray(value.paths) &&
      Array.isArray(value.directories) ? value : undefined;
  } catch { return undefined; }
}

async function loadRecorded(directory: string): Promise<Recorded | undefined> {
  const manifest = await readManifest(directory);
  if (manifest === undefined) return undefined;
  const stored = async (side: "before" | "after", index: number): Promise<Buffer | null> =>
    readFile(join(directory, side, String(index))).catch(() => null);
  const writes = await Promise.all(manifest.paths.map(async (path, index): Promise<PlannedWrite> => ({
    change: { status: path.status, path: path.path },
    target: join(manifest.source, ...path.path.split("/")),
    before: path.status === "added" ? null : await stored("before", index),
    after: path.status === "deleted" ? null : await stored("after", index),
    mode: path.mode,
  })));
  // A copy the store lost cannot be told from absence, so such an application is left to the operator.
  const complete = writes.every((write) => (write.change.status === "added" || write.before !== null) &&
    (write.change.status === "deleted" || write.after !== null));
  return complete ? { directory, manifest, writes } : undefined;
}

function tagFor(id: string, index: number): string { return `${id.slice(0, 8)}-${index}`; }

/**
 * Each path's state, and the proved outcome those states amount to. A path the
 * application never touched counts as unaffected whatever it holds, since
 * anything there is someone else's; a touched one only when it holds its
 * original again.
 */
async function assess(writes: readonly PlannedWrite[], touched: ReadonlySet<string>):
  Promise<{ outcome: ReturnType<typeof applicationOutcome>; paths: ApplicationPathState[] }> {
  const contents = await Promise.all(writes.map(contentAt));
  const after = contents.filter((content) => content === "after").length;
  const unaffected = contents.filter((content, index) => content === "before" ||
    content === "other" && !touched.has(writes[index]?.change.path ?? "")).length;
  const names = { before: "original", after: "applied", other: "changed" } as const;
  return {
    outcome: writes.length === 0 ? "applied" : applicationOutcome(writes.length, after, unaffected),
    paths: writes.map((write, index) => ({ path: write.change.path, state: names[contents[index] ?? "other"] })),
  };
}

/** Move each path to its reviewed content where it still holds its original; stop at the first that does not. */
async function commit(id: string, writes: readonly PlannedWrite[], journal: Journal): Promise<string | undefined> {
  for (const [index, write] of writes.entries()) {
    const step = commitStep(await contentAt(write));
    if (step === "done") continue;
    if (step === "stop") return write.change.path;
    await journal.write({ step: "intended", path: write.change.path });
    const exchanged = await exchange(write.target, write.before, write.after, write.mode, tagFor(id, index));
    if (exchanged === "partial") return write.change.path;
    await journal.write({ step: exchanged, path: write.change.path });
    if (exchanged === "untouched") return write.change.path;
  }
  return undefined;
}

/** Put each original back where the path still holds exactly what Tesota wrote, newest first. */
async function restore(recorded: Pick<Recorded, "manifest" | "writes">): Promise<void> {
  for (const [index, write] of [...recorded.writes.entries()].reverse()) {
    if (restoreStep(await contentAt(write)) !== "restore") continue;
    await exchange(write.target, write.after, write.before, write.mode, tagFor(recorded.manifest.id, index)).catch(() => "partial");
  }
  for (const directory of recorded.manifest.directories) {
    await rmdir(join(recorded.manifest.source, directory)).catch(() => {});
  }
}

async function applicationDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

/** Remove finished applications older than the retention period; unfinished ones are never removed. */
async function pruneApplications(root: string, now: Date): Promise<void> {
  const limit = now.getTime() - APPLICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const directory of await applicationDirectories(root)) {
    const manifest = await readManifest(directory);
    const { states } = await readJournal(directory);
    if (manifest === undefined || !states.some((state) => finished.has(state))) continue;
    if (Date.parse(manifest.startedAt) < limit) await rm(directory, { recursive: true, force: true });
  }
}

/** An application to a source that did not finish, with what each of its paths holds now. */
export interface UnfinishedApplication {
  readonly id: string;
  readonly startedAt: string;
  /** Where its originals and reviewed files are kept. */
  readonly directory: string;
  readonly paths: readonly ApplicationPathState[];
}

/** Applications to `source` that stopped partway, or whose process ended while they ran, oldest first. */
export async function unfinishedApplications(source: string, root: string = DEFAULT_APPLICATIONS_ROOT):
  Promise<readonly UnfinishedApplication[]> {
  const resolved = await realpath(source).catch(() => source);
  const found: UnfinishedApplication[] = [];
  for (const directory of await applicationDirectories(root)) {
    const manifest = await readManifest(directory);
    const journal = await readJournal(directory);
    if (manifest?.source !== resolved || !unfinishedState(journal.states)) continue;
    const recorded = await loadRecorded(directory);
    found.push({ id: manifest.id, startedAt: manifest.startedAt, directory,
      paths: recorded === undefined ? manifest.paths.map((path) => ({ path: path.path, state: "unknown" as const }))
        : (await assess(recorded.writes, journal.touched)).paths });
  }
  return found.toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/**
 * After a stop that left a file moved aside, such as a crash between moving it
 * and installing its replacement, put it back where its name is still free,
 * never over a file there; a leftover temporary file is removed.
 */
async function returnHeld(recorded: Recorded): Promise<void> {
  for (const [index, write] of recorded.writes.entries()) {
    const tag = tagFor(recorded.manifest.id, index);
    await rm(sibling(write.target, tag, "tmp"), { force: true }).catch(() => {});
    const hold = sibling(write.target, tag, "hold");
    if (await linkNew(hold, write.target).catch(() => false)) await unlink(hold).catch(() => {});
  }
}

/**
 * Settle an unfinished application: `undo` puts every original back where the
 * path still holds what Tesota wrote, `finish` writes the reviewed content
 * where the path still holds its original, and `resolved` records the
 * operator's statement that the source is as they want it, which is their
 * acceptance, not evidence that anything was checked. Paths someone else
 * changed are never touched; the application stays unfinished until every
 * path agrees.
 */
export async function recoverApplication(source: string, id: string, action: "undo" | "finish" | "resolved",
  root: string = DEFAULT_APPLICATIONS_ROOT): Promise<Readonly<{ settled: boolean; paths: readonly ApplicationPathState[] }>> {
  const unfinished = (await unfinishedApplications(source, root)).find((application) => application.id === id);
  if (unfinished === undefined) throw new Error(`No unfinished application ${id} for this repository`);
  const journal = await Journal.open(unfinished.directory);
  try {
    if (action === "resolved") {
      await journal.write({ state: "resolved", how: "operator" });
      return { settled: true, paths: unfinished.paths };
    }
    const recorded = await loadRecorded(unfinished.directory);
    if (recorded === undefined) throw new Error(`The store for application ${id} is incomplete; settle it by hand`);
    await returnHeld(recorded);
    if (action === "undo") await restore(recorded);
    else await commit(id, recorded.writes, journal);
    const assessed = await assess(recorded.writes, (await readJournal(recorded.directory)).touched);
    const settled = assessed.outcome === (action === "undo" ? "not_applied" : "applied");
    if (settled) await journal.write({ state: "resolved", how: action });
    return { settled, paths: assessed.paths };
  } finally { await journal.close(); }
}

/** Refuse, with nothing written, unless decision 042's admission is `apply`. */
async function admit(workspace: Workspace, snapshot: WorkspaceSnapshot, source: string, root: string): Promise<void> {
  const unfinished = await unfinishedApplications(source, root);
  const reviewCurrent = workspace.snapshot().tree === snapshot.tree && snapshot.base === workspace.base;
  const current = unfinished.length > 0 || !reviewCurrent ? undefined : await workspace.sourceChanges();
  const admission = applicationAdmission(unfinished.length > 0, reviewCurrent, current?.paths?.length === 0);
  if (admission === "recover") {
    throw new ApplyConflictError("an earlier application to this repository did not finish; run tesota recover");
  }
  if (admission === "stale_review") throw new ApplyConflictError("The workspace changed after review");
  if (admission === "refresh") {
    throw new ApplyConflictError("files in your repository changed since this result was checked; continue with a " +
      "request to bring them in, and the result is checked again", current?.paths ?? []);
  }
}

/** Stands for the path an unexpected error stopped at. */
const unknownPath = "";

/** Write, read back, and undo on a stop; throw unless every path holds its reviewed content. */
async function run(recorded: Recorded, journal: Journal): Promise<void> {
  const { manifest, writes } = recorded;
  const stopped = await commit(manifest.id, writes, journal).catch(() => unknownPath);
  let assessed = await assess(writes, (await readJournal(recorded.directory)).touched);
  if (stopped !== undefined || assessed.outcome !== "applied") {
    await restore(recorded);
    assessed = await assess(writes, (await readJournal(recorded.directory)).touched);
  }
  if (assessed.outcome === "not_applied") {
    await journal.write({ state: "rolled_back" });
    throw new ApplyRolledBackError("a file changed or could not be replaced while applying, so everything " +
      "written was undone", stopped === undefined || stopped === unknownPath ? [] : [stopped]);
  }
  if (assessed.outcome === "recovery_required") {
    await journal.write({ state: "recovery_required" });
    throw new ApplyRecoveryError(manifest.id, assessed.paths);
  }
  await journal.write({ state: "applied" });
}

/**
 * Apply exactly the reviewed workspace content to the source repository
 * (decision 042). The whole source must still hold what the workspace last
 * took from it; every original and reviewed file is kept first; each path is
 * moved aside, compared and installed without ever replacing another file;
 * and the result is read back. A stop after the first write undoes what was
 * written where the path still holds it, and whatever cannot be undone is
 * left as an unfinished application for `tesota recover`.
 */
export async function applyWorkspace(workspace: Workspace, snapshot: WorkspaceSnapshot,
  root: string = join(dirname(dirname(workspace.directory)), basename(DEFAULT_APPLICATIONS_ROOT))): Promise<AppliedWork> {
  const source = await realpath(workspace.source);
  let planned: Awaited<ReturnType<typeof planWrites>>;
  try {
    await admit(workspace, snapshot, source, root);
    planned = await planWrites(workspace, snapshot, source);
  } catch (error) {
    if (error instanceof ApplyConflictError) throw error;
    throw new ApplyConflictError(`Tesota could not read your repository (${error instanceof Error ? error.message : String(error)})`);
  }
  const { writes, directories } = planned;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await pruneApplications(root, new Date()).catch(() => {});
  const manifest: Manifest = { id: randomUUID(), source, base: snapshot.base, tree: snapshot.tree,
    startedAt: new Date().toISOString(), directories,
    paths: writes.map((write) => ({ path: write.change.path, status: write.change.status, mode: write.mode })) };
  let journal: Journal;
  try { journal = await prepare(root, manifest, writes); } catch (error) {
    await rm(join(root, manifest.id), { recursive: true, force: true }).catch(() => {});
    throw new ApplyConflictError(`Tesota could not keep a copy of your files first (${error instanceof Error ? error.message : String(error)})`);
  }
  try { await run({ directory: join(root, manifest.id), manifest, writes }, journal); } finally { await journal.close(); }
  workspace.settle(snapshot, "Tesota: applied reviewed changes");
  // The next update records the source; these are only named, since it brings them in.
  const applied = new Set(snapshot.changes.map((change) => change.path));
  const after = await workspace.sourceChanges().catch(() => undefined);
  return { changes: snapshot.changes, alsoChanged: after?.paths?.filter((path) => !applied.has(path)) ?? [] };
}
