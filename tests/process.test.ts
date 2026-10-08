import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A Node process that starts another, as `lsc` starts Dafny, which records its id and runs until stopped. */
const parent = "require('child_process').spawn(process.execPath, ['-e', " +
  "\"require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); " +
  "setInterval(() => {}, 1000)";

async function until(condition: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it("stops the processes a cancelled process started, as a verifier's Dafny", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-process-"));
  roots.push(root);
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", parent], root, controller.signal, 60_000);
  expect(await until(() => existsSync(join(root, "pid")) && readFileSync(join(root, "pid"), "utf8") !== "")).toBe(true);
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  controller.abort();
  expect((await running).ended).toBe("cancelled");
  expect(await until(() => !alive(pid), 5_000)).toBe(true);
}, 30_000);

it("reports how a process ended and what it printed", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-process-"));
  roots.push(root);
  const signal = new AbortController().signal;
  expect(await runProcess(process.execPath, ["-e", "console.log('hi'); process.exit(3)"], root, signal, 60_000))
    .toEqual({ ended: "exited", exitCode: 3, output: "hi\n" });
  expect((await runProcess(join(root, "missing"), [], root, signal, 60_000)).ended).toBe("not_started");
}, 30_000);
