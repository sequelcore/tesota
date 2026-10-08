import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runShell } from "../src/test-rung.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A command whose shell starts a Node process that records its id and runs until stopped. */
const lingering = "node -e \"require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)\"";

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

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-shell-"));
  roots.push(root);
  return root;
}

it("stops every process a cancelled command started, not only its shell", async () => {
  const root = folder();
  const controller = new AbortController();
  const running = runShell(lingering, root, controller.signal);
  expect(await until(() => existsSync(join(root, "pid")) && readFileSync(join(root, "pid"), "utf8") !== "")).toBe(true);
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  controller.abort();
  expect((await running).outcome).toBe("cancelled");
  expect(await until(() => !alive(pid), 5_000)).toBe(true);
}, 30_000);

it("stops every process a command started when it runs past its time limit", async () => {
  const root = folder();
  const run = await runShell(lingering, root, new AbortController().signal, 3_000);
  expect(run.outcome).toBe("timed_out");
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  expect(await until(() => !alive(pid), 5_000)).toBe(true);
}, 30_000);
