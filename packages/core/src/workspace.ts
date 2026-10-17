import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { lockSession, SessionLockedError } from "./session-lock.ts";

/**
 * Where a session works (#453): the checkout itself, or a Git worktree of it
 * on its own branch. Its tools run there, the permission floor keeps it
 * there, and its base, diff, checks and receipt are its own.
 */
export interface Workspace {
  /** The folder the session works in: the checkout, or the same folder inside its worktree. */
  readonly cwd: string;
  /** The folder the operator opened the session in. */
  readonly checkout: string;
  /** The worktree, its branch and the commit it started from; absent when the session works in the checkout. */
  readonly worktree?: string;
  readonly branch?: string;
  readonly base?: string;
  /**
   * Lets go of the workspace as the session closes: the checkout for the
   * next session, or the worktree, removed with its branch when nothing in
   * it changed. Returns where kept work is, when there is some.
   */
  release(): string | undefined;
}

/** The workspace a session's header records, to reopen it. */
export type WorkspaceRecord = Pick<Workspace, "cwd" | "checkout" | "worktree" | "branch" | "base">;

/** Git, run in `folder` with the operator's own repository, never Tesota's snapshots. */
function gitIn(folder: string, args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly err: string } {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env;
  const result = Bun.spawnSync(["git", "-C", folder, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The folder holding `.git` at or above `folder`, found without running Git; `folder` itself outside Git. */
function checkoutRoot(folder: string): string {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return folder;
  }
}

/**
 * The lease on a checkout, held by whoever works in it: the whole repository
 * when `checkout` is in one, so sessions opened in two of its folders do not
 * share it.
 */
function leaseOn(checkout: string): (() => void) | undefined {
  const folder = join(tesotaHome(), "workspaces");
  mkdirSync(folder, { recursive: true });
  const root = checkoutRoot(checkout);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  try {
    const lock = lockSession(join(folder, `${basename(root) || "root"}-${hashOf(key)}.lock`));
    return () => { lock.release(); };
  } catch (error) {
    if (error instanceof SessionLockedError) return undefined;
    throw error;
  }
}

/** The repository `checkout` is in, and the commit it is at; nothing outside Git or before the first commit. */
function repositoryOf(checkout: string): { readonly top: string; readonly head: string } | undefined {
  const top = gitIn(checkout, ["rev-parse", "--show-toplevel"]);
  const head = gitIn(checkout, ["rev-parse", "HEAD"]);
  return top.ok && head.ok ? { top: resolve(top.out), head: head.out } : undefined;
}

/** A worktree's workspace: `cwd` in it, released by removing it with its branch when nothing changed. */
function worktreeWorkspace(checkout: string, worktree: string, inside: string, branch: string, base: string): Workspace {
  return {
    cwd: join(worktree, inside), checkout, worktree, branch, base,
    release() {
      const dirty = gitIn(worktree, ["status", "--porcelain"]);
      const commits = gitIn(worktree, ["rev-list", `${base}..HEAD`]);
      if (dirty.ok && dirty.out === "" && commits.ok && commits.out === "") {
        const removed = gitIn(checkout, ["worktree", "remove", worktree]);
        if (removed.ok) {
          gitIn(checkout, ["branch", "-D", branch]);
          return undefined;
        }
      }
      return `The session's work is in ${worktree}, on branch ${branch}.`;
    },
  };
}

/**
 * Binds a new session `id` opened in `checkout` to its workspace (#453): the
 * checkout itself when no other session holds it; else, in a Git repository,
 * a worktree on branch `tesota/<id>` from the current commit, in
 * `~/.tesota/worktrees`. Outside Git, a second session is refused, since
 * nothing could bring its work back.
 */
export function bindWorkspace(checkout: string, id: string): Workspace {
  const at = resolve(checkout);
  const leased = leaseOn(at);
  if (leased !== undefined) return { cwd: at, checkout: at, release: () => { leased(); return undefined; } };
  const repository = repositoryOf(at);
  if (repository === undefined) {
    throw new Error(`Another session is working in ${at}, which is not a Git repository with a commit, so a second one `
      + "could not work apart from it; close that session first.");
  }
  const worktree = join(tesotaHome(), "worktrees", `${basename(repository.top) || "root"}-${hashOf(repository.top)}`, id);
  const branch = `tesota/${id}`;
  const added = gitIn(repository.top, ["worktree", "add", "-b", branch, worktree, repository.head]);
  if (!added.ok) throw new Error(`Could not make a worktree for the session: ${added.err}`);
  return worktreeWorkspace(at, worktree, relative(repository.top, at), branch, repository.head);
}

/**
 * The workspace a resumed session recorded: its worktree, made again from its
 * branch, or from its base when the branch went too, if it was removed; or the
 * checkout, which it must hold as it did.
 */
export function reopenWorkspace(record: WorkspaceRecord): Workspace {
  if (record.worktree === undefined || record.branch === undefined || record.base === undefined) {
    const leased = leaseOn(record.cwd);
    if (leased === undefined) throw new Error(`Another session is working in ${record.cwd}; close it first, then resume this one.`);
    return { cwd: record.cwd, checkout: record.cwd, release: () => { leased(); return undefined; } };
  }
  const repository = repositoryOf(record.checkout);
  if (repository === undefined) throw new Error(`${record.checkout} is no longer a Git repository, so the session's worktree cannot be made again.`);
  const worktree = record.worktree;
  if (!existsSync(worktree)) {
    const hasBranch = gitIn(repository.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`]).ok;
    const added = gitIn(repository.top, hasBranch ? ["worktree", "add", worktree, record.branch]
      : ["worktree", "add", "-b", record.branch, worktree, record.base]);
    if (!added.ok) throw new Error(`Could not make the session's worktree again: ${added.err}`);
  }
  return worktreeWorkspace(record.checkout, worktree, relative(repository.top, record.checkout), record.branch, record.base);
}
