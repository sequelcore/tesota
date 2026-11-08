import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { launchCommand, runProcess } from "../src/process.js";

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
  // On Windows the run reports only after `taskkill /T` has finished; elsewhere the group's kill is delivered at once.
  if (process.platform === "win32") expect(alive(pid)).toBe(false);
  else expect(await until(() => !alive(pid), 1_000)).toBe(true);
});

it("passes what a process prints to its listener as it comes, and runs without a time limit when given none", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-process-"));
  roots.push(root);
  const chunks: Buffer[] = [];
  const run = await runProcess(process.execPath, ["-e", "console.log('one'); console.error('two')"], root,
    new AbortController().signal, undefined, (chunk) => { chunks.push(chunk); });
  expect(run).toMatchObject({ ended: "exited", exitCode: 0 });
  expect(Buffer.concat(chunks).toString("utf8")).toContain("one");
  expect(Buffer.concat(chunks).toString("utf8")).toContain("two");
});

it("reports how a process ended and what it printed", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-process-"));
  roots.push(root);
  const signal = new AbortController().signal;
  expect(await runProcess(process.execPath, ["-e", "console.log('hi'); process.exit(3)"], root, signal, 60_000))
    .toEqual({ ended: "exited", exitCode: 3, output: "hi\n", stdout: "hi\n", stderr: "" });
  expect((await runProcess(join(root, "missing"), [], root, signal, 60_000)).ended).toBe("not_started");
});

/** npm's Windows shim for a package bin: it runs `node` on the package's entry point, found next to the shim. */
const shim = (entry: string): string =>
  `@ECHO off\r\nGOTO start\r\n:start\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry.replaceAll("/", "\\")}" %*\r\n`;

/** An npm install on disk under a new root: the shim at `shimPath`, naming `reference` beside it, and an empty entry point at `entry`. */
function npmLayout(shimPath: string, reference: string, entry: string): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-shim-"));
  roots.push(root);
  const cmd = join(root, shimPath);
  mkdirSync(join(cmd, ".."), { recursive: true });
  writeFileSync(cmd, shim(reference));
  mkdirSync(join(root, entry, ".."), { recursive: true });
  writeFileSync(join(root, entry), "");
  return cmd;
}

it("runs the entry point of an npm .cmd shim with node on Windows, as a global or a local install lays it out", () => {
  const entry = "node_modules/@informalsystems/quint/dist/src/cli.js";
  const global = npmLayout("quint.cmd", entry, entry);
  expect(launchCommand(global, ["--version"], "win32", "node.exe"))
    .toEqual({ executable: "node.exe", args: [join(global, "..", entry), "--version"] });
  const local = npmLayout("node_modules/.bin/quint.cmd", "../@informalsystems/quint/dist/src/cli.js", entry);
  expect(launchCommand(local, ["verify"], "win32", "node.exe").args[0])
    .toBe(join(local, "..", "..", "@informalsystems", "quint", "dist", "src", "cli.js"));
});

it("leaves everything else as resolved: other platforms, other files, a shim without an entry point, no node", () => {
  const entry = "node_modules/@informalsystems/quint/dist/src/cli.js";
  const cmd = npmLayout("quint.cmd", entry, entry);
  expect(launchCommand(cmd, ["a"], "linux", "node")).toEqual({ executable: cmd, args: ["a"] });
  expect(launchCommand(cmd, ["a"], "win32", undefined)).toEqual({ executable: cmd, args: ["a"] });
  expect(launchCommand("quint.exe", ["a"], "win32", "node")).toEqual({ executable: "quint.exe", args: ["a"] });
  const plain = join(cmd, "..", "plain.cmd");
  writeFileSync(plain, "@echo hi\r\n");
  expect(launchCommand(plain, ["a"], "win32", "node")).toEqual({ executable: plain, args: ["a"] });
});
