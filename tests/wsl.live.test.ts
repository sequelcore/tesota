import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { controlsFor, runControls } from "../src/execution-controls.js";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import { qualifyProvider } from "../src/execution-qualification.js";
import { bubblewrapEnvironment, type Launch, WSL_GUARANTEES, wslProvider } from "../src/wsl-environment.js";

/**
 * The WSL sandbox (decision 043) against the execution controls every
 * provider must pass, then the network's report and allowance, loopback
 * servers, cancellation of a process tree, Windows programs and the time a
 * command takes. On Windows it runs the whole provider in Tesota's WSL
 * distribution; on Linux, the same sandbox process started directly, which is
 * everything but `wsl.exe` and path translation. It needs bubblewrap, and
 * runs only with TESOTA_LIVE_WSL=1.
 */
const live = process.env["TESOTA_LIVE_WSL"] === "1";
const windows = process.platform === "win32";
let root = "";
let workspace = "";
let sandbox: ExecutionEnvironment | undefined;

/** On Linux: the built sandbox process, run by this Node. */
const direct: Launch = (args) => spawn(process.execPath, [resolve("dist", "bubblewrap-sandbox-server.js"), ...args]);

async function run(command: string, signal?: AbortSignal): Promise<{ outcome: string; exitCode: number | null; output: string; ms: number }> {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  let output = "";
  const started = Date.now();
  const result = await sandbox.run(command, { cwd: workspace, onOutput: (chunk) => { output += chunk.toString(); },
    ...signal === undefined ? {} : { signal } });
  return { ...result, output, ms: Date.now() - started };
}

beforeAll(async () => {
  if (!live) return;
  root = await mkdtemp(join(tmpdir(), "tesota-wsl-live-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(root, "outside"));
  if (windows) expect(await wslProvider.readiness()).toEqual({ ready: true });
  sandbox = windows ? await wslProvider.prepare(workspace) : await bubblewrapEnvironment(direct, workspace);
}, 300_000);

afterAll(async () => {
  if (!live) return;
  await sandbox?.dispose();
  if (windows) await wslProvider.release(workspace);
  await rm(root, { recursive: true, force: true });
}, 120_000);

it.runIf(live)("passes every control its guarantees call for, including a client that ignores the proxy", async () => {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  const results = await runControls(sandbox, controlsFor(WSL_GUARANTEES), { workspace, outside: join(root, "outside"),
    runtime: "node", refusedUrl: "https://example.com/", registryUrl: "https://registry.npmjs.org/" }, new AbortController().signal);
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(results.map((result) => result.control)).toEqual(controlsFor(WSL_GUARANTEES));
}, 300_000);

it.runIf(live && windows)("qualifies on this machine with every claim upheld, from a workspace of its own", async () => {
  const machine = await wslProvider.fingerprint?.();
  expect(machine).toMatch(/^windows \S+; bubblewrap \S+; linux \S+; node v\S+$/u);
  const record = await qualifyProvider(wslProvider, { root: join(root, "qualification"), signal: new AbortController().signal,
    fingerprint: machine ?? "" });
  expect(record.guarantees).toEqual(WSL_GUARANTEES);
  expect(record.results.every((result) => result.passed)).toBe(true);
}, 600_000);

it.runIf(live)("reports a refused destination and opens only what is allowed", async () => {
  const started = new Date(Date.now() - 1_000);
  const fetch = (url: string): Promise<{ output: string }> => run(`curl -sS -m 20 -o /dev/null -w '%{http_code}' ${url}`);
  expect((await fetch("https://example.com/")).output).not.toMatch(/\b200\b/u);
  expect(await sandbox?.network?.blockedSince(started)).toContain("example.com:443");
  await sandbox?.network?.allow(["example.com:443"]);
  expect((await fetch("https://example.com/")).output).toMatch(/\b200\b/u);
  expect((await fetch("https://example.org/")).output).not.toMatch(/\b200\b/u);
}, 120_000);

it.runIf(live)("runs a server on its own loopback and connects to it", async () => {
  const server = "require('node:http').createServer((q, s) => s.end('loopback-ok')).listen(0, '127.0.0.1', function () { " +
    "require('node:http').get({ host: '127.0.0.1', port: this.address().port }, (r) => r.on('data', (d) => { " +
    "process.stdout.write(String(d)); process.exit(0); })); })";
  const result = await run(`node -e "${server}"`);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("loopback-ok");
}, 60_000);

it.runIf(live)("stops a cancelled command's whole tree, detached children included, and confirms it", async () => {
  const late = join(workspace, "late.txt");
  const cancellation = new AbortController();
  const running = run("(sleep 4; echo late > late.txt) & setsid sh -c 'sleep 4; echo late >> late.txt' & sleep 60", cancellation.signal);
  await new Promise((wait) => setTimeout(wait, 1_000));
  cancellation.abort();
  expect((await running).outcome).toBe("cancelled");
  await new Promise((wait) => setTimeout(wait, 6_000));
  expect(existsSync(late)).toBe(false);
}, 60_000);

it.runIf(live && windows)("cannot start a Windows program, even one copied into the workspace", async () => {
  copyFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe"), join(workspace, "whoami.exe"));
  const result = await run("./whoami.exe");
  expect(result.exitCode).not.toBe(0);
  expect(result.output).not.toMatch(/\\/u);
}, 60_000);

it.runIf(live)("works with Git, npm and Bun's scripts", async () => {
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0",
    scripts: { hello: "echo hello-script" }, dependencies: { "is-number": "7.0.0" } }));
  const git = await run("git init -q && git add package.json && git status --short");
  expect(git.exitCode).toBe(0);
  expect(git.output).toContain("A  package.json");
  expect((await run("bun run hello")).output).toContain("hello-script");
  const npm = await run("npm install --no-audit --no-fund && node -e \"console.log(require('is-number')(5))\"");
  expect(npm.exitCode).toBe(0);
  expect(npm.output).toContain("true");
}, 300_000);

it.runIf(live)("starts a command quickly", async () => {
  const timings: number[] = [];
  for (let index = 0; index < 5; index++) timings.push((await run("true")).ms);
  process.stdout.write(`WSL sandbox command start, ms: ${timings.join(", ")}\n`);
  expect(Math.min(...timings)).toBeLessThan(1_000);
}, 60_000);
