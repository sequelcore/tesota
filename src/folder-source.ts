import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import { isGitObjectId, operatorLineEndingSetting, runRepositoryGit as git,
  type RepositoryGitEnvironment } from "./repository-git.js";

/**
 * A plain folder as a workspace's source (decision 032). Tesota keeps a
 * private Git view of the folder beside it, in its own directory, never
 * inside it: a bare repository whose work tree is the folder, the pattern
 * people use to version their home directory's dotfiles. Its one commit holds
 * the folder as Tesota first found it; every later edit, the person's or an
 * applied result, is to it what uncommitted changes are to a repository, so
 * the rest of the workspace works on a folder as it does on a repository.
 */

export const DEFAULT_FOLDERS_ROOT: string = join(homedir(), ".tesota", "folders");

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

/**
 * Whether a directory is worked on as a Git repository: it is inside one whose
 * top level is neither the home directory nor a drive root. A home directory
 * kept in Git, as dotfiles often are, would otherwise make a folder inside it
 * stand for the whole home, credentials included; such a folder is a folder.
 */
export function isGitRepository(directory: string, home: string = homedir()): boolean {
  let topLevel: string;
  try { topLevel = realpathSync(git(directory, ["rev-parse", "--show-toplevel"]).trim()); } catch { return false; }
  let ownHome: string;
  try { ownHome = realpathSync(home); } catch { ownHome = home; }
  return parse(topLevel).root !== topLevel && topLevel.toLocaleLowerCase("en-US") !== ownHome.toLocaleLowerCase("en-US");
}

/** How much a folder holds, without the files that are not the person's work, so the person can decide before Tesota copies it. */
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
 * Why a folder cannot be worked on, or undefined when it can: the whole home
 * directory and a drive or file system root hold far more than one piece of
 * work, credentials included.
 */
export function folderProblem(folder: string, home: string = homedir()): string | undefined {
  if (parse(folder).root === folder) return "Choose a folder, not the root of a drive";
  let ownHome: string;
  try { ownHome = realpathSync(home); } catch { ownHome = home; }
  return folder.toLocaleLowerCase("en-US") === ownHome.toLocaleLowerCase("en-US")
    ? "Choose a folder inside your home directory, not the whole of it" : undefined;
}

/** The Git environment that shows a folder through its private repository. */
export function folderEnvironment(folder: string, tracking: string): RepositoryGitEnvironment {
  return { GIT_DIR: tracking, GIT_WORK_TREE: folder };
}

/** Where Tesota keeps a folder's private repository: named by the folder's path, as saved sessions are. */
export function trackingDirectory(folder: string, root: string = DEFAULT_FOLDERS_ROOT): string {
  return join(root, createHash("sha256").update(folder.toLocaleLowerCase("en-US")).digest("hex"));
}

const commitIdentity = ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "-c", "commit.gpgsign=false"];

/**
 * The folder, its private repository, and the commit that holds the folder as
 * Tesota first found it; made on first use. The whole home directory and a
 * drive or file system root are refused: they hold far more than one piece of
 * work, credentials included.
 */
export async function openFolder(path: string, root: string = DEFAULT_FOLDERS_ROOT):
  Promise<{ folder: string; tracking: string; head: string }> {
  const folder = await realpath(path);
  if (!(await lstat(folder)).isDirectory()) throw new Error("Choose a folder");
  const problem = folderProblem(folder);
  if (problem !== undefined) throw new Error(problem);
  const tracking = trackingDirectory(folder, root);
  const env = folderEnvironment(folder, tracking);
  if (!existsSync(tracking)) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    git(root, ["init", "--bare", "--quiet", "--", tracking]);
    await writeFile(join(tracking, "info", "exclude"), `${excludedPatterns.join("\n")}\n`);
    await writeFile(join(tracking, "tesota-folder.json"), `${JSON.stringify({ folder }, null, 2)}\n`, { mode: 0o600 });
  }
  let head: string;
  try { head = git(folder, ["rev-parse", "--verify", "HEAD^{commit}"], env).trim(); } catch {
    // The same line-ending setting as later captures, so the first capture finds nothing changed.
    git(folder, ["-c", `core.autocrlf=${operatorLineEndingSetting(folder)}`, "add", "--all", "--", "."], env);
    if (git(folder, ["diff", "--cached", "--name-only", "-z"], env).length === 0) throw new Error("The folder has no files to work on");
    git(folder, [...commitIdentity, "commit", "--quiet", "--no-verify", "-m", "Tesota: the folder as Tesota first found it"], env);
    head = git(folder, ["rev-parse", "--verify", "HEAD^{commit}"], env).trim();
  }
  if (!isGitObjectId(head)) throw new Error("Invalid folder record");
  return { folder, tracking, head };
}

function size(bytes: number): string {
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
    `${size(bytes)}. It keeps a private record of the folder in ~/.tesota/folders and a copy for the agent; nothing in ` +
    "this folder changes until you apply a reviewed result. Work on this folder? [y/N] ";
}
