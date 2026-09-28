import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
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
  expect(controlsFor(hostProvider.guarantees)).toEqual(["workspace_read_write", "package_script", "cancel_children", "time_limit"]);
  expect(controlsFor(sandbox)).toEqual(["workspace_read_write", "package_script", "cancel_children", "time_limit",
    "outside_read", "outside_write", "beside_read", "host_variables", "network_refused", "network_direct", "registry_reachable"]);
});

it("writes each probe in the environment's own shell", async () => {
  const commands: string[] = [];
  const powershell: ExecutionEnvironment = { provider: "fake", shell: "powershell", guarantees: sandbox, preparation: [],
    run: async (command) => { commands.push(command); return { outcome: "exited", exitCode: 0 }; }, dispose: async () => {} };
  await runControls(powershell, ["outside_read", "network_refused"], site, new AbortController().signal);
  // PowerShell runs a quoted program only through `&`, and its `curl` is an alias for Invoke-WebRequest.
  expect(commands[0]).toMatch(/^& ".+" "\.tesota-control-[^"]+\.cjs" "\.\.\/outside\/\.tesota-control-[^"]+\.txt"$/u);
  // Windows' own TLS checks revocation online, which a sandbox's allowlist does not reach; the control checks the network.
  expect(commands[1]).toMatch(/^& "curl\.exe" "--ssl-no-revoke" "-sS"/u);
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
    expect(passed).toEqual({ workspace_read_write: true, package_script: true, cancel_children: true, time_limit: true,
      outside_read: false, outside_write: false, beside_read: false, host_variables: false, network_refused: false,
      network_direct: false, registry_reachable: true });
    for (const result of results) expect(result.detail.length).toBeGreaterThan(0);
  } finally { await environment.dispose(); }
}, 120_000);

/** A server that takes a connection and whatever is sent, and closes it without an answer. */
async function silentServer(): Promise<{ url: string; received: () => string; close: () => void }> {
  let received = "";
  const silent = createNetServer((socket) => { socket.on("data", (chunk) => { received += chunk.toString(); socket.end(); }); });
  await new Promise<void>((listening) => { silent.listen(0, "127.0.0.1", listening); });
  const address = silent.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, received: () => received, close: () => { silent.close(); } };
}

/** An environment that answers every command with the probe's report, without running it. */
function reporting(report: string): ExecutionEnvironment {
  return { provider: "fake", shell: "posix", guarantees: sandbox, preparation: [], dispose: async () => {},
    run: async (_command, options) => { options.onOutput(Buffer.from(`${report}\n`)); return { outcome: "exited", exitCode: 0 }; } };
}

it("fails a connection that opened, even when the destination never answered", async () => {
  const silent = await silentServer();
  const environment = await hostProvider.prepare(site.workspace);
  try {
    const [result] = await runControls(environment, ["network_direct"], { ...site, refusedUrl: silent.url }, new AbortController().signal);
    expect(result).toMatchObject({ control: "network_direct", passed: false });
    expect(result?.detail).toContain("connected to 127.0.0.1");
  } finally { silent.close(); await environment.dispose(); }
}, 60_000);

it("passes a refusal only when this computer reaches the same address, and shows nothing otherwise", async () => {
  const silent = await silentServer();
  try {
    const refused = { ...site, refusedUrl: silent.url };
    const [blocked] = await runControls(reporting("tesota-direct refused ENETUNREACH"), ["network_direct"], refused, new AbortController().signal);
    expect(blocked).toMatchObject({ passed: true });
    const [unknown] = await runControls(reporting("tesota-direct refused EINVAL"), ["network_direct"], refused, new AbortController().signal);
    expect(unknown).toMatchObject({ passed: false });
    const [silentRun] = await runControls(reporting(""), ["network_direct"], refused, new AbortController().signal);
    expect(silentRun?.detail).toContain("gave no result");
  } finally { silent.close(); }
  // A destination this computer cannot reach either: a refusal inside proves nothing.
  const closed = await silentServer();
  closed.close();
  await new Promise((wait) => setTimeout(wait, 100));
  const [nothing] = await runControls(reporting("tesota-direct refused ECONNREFUSED"), ["network_direct"],
    { ...site, refusedUrl: closed.url }, new AbortController().signal);
  expect(nothing).toMatchObject({ passed: false });
  expect(nothing?.detail).toContain("cannot connect to it either");
}, 60_000);
