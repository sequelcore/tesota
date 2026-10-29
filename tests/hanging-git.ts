import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Git clean filter in the repository at `folder` that never answers, for
 * the paths `attributes` names, so Git's status of a changed one hangs
 * (#648). Its process records its parent, itself and the child it starts in
 * `pids`. Both end on their own within a moment of `release`, or of the test's
 * process ending, so none outlives the test however it ends (#691).
 */
export function hangingFilter(folder: string, attributes: string): { pids: string; release: () => void } {
  const pids = join(folder, ".git", "pids");
  const hold = join(folder, ".git", "hold");
  const script = join(folder, ".git", "hang.cjs");
  // Gone with its hold file or the test's process, checked often enough for a cleanup's retries to outlast it.
  const watch = `setInterval(() => { try { process.kill(${process.pid}, 0); } catch { process.exit(); } ` +
    `if (!require('fs').existsSync(${JSON.stringify(hold)})) process.exit(); }, 200);`;
  writeFileSync(hold, "");
  writeFileSync(script, "const { spawn } = require('child_process');\n" +
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(watch)}], { stdio: 'ignore' });\n` +
    `require('fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.ppid, process.pid, child.pid]));\n` +
    `${watch}\n`);
  execFileSync("git", ["config", "filter.hang.clean", `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`], { cwd: folder });
  writeFileSync(join(folder, ".gitattributes"), attributes);
  return { pids, release: () => { rmSync(hold, { force: true }); } };
}
