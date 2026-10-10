import { spawn } from "node:child_process";
import { resolve } from "node:path";

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

/**
 * Git's output in `root`; `too_large` when it passes what the gate reads,
 * undefined when Git fails. Past the limit it closes Git's output and waits
 * for Git to exit on the broken pipe instead of killing it: on Windows the
 * `git` on PATH can be a launcher, and killing it would leave the Git it
 * started running in the project after the gate moved on.
 */
export function gitOutput(root: string, args: readonly string[]): Promise<string | "too_large" | undefined> {
  return new Promise((settle) => {
    const child = spawn("git", [...args], { cwd: root, env: gitEnvironment(root), windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) child.stdout.destroy();
      else chunks.push(chunk);
    });
    child.once("error", () => { settle(undefined); });
    child.once("close", (status) => {
      settle(size > outputLimit ? "too_large" : status === 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
  });
}

/** Git's output in `root`; undefined when Git fails or its output passes what the gate reads. */
export async function git(root: string, args: readonly string[]): Promise<string | undefined> {
  const output = await gitOutput(root, args);
  return output === "too_large" ? undefined : output;
}

/** The commit `HEAD` names in the project at `root`; null before its first commit, and outside Git. */
export async function headCommit(root: string): Promise<string | null> {
  const commit = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  return commit === undefined || commit === "" ? null : commit;
}
