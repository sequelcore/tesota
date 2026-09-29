import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { isGitObjectId, operatorLineEndingSetting, runRepositoryGit as git, runRepositoryGitBytes as gitBytes,
  type RepositoryGitEnvironment } from "./repository-git.js";

/**
 * One shadow repository per source, a Git repository or a plain folder alike
 * (docs/design/workspace.md): a bare repository under `~/.tesota/sources`,
 * named by the source's path, whose work tree is the source, the pattern
 * people use to version their home directory's dotfiles. It is never the
 * operator's own `.git` and never inside the source. The source's
 * `.gitignore` files apply as they do to the operator's Git.
 *
 * Its HEAD is the state later edits are measured against: a repository's
 * committed HEAD, taken read-only from the operator's repository whenever it
 * moves, or, for a folder or a repository without a commit, the source as
 * Tesota first found it. A superseded HEAD stays for seven days, then Git's
 * own cleanup removes it.
 */

export const DEFAULT_SOURCES_ROOT: string = join(homedir(), ".tesota", "sources");

/** Whether the source is a Git repository or a plain folder; only where the shadow's HEAD comes from differs. */
export type SourceKind = "repository" | "folder";

/**
 * Files that are not the person's work: the lock files Office (`~$name`) and
 * LibreOffice (`.~lock.name#`) keep while a document is open, and the files
 * Windows and macOS leave in folders they show.
 */
const excludedPatterns = ["~$*", ".~lock.*#", "Thumbs.db", "desktop.ini", ".DS_Store"];

function isExcluded(name: string): boolean {
  return name.startsWith("~$") || name.startsWith(".~lock.") && name.endsWith("#") ||
    name === "Thumbs.db" || name === "desktop.ini" || name === ".DS_Store";
}

const branch = "refs/heads/tesota";
const recordFile = "tesota-source.json";
/** Touched after each cleanup, so a shadow is cleaned at most once a day. */
const cleanedFile = "tesota-cleaned";
const retention = "7.days";
const commitIdentity = ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "-c", "commit.gpgsign=false"];

/** Untracked files larger than this slow every capture; OpenCode leaves such files out of its snapshots. */
export const LARGE_UNTRACKED_BYTES: number = 2 * 1024 * 1024;

function ownHome(home: string): string {
  try { return realpathSync(home); } catch { return home; }
}

/** A path as the file system compares it: without case on Windows and macOS, exactly elsewhere. */
function pathKey(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLocaleLowerCase("en-US") : path;
}

/**
 * Whether a directory is worked on as a Git repository: it is inside one whose
 * top level is neither the home directory nor a drive root. A home directory
 * kept in Git, as dotfiles often are, would otherwise make a folder inside it
 * stand for the whole home, credentials included; such a folder is a folder.
 */
export function isGitRepository(directory: string, home: string = homedir()): boolean {
  let topLevel: string;
  try { topLevel = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]).trim()); } catch { return false; }
  return parse(topLevel).root !== topLevel && pathKey(topLevel) !== pathKey(ownHome(home));
}

/** The directory a shadow's work tree is: a repository's top level, or the folder itself. */
export async function sourceRoot(directory: string, kind: SourceKind): Promise<string> {
  const path = kind === "repository" ? git(resolve(directory), ["rev-parse", "--show-toplevel"]).trim() : directory;
  const source = await realpath(path);
  if (!(await lstat(source)).isDirectory()) throw new Error("Choose a folder");
  return source;
}

/**
 * Why a source cannot be worked on, or undefined when it can: the whole home
 * directory and a drive or file system root hold far more than one piece of
 * work, credentials included.
 */
export function sourceProblem(source: string, home: string = homedir()): string | undefined {
  if (parse(source).root === source) return "Choose a folder, not the root of a drive";
  return pathKey(source) === pathKey(ownHome(home))
    ? "Choose a folder inside your home directory, not the whole of it" : undefined;
}

/** How much a folder holds, without the files that are not the person's work, so the person can decide before Tesota records it. */
export async function describeFolder(folder: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isExcluded(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { files += 1; bytes += (await lstat(path)).size; }
    }
  };
  await walk(folder);
  return { files, bytes };
}

/**
 * A repository's untracked, non-ignored files larger than
 * `LARGE_UNTRACKED_BYTES`, largest first, listed by the operator's own Git
 * read-only. Every capture reads them, so the operator is warned rather than
 * asked, as Codex warns of large untracked files.
 */
export async function largeUntrackedFiles(source: string): Promise<readonly { path: string; bytes: number }[]> {
  const listed = gitBytes(source, ["ls-files", "-z", "--others", "--exclude-standard"]).toString("utf8");
  const large: { path: string; bytes: number }[] = [];
  for (const path of listed.split("\0").filter((entry) => entry.length > 0)) {
    if (isExcluded(basename(path))) continue;
    const metadata = await lstat(join(source, ...path.split("/"))).catch(() => undefined);
    if (metadata?.isFile() === true && metadata.size > LARGE_UNTRACKED_BYTES) large.push({ path, bytes: metadata.size });
  }
  return large.sort((left, right) => right.bytes - left.bytes);
}

/** Where Tesota keeps a source's shadow repository: named by the source's path, as saved sessions are. */
export function shadowDirectory(source: string, root: string = DEFAULT_SOURCES_ROOT): string {
  return join(root, createHash("sha256").update(pathKey(source)).digest("hex"));
}

/** The Git environment that shows a source through its shadow repository. */
export function shadowEnvironment(source: string, shadow: string): RepositoryGitEnvironment {
  return { GIT_DIR: shadow, GIT_WORK_TREE: source };
}

function shadowHead(shadow: string): string | undefined {
  try {
    const head = git(shadow, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim();
    return isGitObjectId(head) ? head : undefined;
  } catch { return undefined; }
}

function recordedKind(shadow: string): SourceKind {
  try {
    const kind: unknown = JSON.parse(readFileSync(join(shadow, recordFile), "utf8")).kind;
    return kind === "repository" ? "repository" : "folder";
  } catch { return "folder"; }
}

/**
 * Bring a repository's committed HEAD into its shadow when it moved, reading
 * the operator's repository and never writing to it; a folder's shadow keeps
 * the state Tesota first found. Returns the shadow's HEAD, undefined before
 * its first commit. A failed fetch, such as another Tesota fetching at the
 * same moment, keeps the HEAD it had: tracked files are captured either way.
 */
export function refreshShadow(source: string, shadow: string): string | undefined {
  const current = shadowHead(shadow);
  if (recordedKind(shadow) !== "repository") return current;
  let committed: string;
  try { committed = git(source, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim(); } catch { return current; }
  if (!isGitObjectId(committed) || committed === current) return current;
  try {
    git(shadow, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--depth", "1", "--", source, `+HEAD:${branch}`]);
  } catch { return current; }
  return shadowHead(shadow);
}

/**
 * The source, its shadow repository, and the shadow's HEAD; the shadow is
 * made on first use. The whole home directory and a drive or file system
 * root are refused: they hold far more than one piece of work, credentials
 * included.
 */
export async function openShadow(source: string, kind: SourceKind, root: string = DEFAULT_SOURCES_ROOT):
  Promise<{ source: string; shadow: string; head: string }> {
  const problem = sourceProblem(source);
  if (problem !== undefined) throw new Error(problem);
  const shadow = shadowDirectory(source, root);
  if (!existsSync(shadow)) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    git(root, ["init", "--bare", "--quiet", "--", shadow]);
    git(shadow, ["symbolic-ref", "HEAD", branch]);
    await writeFile(join(shadow, "info", "exclude"), `${excludedPatterns.join("\n")}\n`);
  }
  // A superseded HEAD stays reachable through the reflog for the retention period, and only the daily cleanup prunes.
  for (const [name, value] of [["gc.auto", "0"], ["core.logAllRefUpdates", "always"], ["gc.reflogExpire", retention],
    ["gc.reflogExpireUnreachable", retention], ["gc.pruneExpire", `${retention}.ago`]] as const) git(shadow, ["config", name, value]);
  await writeFile(join(shadow, recordFile), `${JSON.stringify({ source, kind }, null, 2)}\n`, { mode: 0o600 });
  if (kind === "repository") {
    // The operator's own exclusions, as their `git status` applies them.
    const exclude = resolve(source, git(source, ["rev-parse", "--git-path", "info/exclude"]).trim());
    git(shadow, ["config", "core.excludesFile", exclude]);
  }
  let head = refreshShadow(source, shadow);
  if (head === undefined) {
    const env = shadowEnvironment(source, shadow);
    // The same line-ending setting as later captures, so the first capture finds nothing changed.
    git(source, ["-c", `core.autocrlf=${operatorLineEndingSetting(source)}`, "add", "--all", "--", "."], env);
    if (git(source, ["diff", "--cached", "--name-only", "-z"], env).length === 0) throw new Error("There are no files to work on");
    git(source, [...commitIdentity, "commit", "--quiet", "--no-verify", "-m", "Tesota: the source as Tesota first found it"], env);
    head = shadowHead(shadow);
  }
  if (head === undefined) throw new Error("Invalid source record");
  await cleanShadow(shadow);
  return { source, shadow, head };
}

/** Remove what the shadow has held past the retention period, at most once a day. */
async function cleanShadow(shadow: string): Promise<void> {
  const marker = join(shadow, cleanedFile);
  let cleaned = 0;
  try { cleaned = statSync(marker).mtimeMs; } catch { /* never cleaned */ }
  if (Date.now() - cleaned < 24 * 60 * 60 * 1000) return;
  git(shadow, ["gc", "--quiet"]);
  await writeFile(marker, "");
}

/** A shadow repository and the source its record names, undefined when the record cannot be read. */
export interface ShadowEntry {
  readonly directory: string;
  readonly source: string | undefined;
}

/** List shadow repositories without trusting or changing them. */
export async function listShadows(root: string = DEFAULT_SOURCES_ROOT): Promise<readonly ShadowEntry[]> {
  let names: string[];
  try { names = await readdir(root); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries: ShadowEntry[] = [];
  for (const name of names.filter((entry) => /^[0-9a-f]{64}$/u.test(entry)).sort()) {
    const directory = join(root, name);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    let source: string | undefined;
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, recordFile), "utf8")).source;
      source = typeof value === "string" ? value : undefined;
    } catch { source = undefined; }
    entries.push({ directory, source });
  }
  return entries;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The question before Tesota first works on a folder: what it holds, where Tesota keeps it, and that nothing changes unapplied. */
export async function folderQuestion(folder: string): Promise<string> {
  const { files, bytes } = await describeFolder(folder);
  return `${folder} is not a Git repository. Tesota can work on it as a folder: ${files} ${files === 1 ? "file" : "files"}, ` +
    `${formatSize(bytes)}. It keeps a private record of the folder in ~/.tesota/sources and a copy for the agent; nothing in ` +
    "this folder changes until you apply a reviewed result. Work on this folder? [y/N] ";
}

/**
 * The warning for a repository's large untracked files, undefined when it has
 * none: Tesota records them and reads them before every request.
 */
export function largeUntrackedWarning(files: readonly { path: string; bytes: number }[]): string | undefined {
  if (files.length === 0) return undefined;
  const named = files.slice(0, 3).map((file) => `${file.path} (${formatSize(file.bytes)})`).join(", ");
  const more = files.length > 3 ? ` and ${files.length - 3} more` : "";
  return `${files.length} untracked ${files.length === 1 ? "file is" : "files are"} over ${formatSize(LARGE_UNTRACKED_BYTES)}: ` +
    `${named}${more}. Tesota records ${files.length === 1 ? "it" : "them"} and reads ${files.length === 1 ? "it" : "them"} ` +
    "before every request; add to .gitignore what is not part of the work.";
}
