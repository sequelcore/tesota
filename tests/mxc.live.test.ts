import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { controlsFor, runControls } from "../src/execution-controls.js";
import type { ExecutionEnvironment } from "../src/execution-environment.js";
import { mxcProvider } from "../src/mxc-environment.js";
import { qualifyProvider } from "../src/execution-qualification.js";

/**
 * The native Windows sandbox against the execution controls every provider
 * must pass (decision 030), then its proxy's report of a refused destination
 * and the time a command takes. It needs Windows 11 24H2 or later, so it runs
 * only with TESOTA_LIVE_MXC=1.
 */
const live = process.env["TESOTA_LIVE_MXC"] === "1";
let root = "";
let workspace = "";
let sandbox: ExecutionEnvironment | undefined;

async function run(command: string): Promise<{ exitCode: number | null; output: string; ms: number }> {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  let output = "";
  const started = Date.now();
  const result = await sandbox.run(command, { cwd: workspace, onOutput: (chunk) => { output += chunk.toString(); } });
  return { exitCode: result.exitCode, output, ms: Date.now() - started };
}

beforeAll(async () => {
  if (!live) return;
  root = await mkdtemp(join(tmpdir(), "tesota-mxc-live-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(root, "outside"));
  expect(await mxcProvider.readiness()).toEqual({ ready: true });
  sandbox = await mxcProvider.prepare(workspace);
}, 120_000);

afterAll(async () => {
  if (!live) return;
  await sandbox?.dispose();
  await mxcProvider.release(workspace);
  await rm(root, { recursive: true, force: true });
}, 120_000);

it.runIf(live)("passes every control its guarantees call for", async () => {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  const results = await runControls(sandbox, controlsFor(mxcProvider.guarantees), { workspace, outside: join(root, "outside"),
    runtime: "node", refusedUrl: "https://example.com/", registryUrl: "https://registry.npmjs.org/" }, new AbortController().signal);
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(results.map((result) => result.control)).toEqual(controlsFor(mxcProvider.guarantees));
}, 300_000);

it.runIf(live)("qualifies on this machine with every claim upheld, from a workspace of its own", async () => {
  const machine = await mxcProvider.fingerprint?.();
  expect(machine).toMatch(/^windows \d+\.\d+\.\d+; mxc-sdk \d+\.\d+\.\d+$/u);
  const record = await qualifyProvider(mxcProvider, { root: join(root, "qualification"), signal: new AbortController().signal,
    fingerprint: machine ?? "" });
  expect(record.guarantees).toEqual(mxcProvider.guarantees);
  expect(record.results.every((result) => result.passed)).toBe(true);
}, 300_000);

it.runIf(live)("reports a refused destination and opens only what is allowed", async () => {
  const started = new Date(Date.now() - 1_000);
  expect((await run("curl.exe -sS -m 10 -o NUL -w '%{http_code}' https://example.com/")).output).not.toMatch(/\b200\b/u);
  expect(await sandbox?.network?.blockedSince(started)).toContain("example.com:443");
  await sandbox?.network?.allow(["example.com:443"]);
  expect((await run("curl.exe -sS -m 20 -o NUL -w '%{http_code}' https://example.com/")).output).toMatch(/\b200\b/u);
  expect((await run("curl.exe -sS -m 10 -o NUL -w '%{http_code}' https://example.org/")).output).not.toMatch(/\b200\b/u);
}, 120_000);

it.runIf(live)("runs PowerShell in the workspace with the host's tools, in well under a second", async () => {
  const result = await run("node -e \"console.log(process.version)\"; git --version; (Get-Location).ProviderPath");
  expect(result.exitCode).toBe(0);
  expect(result.output).toMatch(/v\d+\.\d+/u);
  expect(result.output).toContain("git version");
  // The workspace is a drive of its own, so tools that walk upward find nothing above it.
  expect(result.output).toMatch(/^[D-Z]:\\\s*$/mu);
  expect((await run("node -e \"process.exit(3)\"")).exitCode).toBe(3);
  expect((await run("Get-Item does-not-exist")).exitCode).toBe(1);
  const timings = [];
  for (let index = 0; index < 5; index++) timings.push((await run("Write-Output ok")).ms);
  expect(Math.min(...timings)).toBeLessThan(1_000);
}, 120_000);

it.runIf(live)("works with Git, Node scripts and npm, which walk their paths from the drive root", async () => {
  await writeFile(join(workspace, "script.cjs"), "console.log('script', require('fs').realpathSync('.'))");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", dependencies: { "is-number": "7.0.0" } }));
  const git = await run("git init -q; git add script.cjs; git status --short");
  expect(git.exitCode).toBe(0);
  expect(git.output).toContain("A  script.cjs");
  expect((await run("node script.cjs")).output).toMatch(/script [D-Z]:\\/u);
  const npm = await run("npm install --no-audit --no-fund; node -e \"console.log(require('is-number')(5))\"");
  expect(npm.exitCode).toBe(0);
  expect(npm.output).toContain("true");
}, 300_000);
