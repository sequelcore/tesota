import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../src/process.ts";

/**
 * Stopping a run ends every process it started, even one whose parent has
 * already exited (#490): Git's bash runs a script through a process that
 * exits, which leaves the script's processes with no living parent to find
 * them by. Here the first process starts a shell, `cmd` or `sh`, which starts
 * the last in the background and exits, as bash's does. The shell is not a
 * Node process: Bun and Node end their own children when they exit, which
 * would hide the case.
 */
const left: number[] = [];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterEach(() => { for (const pid of left.splice(0)) if (alive(pid)) process.kill(pid); });

test("a stop ends a process whose parent already exited, as a stopped check's must be", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-process-tree-"));
  const ready = join(cwd, "ready.txt");
  const shellPid = join(cwd, "shell.txt");
  writeFileSync(join(cwd, "last.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetTimeout(() => {}, 60000);\n`);
  const node = JSON.stringify(process.execPath);
  const shell = process.platform === "win32"
    ? `spawn("cmd.exe", ["/d", "/c", "start", "/b", "", ${node}, "last.cjs"], { stdio: "ignore" })`
    : `spawn("sh", ["-c", ${JSON.stringify(`${JSON.stringify(process.execPath)} last.cjs &`)}], { stdio: "ignore" })`;
  writeFileSync(join(cwd, "first.cjs"), `const { spawn } = require("node:child_process");\nconst shell = ${shell};\n` +
    `require("node:fs").writeFileSync(${JSON.stringify(shellPid)}, String(shell.pid));\nsetTimeout(() => {}, 60000);\n`);
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["first.cjs"], cwd, controller.signal, undefined);
  while (!existsSync(ready) || readFileSync(ready, "utf8") === "") await new Promise((resolve) => setTimeout(resolve, 20));
  const last = Number(readFileSync(ready, "utf8"));
  left.push(last);
  // The stop comes once the shell is gone, so the last process has no living parent.
  const between = Number(readFileSync(shellPid, "utf8"));
  while (alive(between)) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(alive(last)).toBe(true);
  controller.abort();
  expect((await running).ended).toBe("cancelled");
  // Gone within moments, not the minute it waits: Linux reaps a killed orphan on its own time.
  for (let waited = 0; waited < 10_000 && alive(last); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(alive(last)).toBe(false);
}, 60_000);
