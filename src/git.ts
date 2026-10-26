import { resolve } from "node:path";
import { runProcess } from "./process.js";

const outputLimit = 16 * 1024 * 1024;

/** The Git directory of each folder in no repository that Tesota snapshots (`takeSnapshot`), by the folder's absolute path. */
const snapshots = new Map<string, string>();

/** Run Git in the folder at `root` against `gitDir`, Tesota's snapshot of it, from now on. */
export function useSnapshotGit(root: string, gitDir: string): void {
  snapshots.set(resolve(root), gitDir);
}

/**
 * The environment Git runs with in `root`: a snapshot's Git directory, with
 * the folder as its work tree, for a folder Tesota snapshots; otherwise the
 * process's own, so a repository and a worktree find their Git as usual.
 */
export function gitEnvironment(root: string): NodeJS.ProcessEnv | undefined {
  const gitDir = snapshots.get(resolve(root));
  return gitDir === undefined ? undefined : { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: resolve(root) };
}

/** The Git runs given each signal that have not ended yet, for `gitStopped`. */
const running = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

/**
 * Git's output in `root`; `too_large` when it passes what the gate reads,
 * undefined when Git fails or `signal` stops it. Git runs through
 * `runProcess`: past the limit, or once `signal` is aborted, Git is stopped
 * with every process it started, a hook's or a filter's, before this
 * resolves; on Windows the `git` on PATH can be a launcher, and the Git it
 * started stops with it.
 */
export async function gitOutput(root: string, args: readonly string[], input?: string,
  signal?: AbortSignal): Promise<string | "too_large" | undefined> {
  if (signal?.aborted === true) return undefined;
  const full = new AbortController();
  const chunks: Buffer[] = [];
  let size = 0;
  const env = gitEnvironment(root);
  const run = runProcess("git", args, root, signal === undefined ? full.signal : AbortSignal.any([signal, full.signal]), undefined, undefined, {
    onStdout: (chunk) => {
      size += chunk.length;
      if (size <= outputLimit) chunks.push(chunk);
      else full.abort();
    },
    ...input === undefined ? {} : { input }, ...env === undefined ? {} : { env } });
  const runs = signal === undefined ? undefined : running.get(signal) ?? new Set();
  if (signal !== undefined && runs !== undefined) running.set(signal, runs.add(run));
  try {
    const ended = await run;
    return size > outputLimit ? "too_large" : ended.ended === "exited" && ended.exitCode === 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
  } finally { runs?.delete(run); }
}

/** Resolves once every Git run given `signal` has ended, its processes stopped: abort `signal` first to stop them. */
export async function gitStopped(signal: AbortSignal): Promise<void> {
  for (let runs = running.get(signal); runs !== undefined && runs.size > 0; runs = running.get(signal)) await Promise.all(runs);
}

/** Git's output in `root`; undefined when Git fails, `signal` stops it, or its output passes what the gate reads. */
export async function git(root: string, args: readonly string[], input?: string, signal?: AbortSignal): Promise<string | undefined> {
  const output = await gitOutput(root, args, input, signal);
  return output === "too_large" ? undefined : output;
}

/** The commit `HEAD` names in the project at `root`; null before its first commit, and outside Git. */
export async function headCommit(root: string): Promise<string | null> {
  const commit = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  return commit === undefined || commit === "" ? null : commit;
}
