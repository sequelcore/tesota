import { spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import type { BranchEntry } from "../../../src/contract.ts";
import type { SessionStore } from "../../../src/pull-request-receipt.ts";
import { branchOf } from "./branch.ts";
import { peekSessionFile, type SessionEntry } from "./session-file.ts";
import { checkoutRoot } from "./workspace.ts";

/** A folder by its one real name, in one case on Windows, to compare where sessions worked. */
function same(folder: string): string {
  let named = resolve(folder);
  try { named = realpathSync.native(folder); } catch { /* as resolved */ }
  return process.platform === "win32" ? named.toLowerCase() : named;
}

/**
 * The name of the checkout folder whose sessions hold the work done in
 * `cwd`: its own in a checkout, and in a Tesota worktree (#453) the checkout
 * it was made from, where its session was opened and is kept.
 */
function checkoutName(cwd: string): string {
  const root = checkoutRoot(resolve(cwd));
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return basename(common.status === 0 ? dirname(common.stdout.trim()) : root);
}

/** The folder a session's header says it worked in, read from its first line alone; none for a file that is not one. */
function workedIn(path: string): string | undefined {
  const buffer = Buffer.alloc(64 * 1024);
  const fd = openSync(path, "r");
  try {
    const first = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").split("\n")[0] ?? "";
    const header: unknown = JSON.parse(first);
    const cwd = typeof header === "object" && header !== null ? Reflect.get(header, "cwd") : undefined;
    return typeof cwd === "string" ? cwd : undefined;
  } catch { return undefined; } finally { closeSync(fd); }
}

/** The entries of the runs that ended completed; a receipt recorded before a run was cut off is not that run's word. */
function completedRuns(entries: readonly SessionEntry[]): SessionEntry[] {
  const completed = new Set(entries.flatMap((entry) => entry.type === "run_end" && entry.outcome === "completed" ? [entry.run] : []));
  return entries.filter((entry) => !("run" in entry) || completed.has(entry.run));
}

/**
 * The engine's sessions as `tesota receipt` reads them (#463): those that
 * worked in this very folder, its checkout's or its worktree's, never
 * another's, and of each only the runs that completed. The sessions of a
 * project are kept under its folder's name and a hash of its path as it was
 * spelled (`sessionsFolder`), so every folder of that name is searched and
 * each session's header decides, by real name, since Windows may spell one
 * folder two ways. A file is read without being touched, since another
 * Tesota may be writing it.
 */
export const sessionStore: SessionStore = {
  list: (cwd) => {
    const sessions = join(tesotaHome(), "sessions");
    const prefix = `${checkoutName(cwd) || "root"}-`;
    const here = same(cwd);
    let folders: string[];
    try { folders = readdirSync(sessions).filter((name) => name.startsWith(prefix)); } catch { return Promise.resolve([]); }
    return Promise.resolve(folders.flatMap((folder) => {
      let names: string[];
      try { names = readdirSync(join(sessions, folder)); } catch { return []; }
      return names.filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
        const path = join(sessions, folder, name);
        const worked = workedIn(path);
        return worked !== undefined && same(worked) === here ? [{ path, modified: statSync(path).mtime }] : [];
      });
    }));
  },
  open: (path) => {
    const branch: BranchEntry[] = branchOf(completedRuns(peekSessionFile(path).entries));
    return { getSessionId: () => basename(path, ".jsonl"), getBranch: () => branch };
  },
};
