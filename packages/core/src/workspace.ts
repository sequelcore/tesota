import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { lockSession, SessionLockedError } from "./session-lock.ts";

/**
 * Where a session works (#453): the checkout itself, or a Git worktree of it
 * on its own branch. Its tools run there, and its base, diff, checks and
 * receipt are its own. The permission floor keeps its file tools' writes
 * there, not its shell: a command can reach anything the operator can.
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
  /** What every process the session starts adds to Tesota's environment, such as a writing subagent's branch guard (#619). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Lets go of the workspace as the session closes: the checkout for the
   * next session, or the worktree, removed with its branch only when nothing
   * in it or on its branch changed. Returns where kept work is, when there is some.
   */
  release(): string | undefined;
}

/** The workspace a session's header records, to reopen it. */
export type WorkspaceRecord = Pick<Workspace, "cwd" | "checkout" | "worktree" | "branch" | "base">;

/**
 * Git, run in `folder` with the operator's own repository, never Tesota's snapshots. Without Git installed
 * it fails like any other Git failure, so the folder is treated as outside a repository: `Bun.spawnSync`
 * throws for a missing program, which crashed the shell at startup.
 */
function gitIn(folder: string, args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly err: string } {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...env } = process.env;
  try {
    const result = Bun.spawnSync(["git", "-C", folder, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { ok: result.exitCode === 0, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
  } catch (error) {
    return { ok: false, out: "", err: `Git could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** A folder by its one real name: links, junctions and Windows' short names resolved, as Git names it. */
const canonical = (folder: string): string => {
  const at = resolve(folder);
  try { return realpathSync.native(at); } catch { return at; }
};

/** The folder holding `.git` (a folder, or a worktree's file) at or above `folder`, found without running Git; else `folder`. */
export function checkoutRoot(folder: string): string {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return folder;
  }
}

/**
 * Whether nothing in `folder` can enter the change of a session working in
 * `cwd` (#653): it is outside both `cwd` and the tree of the repository
 * holding it, or Git ignores it there. The gate reads only `cwd`'s tree,
 * and no file Git ignores, so this holds whatever the remote, the branch or
 * the commits.
 */
export function outsideChange(folder: string, cwd: string): boolean {
  const at = canonical(folder);
  const from = relative(canonical(checkoutRoot(cwd)), at);
  // `..` as a whole name, so a folder in it named `..sessions` is still inside.
  if (from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from)) return true;
  return gitIn(cwd, ["check-ignore", "-q", at]).ok;
}

/**
 * The lease on a checkout, held by whoever works in it: its whole repository
 * or worktree, by its real name, so sessions opened in two of its folders or
 * through two names of it do not share it.
 */
function leaseOn(folder: string): (() => void) | undefined {
  const leases = join(tesotaHome(), "workspaces");
  mkdirSync(leases, { recursive: true });
  const root = checkoutRoot(folder);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  try {
    const lock = lockSession(join(leases, `${basename(root) || "root"}-${hashOf(key)}.lock`));
    return () => { lock.release(); };
  } catch (error) {
    if (error instanceof SessionLockedError) return undefined;
    throw error;
  }
}

/** The repository `checkout` is in, by its real name, and the commit it is at; nothing outside Git or before the first commit. */
function repositoryOf(checkout: string): { readonly top: string; readonly head: string } | undefined {
  const top = gitIn(checkout, ["rev-parse", "--show-toplevel"]);
  const head = gitIn(checkout, ["rev-parse", "HEAD"]);
  return top.ok && head.ok ? { top: canonical(top.out), head: head.out } : undefined;
}

/**
 * Whether nothing in `worktree` or on `branch` differs from `base`: no
 * change, staged or not, no file Git does not track and does not ignore,
 * whatever the operator's status settings, and the branch and HEAD both
 * still at `base`.
 */
function unchanged(worktree: string, branch: string, base: string): boolean {
  const status = gitIn(worktree, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
  const tip = gitIn(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const head = gitIn(worktree, ["rev-parse", "HEAD"]);
  return status.ok && status.out === "" && tip.ok && tip.out === base && head.ok && head.out === base;
}

/** Removes a worktree Tesota made and its branch, after a failed start; nothing in it is the operator's yet. */
function discard(top: string, worktree: string, branch: string): void {
  gitIn(top, ["worktree", "remove", "--force", worktree]);
  gitIn(top, ["worktree", "prune"]);
  gitIn(top, ["branch", "-D", branch]);
}

/** A worktree's workspace, leased like a checkout: `cwd` in it, released by removing it with its branch when unchanged. */
function worktreeWorkspace(checkout: string, worktree: string, inside: string, branch: string, base: string,
  leased: () => void): Workspace {
  const cwd = join(worktree, inside);
  // A folder the operator made and has not committed is not in the worktree yet.
  mkdirSync(cwd, { recursive: true });
  return {
    cwd, checkout, worktree, branch, base,
    release() {
      leased();
      if (unchanged(worktree, branch, base) && gitIn(checkout, ["worktree", "remove", worktree]).ok) {
        gitIn(checkout, ["branch", "-D", branch]);
        return undefined;
      }
      return `The session's work is in ${worktree}, on branch ${branch}.`;
    },
  };
}

/** The lease on a worktree Tesota made or made again; another session already in it is refused. */
function worktreeLease(worktree: string): () => void {
  const leased = leaseOn(worktree);
  if (leased === undefined) throw new Error(`Another session is working in ${worktree}; close it first.`);
  return leased;
}

/**
 * Binds a new session `id` opened in `checkout` to its workspace (#453): the
 * checkout itself when no other session holds it; else, in a Git repository,
 * a worktree on branch `tesota/<id>` from the current commit, in
 * `~/.tesota/worktrees`. Outside Git, a second session is refused, since
 * nothing could bring its work back.
 */
export function bindWorkspace(checkout: string, id: string): Workspace {
  const at = canonical(checkout);
  const leased = leaseOn(at);
  if (leased !== undefined) return { cwd: at, checkout: at, release: () => { leased(); return undefined; } };
  return newWorktree(at, id, `Another session is working in ${at}, which is not a Git repository with a commit, so a second one `
    + "could not work apart from it; close that session first.");
}

/**
 * A worktree of its own for session `id` opened in `checkout`, whoever holds
 * the checkout: on branch `tesota/<id>` from the current commit, in
 * `~/.tesota/worktrees`, as a second session gets (#453) and a writing child
 * always does (#525). Outside Git it is refused, saying `outsideGit`.
 */
export function newWorktree(checkout: string, id: string, outsideGit: string): Workspace {
  const at = canonical(checkout);
  const repository = repositoryOf(at);
  if (repository === undefined) throw new Error(outsideGit);
  const worktree = join(tesotaHome(), "worktrees", `${basename(repository.top) || "root"}-${hashOf(repository.top)}`, id);
  const branch = `tesota/${id}`;
  const added = gitIn(repository.top, ["worktree", "add", "-b", branch, worktree, repository.head]);
  if (!added.ok) {
    // A hook that fails after Git made the worktree leaves it and its branch: they go with the failure.
    discard(repository.top, worktree, branch);
    throw new Error(`Could not make a worktree for the session: ${added.err}`);
  }
  const made = canonical(worktree);
  return worktreeWorkspace(at, made, relative(repository.top, at), branch, repository.head, worktreeLease(made));
}

/** Whether a Git, by its `--version` line, runs hooks defined in configuration beside a repository's own: Git 2.54 and later (#619). */
export function configHooks(version: string): boolean {
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/u.exec(version) ?? []).slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 54);
}

let gitVersion: string | undefined;
/** The `--version` line of the Git that sessions run, read once. */
export const installedGit = (): string => gitVersion ??= gitIn(".", ["--version"]).out;

/**
 * Git's guard on a writing subagent's branch (#619): a `reference-transaction`
 * hook defined in configuration, so it runs beside the repository's own
 * hooks and changes neither them nor the repository's configuration. In the
 * repository it was admitted to, by Git's absolute common folder, a
 * transaction that would move another branch or any tag is aborted before
 * it changes anything; a folder Git can't place counts as that repository.
 * Anywhere else it does nothing. `git -c` can turn it off; it guards
 * branches, not the worktrees' files.
 */
const guardScript = `#!/bin/sh
[ "$1" = prepared ] || { cat >/dev/null; exit 0; }
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common="$TESOTA_GUARD_COMMON"
[ "$common" = "$TESOTA_GUARD_COMMON" ] || { cat >/dev/null; exit 0; }
refused=0
while read -r old new ref; do
  case "$ref" in
    "$TESOTA_GUARD_BRANCH") ;;
    refs/heads/*|refs/tags/*)
      echo "Tesota: this subagent may move only its own branch, \${TESOTA_GUARD_BRANCH#refs/heads/}, not $ref. Report the conflict to your parent instead." >&2
      refused=1 ;;
  esac
done
exit $refused
`;

/**
 * `workspace`, a worktree on its own branch, with Git's guard on that branch
 * in the environment of every process its session starts (#619): appended
 * to the configuration pairs Tesota's own environment has, never in a file.
 */
export function guardedWorktree(workspace: Workspace): Workspace {
  if (workspace.worktree === undefined || workspace.branch === undefined) throw new Error("Only a worktree's own branch can be guarded.");
  const common = gitIn(workspace.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || common.out === "") throw new Error(`Could not guard the subagent's branch: ${common.err}`);
  const script = join(tesotaHome(), "hooks", "branch-guard.sh");
  mkdirSync(dirname(script), { recursive: true });
  if (!existsSync(script) || readFileSync(script, "utf8") !== guardScript) writeFileSync(script, guardScript);
  const pairs = Number.parseInt(process.env["GIT_CONFIG_COUNT"] ?? "0", 10) || 0;
  return { ...workspace, env: { ...workspace.env, GIT_CONFIG_COUNT: String(pairs + 2),
    [`GIT_CONFIG_KEY_${pairs}`]: "hook.tesota-branch-guard.event", [`GIT_CONFIG_VALUE_${pairs}`]: "reference-transaction",
    [`GIT_CONFIG_KEY_${pairs + 1}`]: "hook.tesota-branch-guard.command",
    [`GIT_CONFIG_VALUE_${pairs + 1}`]: `sh '${script.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`,
    TESOTA_GUARD_BRANCH: `refs/heads/${workspace.branch}`, TESOTA_GUARD_COMMON: common.out } };
}

/**
 * The workspace a resumed session recorded: its worktree, made again from its
 * branch, or from its base when the branch went too, if it was removed; or the
 * checkout, which it must hold as it did.
 */
export function reopenWorkspace(record: WorkspaceRecord): Workspace {
  if (record.worktree === undefined || record.branch === undefined || record.base === undefined) {
    const leased = leaseOn(canonical(record.cwd));
    if (leased === undefined) throw new Error(`Another session is working in ${record.cwd}, in a Tesota that is still open; close that session there, then resume this one. `
      + "To work now, start a new session beside it: it gets a worktree.");
    return { cwd: record.cwd, checkout: record.cwd, release: () => { leased(); return undefined; } };
  }
  const repository = repositoryOf(record.checkout);
  if (repository === undefined) throw new Error(`${record.checkout} is no longer a Git repository, so the session's worktree cannot be made again.`);
  const worktree = record.worktree;
  if (!existsSync(worktree)) {
    // A worktree deleted by hand stays registered until pruned, and Git would not add it again.
    gitIn(repository.top, ["worktree", "prune"]);
    const hasBranch = gitIn(repository.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`]).ok;
    const added = gitIn(repository.top, hasBranch ? ["worktree", "add", worktree, record.branch]
      : ["worktree", "add", "-b", record.branch, worktree, record.base]);
    if (!added.ok) throw new Error(`Could not make the session's worktree again: ${added.err}`);
  }
  return worktreeWorkspace(record.checkout, worktree, relative(repository.top, canonical(record.checkout)), record.branch, record.base,
    worktreeLease(worktree));
}
