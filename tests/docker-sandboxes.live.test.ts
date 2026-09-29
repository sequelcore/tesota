import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dockerSandboxesProvider } from "../src/docker-sandboxes-environment.js";
import { controlsFor, NETWORK_CONTROLS, runControls } from "../src/execution-controls.js";
import type { ExecutionEnvironment, RunResult } from "../src/execution-environment.js";

/**
 * Docker Sandboxes against the execution controls every provider must pass
 * (decisions 014 and 030), then what only a virtual machine with a root user
 * and its own disk must also show. They need a signed-in `sbx` with a deny-all
 * global policy, so they run only with TESOTA_LIVE_SANDBOX=1.
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
  await writeFile(join(workspace, "package.json"), "{}\n");
  await writeFile(join(root, "outside.txt"), "OUTSIDE-SENTINEL\n");
  await mkdir(join(root, "outside"));
  sandbox = await dockerSandboxesProvider.prepare(workspace);
}, 600_000);

afterAll(async () => {
  if (!live) return;
  await dockerSandboxesProvider.release(workspace);
  await rm(root, { recursive: true, force: true });
}, 120_000);

it.runIf(live)("passes every control its guarantees call for", async () => {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  const results = await runControls(sandbox, controlsFor(dockerSandboxesProvider.guarantees), { workspace,
    outside: join(root, "outside"), runtime: "node", refusedUrl: "https://example.com/", registryUrl: "https://registry.npmjs.org/" },
  new AbortController().signal);
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(results.map((result) => result.control)).toEqual(controlsFor(dockerSandboxesProvider.guarantees));
}, 300_000);

it.runIf(live)("refuses and allows through its proxy, and reports what a client ignoring the proxy opened (decision 044)", async () => {
  if (sandbox === undefined) throw new Error("Sandbox unavailable");
  const results = await runControls(sandbox, NETWORK_CONTROLS, { workspace, outside: join(root, "outside"), runtime: "node",
    refusedUrl: "https://example.com/", registryUrl: "https://registry.npmjs.org/" }, new AbortController().signal);
  expect(results.filter((result) => result.control !== "network_direct" && !result.passed)).toEqual([]);
  // The network is declared open until what a refused direct connection receives is known; this is the evidence to watch.
  process.stdout.write(`Docker Sandboxes network_direct: ${results.find((result) => result.control === "network_direct")?.detail ?? "not run"}\n`);
}, 300_000);

it.runIf(live)("confines root inside the sandbox the same way", async () => {
  expect((await run("sudo -n id -u")).output.trim()).toBe("0");
  const read = await run("sudo -n cat ../outside.txt");
  expect(read.exitCode).not.toBe(0);
  expect(read.output).not.toContain("OUTSIDE-SENTINEL");
  // Root can write the VM's copy of the parent directory; the host's must stay untouched.
  await run("sudo -n sh -c 'echo escaped > ../escaped.txt'");
  expect(existsSync(join(root, "escaped.txt"))).toBe(false);
  const blocked = await run("sudo -n curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com/ || true");
  expect(blocked.output).not.toContain("200");
}, 120_000);

it.runIf(live)("keeps node_modules on the sandbox's own disk", async () => {
  expect(await run("echo kept > node_modules/probe.txt && cat node_modules/probe.txt"))
    .toMatchObject({ outcome: "exited", exitCode: 0, output: expect.stringContaining("kept") });
  expect(existsSync(join(workspace, "node_modules", "probe.txt"))).toBe(false);
}, 120_000);

it.runIf(live)("reports with each command what the network refused during it, and opens only what is allowed", async () => {
  const refused = await run("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com/ || true");
  expect(refused.output).not.toContain("200");
  expect(refused.refused).toContain("example.com:443");
  await sandbox?.network?.allow(["example.com:443"]);
  expect((await run("curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com/")).output).toContain("200");
  expect((await run("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.org/ || true")).output).not.toContain("200");
}, 120_000);

it.runIf(live)("keeps the host's own variables out, the Windows ones included", async () => {
  const output = (await run("env | cut -d= -f1")).output;
  expect(output).not.toMatch(/^(PATHEXT|USERPROFILE|APPDATA)$/mu);
}, 120_000);
