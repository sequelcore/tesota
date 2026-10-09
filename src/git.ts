import { spawn } from "node:child_process";

const outputLimit = 16 * 1024 * 1024;

/**
 * Git's output in `root`; `too_large` when it passes what the gate reads,
 * undefined when Git fails. Past the limit it closes Git's output and waits
 * for Git to exit on the broken pipe instead of killing it: on Windows the
 * `git` on PATH can be a launcher, and killing it would leave the Git it
 * started running in the project after the gate moved on.
 */
export function gitOutput(root: string, args: readonly string[]): Promise<string | "too_large" | undefined> {
  return new Promise((settle) => {
    const child = spawn("git", [...args], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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
