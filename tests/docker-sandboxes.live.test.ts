import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dockerSandboxesProvider } from "../src/docker-sandboxes-environment.js";
import type { ExecutionEnvironment, RunResult } from "../src/execution-environment.js";

/**
 * Qualification controls for the Docker Sandboxes provider (decision 014).
 * They need a signed-in `sbx` with a deny-all global policy, so they run only
 * with TESOTA_LIVE_SANDBOX=1.
 */
const live = process.env["TESOTA_LIVE_SANDBOX"] === "1";
let root = "";
let workspace = "";
let sandbox: ExecutionEnvironment | undefined;

async function run(command: string, extra: { timeoutSeconds?: number; signal?: AbortSignal } = {}):
Promise<RunResult & { output: string }> {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  let output = "";
  const result = await sandbox.run(command, { cwd: workspace, onOutput: (chunk) => { output += chunk.toString(); }, ...extra });
  return { ...result, output };
}

beforeAll(async () => {
  if (!live) return;
  root = await mkdtemp(join(tmpdir(), "tesota-sandbox-live-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "hello.txt"), "inside\n");
  await writeFile(join(root, "outside.txt"), "OUTSIDE-SENTINEL\n");
  sandbox = await dockerSandboxesProvider.prepare(workspace);
}, 600_000);

afterAll(async () => {
  if (!live) return;
  await dockerSandboxesProvider.release(workspace);
  await rm(root, { recursive: true, force: true });
}, 120_000);

it.runIf(live)("reads and writes the workspace and nothing outside it", async () => {
  expect(await run("cat hello.txt")).toMatchObject({ outcome: "exited", exitCode: 0, output: expect.stringContaining("inside") });
  expect(await run("echo made > made.txt")).toMatchObject({ outcome: "exited", exitCode: 0 });
  expect(await readFile(join(workspace, "made.txt"), "utf8")).toBe("made\n");
  const read = await run("cat ../outside.txt");
  expect(read.exitCode).not.toBe(0);
  expect(read.output).not.toContain("OUTSIDE-SENTINEL");
  const write = await run("echo escaped > ../escaped.txt");
  expect(write.exitCode).not.toBe(0);
  expect(existsSync(join(root, "escaped.txt"))).toBe(false);
}, 120_000);

it.runIf(live)("reaches package registries and nothing else", async () => {
  const blocked = await run("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com/ || true");
  expect(blocked.output).not.toContain("200");
  const allowed = await run("curl -sS -m 20 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/");
  expect(allowed.output).toContain("200");
}, 120_000);

it.runIf(live)("passes only the variables it is given", async () => {
  let shown = "";
  const result = await sandbox?.run("echo \"probe=$TESOTA_PROBE\"", { cwd: workspace, env: { TESOTA_PROBE: "given" },
    onOutput: (chunk) => { shown += chunk.toString(); } });
  expect(result).toEqual({ outcome: "exited", exitCode: 0 });
  expect(shown).toContain("probe=given");
  const output = (await run("env | cut -d= -f1")).output;
  expect(output).not.toMatch(/^(PATHEXT|USERPROFILE|APPDATA)$/mu);
}, 120_000);

it.runIf(live)("stops a cancelled command and its children", async () => {
  const cancellation = new AbortController();
  const running = run("sh -c 'sleep 12; echo late > late.txt' & echo started > started.txt; wait",
    { signal: cancellation.signal });
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(workspace, "started.txt")) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 250));
  cancellation.abort();
  await expect(running).resolves.toMatchObject({ outcome: "cancelled", exitCode: null });
  await new Promise((wait) => setTimeout(wait, 15_000));
  expect(existsSync(join(workspace, "late.txt"))).toBe(false);
}, 120_000);

it.runIf(live)("stops a command that runs past its time limit", async () => {
  await expect(run("sleep 60", { timeoutSeconds: 3 })).resolves.toMatchObject({ outcome: "timed_out", exitCode: null });
}, 120_000);
