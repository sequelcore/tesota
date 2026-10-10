import { createHash } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { git, useSnapshotGit } from "./git.js";

/**
 * How much of a folder Tesota snapshots, as pi-workspace-history bounds its
 * own: a file over `fileBytes` is left out and named; a folder holding more
 * files or folders, or taking longer to read, is not snapshotted at all.
 */
export interface SnapshotLimits {
  readonly fileBytes: number;
  readonly files: number;
  readonly folders: number;
  readonly scanMs: number;
}

export const SNAPSHOT_LIMITS: SnapshotLimits = { fileBytes: 10 * 1024 * 1024, files: 20_000, folders: 3_000, scanMs: 5_000 };

/** Folders never snapshotted, at any depth: Git's and Jujutsu's own, dependencies and build output. */
const excludedFolders = [".git", ".jj", "node_modules", "dist", "build", ".cache", ".next", ".turbo", "coverage"];

/** Environment files hold secrets, so no snapshot copies one. */
const secret = (name: string): boolean => name === ".env" || name.startsWith(".env.");

/** Snapshots kept past their last day of use, the most recently used first; older ones are removed. */
const kept = 10;
const day = 24 * 60 * 60 * 1000;

/** A snapshot to measure the request against, with the files it left out for their size; or why there is none. */
export type Snapshot = { readonly base: string; readonly tooLarge: readonly string[] } | { readonly refused: string };

/**
 * The files over the size limit, or why the folder is past the limits.
 * `ownFiles` reads the folder's own files and no folder below it.
 */
function scan(root: string, ownFiles: boolean, limits: SnapshotLimits): string[] | string {
  const started = Date.now();
  const tooLarge: string[] = [];
  let files = 0;
  let folders = 0;
  const queue = [""];
  for (let folder = queue.shift(); folder !== undefined; folder = queue.shift()) {
    let entries: Dirent[];
    try { entries = readdirSync(join(root, folder), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory() && !ownFiles && !excludedFolders.includes(entry.name)) {
        folders += 1;
        queue.push(path);
      } else if (entry.isFile() && !secret(entry.name)) {
        files += 1;
        if (statSync(join(root, path)).size > limits.fileBytes) tooLarge.push(path);
      }
    }
    if (files > limits.files) return `it holds more than ${limits.files} files, past what Tesota snapshots`;
    if (folders > limits.folders) return `it holds more than ${limits.folders} folders, past what Tesota snapshots`;
    if (Date.now() - started > limits.scanMs) return `reading it took more than ${limits.scanMs / 1000} s, past what Tesota snapshots`;
  }
  return tooLarge.sort();
}

/** A path as a pattern in Git's exclude file that matches it alone. */
function exactly(path: string): string {
  return `/${path.replace(/[\\*?[\]!#]/gu, (character) => `\\${character}`)}`;
}

/** Remove the snapshots past `kept` that no one used in the last day. */
function prune(snapshots: string): void {
  const used = readdirSync(snapshots).map((name) => {
    try { return { name, at: statSync(join(snapshots, name, "tesota-used")).mtimeMs }; } catch { return { name, at: 0 }; }
  }).sort((a, b) => b.at - a.at);
  for (const { name, at } of used.slice(kept)) {
    if (Date.now() - at > day) rmSync(join(snapshots, name), { recursive: true, force: true });
  }
}

/**
 * A snapshot of the folder at `root`, which is in no Git repository (#384),
 * for the gate to measure a request against as it measures a repository
 * against its `HEAD`: Git run in the folder (`gitEnvironment`) uses a Git
 * directory under Pi's agent directory, and the folder gains nothing. Each
 * call commits the folder as it is, so Git's index keeps later snapshots
 * quick. Secrets, dependencies, build output and what the folder's
 * `.gitignore` names are left out, and so is every folder below it when
 * `ownFiles`. A home folder or a drive's root is never snapshotted.
 */
export async function takeSnapshot(root: string, ownFiles: boolean, limits: SnapshotLimits = SNAPSHOT_LIMITS): Promise<Snapshot> {
  const at = resolve(root);
  if (at === resolve(homedir()) || dirname(at) === at) return { refused: "Tesota does not snapshot a home folder or a drive's root" };
  const tooLarge = scan(at, ownFiles, limits);
  if (typeof tooLarge === "string") return { refused: tooLarge };
  const snapshots = join(getAgentDir(), "state", "tesota", "snapshots");
  const gitDir = join(snapshots, createHash("sha256").update(`${at}\0${ownFiles}`).digest("hex").slice(0, 16));
  useSnapshotGit(at, gitDir);
  if (!existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true });
    if (await git(at, ["init", "-q"]) === undefined || await git(at, ["config", "core.autocrlf", "false"]) === undefined) {
      return { refused: "Git could not make a snapshot of it" };
    }
  }
  writeFileSync(join(gitDir, "info", "exclude"), [...excludedFolders.map((name) => `${name}/`), ".env", ".env.*",
    ...ownFiles ? ["/*/"] : [], ...tooLarge.map(exactly)].join("\n"));
  writeFileSync(join(gitDir, "tesota-used"), at);
  const committed = await git(at, ["-c", "advice.addEmbeddedRepo=false", "add", "-A"]) !== undefined
    && await git(at, ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "commit", "-q", "--allow-empty",
      "--no-verify", "-m", "Tesota snapshot"]) !== undefined;
  const base = committed ? (await git(at, ["rev-parse", "HEAD"]))?.trim() : undefined;
  prune(snapshots);
  return base === undefined || base === "" ? { refused: "Git could not make a snapshot of it" } : { base, tooLarge };
}
