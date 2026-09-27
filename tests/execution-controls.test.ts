import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { controlsFor, runControls, type ControlSite } from "../src/execution-controls.js";
import type { EnvironmentGuarantees, ExecutionEnvironment } from "../src/execution-environment.js";
import { hostProvider } from "../src/host-environment.js";

/**
 * The execution controls (decision 030) judged against the host provider,
 * which confines nothing: the process controls must pass and every
 * confinement control must fail, or the controls could not tell a sandbox
 * from none. The network targets are a local server the host can reach.
 */
let root = "";
let site: ControlSite;
let server: Server;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tesota-controls-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  server = createServer((_request, response) => { response.end("reachable"); });
  await new Promise<void>((listening) => { server.listen(0, "127.0.0.1", listening); });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  site = { workspace, outside, runtime: process.execPath,
    refusedUrl: `http://127.0.0.1:${port}/refused`, registryUrl: `http://127.0.0.1:${port}/registry` };
}, 30_000);

afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const sandbox: EnvironmentGuarantees = { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" };

it("chooses the controls a provider's claimed guarantees call for", () => {
  expect(controlsFor(hostProvider.guarantees)).toEqual(["workspace_read_write", "cancel_children", "time_limit"]);
  expect(controlsFor(sandbox)).toEqual(["workspace_read_write", "cancel_children", "time_limit",
    "outside_read", "outside_write", "host_variables", "network_refused", "registry_reachable"]);
});

it("writes each probe in the environment's own shell", async () => {
  const commands: string[] = [];
  const powershell: ExecutionEnvironment = { provider: "fake", shell: "powershell", guarantees: sandbox, preparation: [],
    run: async (command) => { commands.push(command); return { outcome: "exited", exitCode: 0 }; }, dispose: async () => {} };
  await runControls(powershell, ["outside_read", "network_refused"], site, new AbortController().signal);
  // PowerShell runs a quoted program only through `&`, and its `curl` is an alias for Invoke-WebRequest.
  expect(commands[0]).toMatch(/^& ".+" "\.tesota-control-[^"]+\.cjs" "\.\.\/outside\/\.tesota-control-[^"]+\.txt"$/u);
  expect(commands[1]).toMatch(/^& "curl\.exe" "-sS"/u);
  expect(hostProvider.guarantees.filesystem).toBe("host");
  const host = await hostProvider.prepare(site.workspace);
  expect(host.shell).toBe("posix");
  await host.dispose();
});

it("passes the host on what every environment must do, and fails it on every confinement it lacks", async () => {
  const environment = await hostProvider.prepare(site.workspace);
  try {
    const results = await runControls(environment, controlsFor(sandbox), site, new AbortController().signal);
    const passed = Object.fromEntries(results.map((result) => [result.control, result.passed]));
    expect(passed).toEqual({ workspace_read_write: true, cancel_children: true, time_limit: true,
      outside_read: false, outside_write: false, host_variables: false, network_refused: false, registry_reachable: true });
    for (const result of results) expect(result.detail.length).toBeGreaterThan(0);
  } finally { await environment.dispose(); }
}, 120_000);
