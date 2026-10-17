import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { BranchEntry } from "../../../src/contract.ts";
import type { SessionStore } from "../../../src/pull-request-receipt.ts";
import { branchOf } from "./branch.ts";
import { sessionsFolder } from "./session.ts";
import { peekSessionFile, type SessionEntry } from "./session-file.ts";
import { checkoutRoot } from "./workspace.ts";

/** A folder by its one real name, in one case on Windows, to compare where sessions worked. */
function same(folder: string): string {
  let named = resolve(folder);
  try { named = realpathSync.native(folder); } catch { /* as resolved */ }
  return process.platform === "win32" ? named.toLowerCase() : named;
}

/**
 * The folder whose sessions hold the work done in `cwd`: itself in a
 * checkout, and in a Tesota worktree (#453) the same folder of the checkout
 * it was made from, where its session was opened and is kept.
 */
function openedIn(cwd: string): string {
  const root = checkoutRoot(resolve(cwd));
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  const checkout = common.status === 0 ? dirname(common.stdout.trim()) : root;
  return same(checkout) === same(root) ? resolve(cwd) : join(checkout, relative(root, resolve(cwd)));
}

/** The entries of the runs that ended completed; a receipt recorded before a run was cut off is not that run's word. */
function completedRuns(entries: readonly SessionEntry[]): SessionEntry[] {
  const completed = new Set(entries.flatMap((entry) => entry.type === "run_end" && entry.outcome === "completed" ? [entry.run] : []));
  return entries.filter((entry) => !("run" in entry) || completed.has(entry.run));
}

/**
 * The engine's sessions as `tesota receipt` reads them (#463): those that
 * worked in this folder, its checkout's or its worktree's, never another's,
 * and of each only the runs that completed. A file is read without being
 * touched, since another Tesota may be writing it.
 */
export const sessionStore: SessionStore = {
  list: (cwd) => {
    const folder = sessionsFolder(openedIn(cwd));
    let names: string[];
    try { names = readdirSync(folder); } catch { return Promise.resolve([]); }
    return Promise.resolve(names.filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
      const path = join(folder, name);
      try {
        return same(peekSessionFile(path).header.cwd) === same(cwd) ? [{ path, modified: statSync(path).mtime }] : [];
      } catch { return []; }
    }));
  },
  open: (path) => {
    const branch: BranchEntry[] = branchOf(completedRuns(peekSessionFile(path).entries));
    return { getSessionId: () => basename(path, ".jsonl"), getBranch: () => branch };
  },
};
