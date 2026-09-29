import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import type { EnvironmentGuarantees, ExecutionEnvironment, RunOptions, RunResult } from "./execution-environment.js";
import { directConnection } from "./verification/direct-connection-rule.js";

/**
 * The controls an execution environment must pass before its guarantees are
 * believed (decisions 014 and 030): the same for every provider, run by the
 * live suites and, on the operator's own machine, by qualification. Each is a
 * small probe run inside the environment and judged from the host. File and
 * process probes are JavaScript for the environment's runtime, so no shell's
 * syntax is assumed; network probes use `curl`, which honors a sandbox's
 * proxy, where JavaScript's `fetch` ignores proxy variables, and one probe
 * ignores the proxy on purpose: setting proxy variables confines nothing.
 */

export type ControlName = "workspace_read_write" | "cancel_children" | "time_limit" | "package_script" | "outside_read" |
  "outside_write" | "beside_read" | "host_variables" | "network_refused" | "network_direct" | "registry_reachable" |
  "setup_hosts_closed";

/** Where the controls run: a workspace to probe from, a directory outside it, and what to probe with. */
export interface ControlSite {
  /** The workspace the environment was prepared for; probes are written here and removed. */
  readonly workspace: string;
  /** A host directory outside the workspace, which a confined environment can neither read nor write. */
  readonly outside: string;
  /** The program that runs JavaScript inside the environment, such as `node` or the host's own runtime. */
  readonly runtime: string;
  /** A destination a confined network refuses. */
  readonly refusedUrl: string;
  /** A package registry a confined network still allows. */
  readonly registryUrl: string;
  /** A host toolchains download from, which a confined network opens only while setup runs. */
  readonly setupUrl: string;
}

export interface ControlResult {
  readonly control: ControlName;
  readonly passed: boolean;
  /** What was observed, for the operator and the test report. */
  readonly detail: string;
}

/**
 * Every environment must work in its workspace, run the workspace's package
 * scripts from its root, as checks do, and stop what it runs.
 */
export const PROCESS_CONTROLS: readonly ControlName[] = ["workspace_read_write", "package_script", "cancel_children", "time_limit"];
/**
 * A `workspace` filesystem keeps the operator's files and variables out of
 * reach, and what lies beside the workspace, such as Tesota's records of it.
 */
export const FILESYSTEM_CONTROLS: readonly ControlName[] = ["outside_read", "outside_write", "beside_read", "host_variables"];
/**
 * An `allowlist` network refuses what is not allowed, even to a client that
 * ignores the proxy and connects to the destination's address itself, still
 * reaches package registries, and closes setup's download hosts once setup
 * ends (decision 048).
 */
export const NETWORK_CONTROLS: readonly ControlName[] = ["network_refused", "network_direct", "registry_reachable", "setup_hosts_closed"];

/** The controls a provider's claimed guarantees call for. */
export function controlsFor(guarantees: EnvironmentGuarantees): ControlName[] {
  return [...PROCESS_CONTROLS, ...guarantees.filesystem === "workspace" ? FILESYSTEM_CONTROLS : [],
    ...guarantees.network === "allowlist" ? NETWORK_CONTROLS : []];
}

const quote = (value: string): string => `"${value}"`;

/** A program and its arguments as quoted words for the environment's POSIX shell. */
function commandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quote).join(" ");
}

/**
 * A host path as a probe inside the environment names it: relative to the
 * workspace, with forward slashes, so the same argument means the same place
 * in a Linux virtual machine that mounts the workspace and on the host itself.
 */
function fromWorkspace(site: ControlSite, path: string): string {
  return relative(site.workspace, path).split(sep).join("/");
}
const cancelWaitMs = 10_000;

interface Probe {
  readonly site: ControlSite;
  readonly environment: ExecutionEnvironment;
  readonly signal: AbortSignal;
}

/** Run one command in the environment from the workspace, collecting its output. */
async function inside(probe: Probe, command: string, options: Partial<Pick<RunOptions, "env" | "timeoutSeconds" | "signal">> = {}):
  Promise<RunResult & { output: string }> {
  let output = "";
  const result = await probe.environment.run(command, { cwd: probe.site.workspace, signal: options.signal ?? probe.signal,
    onOutput: (chunk) => { output += chunk.toString(); },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }) });
  return { ...result, output };
}

/** Write a JavaScript probe into the workspace, run it with the site's runtime, and remove it. */
async function script(probe: Probe, source: string, args: readonly string[],
  options: Partial<Pick<RunOptions, "env" | "timeoutSeconds" | "signal">> = {}): Promise<RunResult & { output: string }> {
  const name = `.tesota-control-${randomUUID()}.cjs`;
  await writeFile(join(probe.site.workspace, name), source, "utf8");
  try {
    return await inside(probe, commandLine(probe.site.runtime, [name, ...args]), options);
  } finally { await rm(join(probe.site.workspace, name), { force: true }); }
}

async function workspaceReadWrite(probe: Probe): Promise<ControlResult> {
  const token = randomUUID();
  await writeFile(join(probe.site.workspace, ".tesota-control-inside.txt"), token, "utf8");
  const made = join(probe.site.workspace, ".tesota-control-made.txt");
  try {
    const run = await script(probe, "const fs = require('node:fs');\n" +
      "process.stdout.write(fs.readFileSync('.tesota-control-inside.txt', 'utf8'));\n" +
      "fs.writeFileSync('.tesota-control-made.txt', process.argv[2]);\n", [token]);
    const written = existsSync(made) ? await readFile(made, "utf8") : "";
    const passed = run.exitCode === 0 && run.output.includes(token) && written === token;
    return { control: "workspace_read_write", passed, detail: passed ? "read and wrote the workspace"
      : `exit ${run.exitCode}; read ${run.output.includes(token) ? "yes" : "no"}; wrote ${written === token ? "yes" : "no"}` };
  } finally {
    await rm(made, { force: true });
    await rm(join(probe.site.workspace, ".tesota-control-inside.txt"), { force: true });
  }
}

async function outsideRead(probe: Probe): Promise<ControlResult> {
  const token = randomUUID();
  const sentinel = join(probe.site.outside, `.tesota-control-${token}.txt`);
  await writeFile(sentinel, token, "utf8");
  try {
    const run = await script(probe, "try { process.stdout.write(require('node:fs').readFileSync(process.argv[2], 'utf8')); }\n" +
      "catch (error) { process.stdout.write('refused ' + error.code); }\n", [fromWorkspace(probe.site, sentinel)]);
    const passed = !run.output.includes(token);
    return { control: "outside_read", passed, detail: passed ? `a file outside the workspace was not read (${run.output.trim()})`
      : "a file outside the workspace was read" };
  } finally { await rm(sentinel, { force: true }); }
}

/**
 * A package script run from the workspace's root with Bun, which every
 * environment carries and which runs Tesota's own checks; a script runner
 * that fails there fails every check.
 */
async function packageScript(probe: Probe): Promise<ControlResult> {
  const manifest = join(probe.site.workspace, "package.json");
  if (existsSync(manifest)) return { control: "package_script", passed: false, detail: "the workspace already has a package.json" };
  const token = randomUUID();
  await writeFile(manifest, JSON.stringify({ name: "tesota-control", private: true, scripts: { control: `echo ${token}` } }), "utf8");
  try {
    const run = await inside(probe, commandLine("bun", ["run", "control"]));
    const passed = run.exitCode === 0 && run.output.includes(token);
    return { control: "package_script", passed, detail: passed ? "a package script ran from the workspace's root"
      : `exit ${run.exitCode}: ${run.output.trim().split(/\r?\n/u).at(-1) ?? ""}` };
  } finally { await rm(manifest, { force: true }); }
}

/** A file beside the workspace, in the folder that holds it, where Tesota keeps its records of a session. */
async function besideRead(probe: Probe): Promise<ControlResult> {
  const token = randomUUID();
  const sentinel = join(dirname(probe.site.workspace), `.tesota-control-${token}.txt`);
  await writeFile(sentinel, token, "utf8");
  try {
    const run = await script(probe, "try { process.stdout.write(require('node:fs').readFileSync(process.argv[2], 'utf8')); }\n" +
      "catch (error) { process.stdout.write('refused ' + error.code); }\n", [fromWorkspace(probe.site, sentinel)]);
    const passed = !run.output.includes(token);
    return { control: "beside_read", passed, detail: passed ? `a file beside the workspace was not read (${run.output.trim()})`
      : "a file beside the workspace was read" };
  } finally { await rm(sentinel, { force: true }); }
}

async function outsideWrite(probe: Probe): Promise<ControlResult> {
  const escaped = join(probe.site.outside, `.tesota-control-${randomUUID()}.txt`);
  try {
    const run = await script(probe, "try { require('node:fs').writeFileSync(process.argv[2], 'escaped'); process.stdout.write('wrote'); }\n" +
      "catch (error) { process.stdout.write('refused ' + error.code); }\n", [fromWorkspace(probe.site, escaped)]);
    const passed = !existsSync(escaped);
    return { control: "outside_write", passed, detail: passed ? `nothing was written outside the workspace (${run.output.trim()})`
      : "a file was written outside the workspace" };
  } finally { await rm(escaped, { force: true }); }
}

async function hostVariables(probe: Probe): Promise<ControlResult> {
  const [hostOnly, given] = [randomUUID(), randomUUID()];
  const previous = process.env["TESOTA_CONTROL_HOST_ONLY"];
  process.env["TESOTA_CONTROL_HOST_ONLY"] = hostOnly;
  try {
    const run = await script(probe, "process.stdout.write(`given=${process.env.TESOTA_CONTROL_GIVEN} host=${process.env.TESOTA_CONTROL_HOST_ONLY}`);\n",
      [], { env: { TESOTA_CONTROL_GIVEN: given } });
    const passed = run.output.includes(given) && !run.output.includes(hostOnly);
    return { control: "host_variables", passed, detail: passed ? "only the variables it was given reached the command"
      : run.output.includes(hostOnly) ? "a variable of the host's reached the command" : "a given variable did not reach the command" };
  } finally {
    if (previous === undefined) delete process.env["TESOTA_CONTROL_HOST_ONLY"]; else process.env["TESOTA_CONTROL_HOST_ONLY"] = previous;
  }
}

async function cancelChildren(probe: Probe): Promise<ControlResult> {
  const token = randomUUID();
  const [started, late] = [join(probe.site.workspace, `.tesota-control-started-${token}`),
    join(probe.site.workspace, `.tesota-control-late-${token}`)];
  const cancellation = new AbortController();
  try {
    const running = script(probe, "const { spawn } = require('node:child_process');\n" +
      "spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(process.argv[3])}, 'late'), 8000)`], { stdio: 'ignore' });\n" +
      "require('node:fs').writeFileSync(process.argv[2], 'started');\nsetInterval(() => {}, 1000);\n",
      [fromWorkspace(probe.site, started), fromWorkspace(probe.site, late)],
      { signal: AbortSignal.any([probe.signal, cancellation.signal]) });
    const deadline = Date.now() + 30_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 200));
    cancellation.abort();
    const result = await running;
    await new Promise((wait) => setTimeout(wait, cancelWaitMs));
    const passed = result.outcome === "cancelled" && !existsSync(late);
    return { control: "cancel_children", passed, detail: passed ? "a cancelled command and its child stopped"
      : `outcome ${result.outcome}; the child ${existsSync(late) ? "kept running" : "stopped"}` };
  } finally {
    await rm(started, { force: true });
    await rm(late, { force: true });
  }
}

async function timeLimit(probe: Probe): Promise<ControlResult> {
  const run = await script(probe, "setTimeout(() => {}, 60000);\n", [], { timeoutSeconds: 3 });
  const passed = run.outcome === "timed_out";
  return { control: "time_limit", passed, detail: passed ? "a command past its time limit stopped" : `outcome ${run.outcome}` };
}

/** Fetch a URL with curl inside the environment and report the HTTP status it saw, or 000 when none. */
async function status(probe: Probe, url: string): Promise<string> {
  const body = `.tesota-control-body-${randomUUID()}`;
  try {
    const run = await inside(probe, commandLine("curl", ["-sS", "-m", "15", "-o", body, "-w", "%{http_code}", url]));
    return /\b(\d{3})\s*$/u.exec(run.output.trim())?.[1] ?? "000";
  } finally { await rm(join(probe.site.workspace, body), { force: true }); }
}

async function networkRefused(probe: Probe): Promise<ControlResult> {
  const code = await status(probe, probe.site.refusedUrl);
  const passed = !/^[23]/u.test(code);
  return { control: "network_refused", passed, detail: passed ? `a destination that is not allowed was refused (${code})`
    : `a destination that is not allowed answered ${code}` };
}

/** Errors with which a connection is refused on the way out, rather than by a program that received it. */
const REFUSALS = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ETIMEDOUT", "EACCES", "EPERM"]);
const DIRECT_TIMEOUT_MS = 10_000;

/** Whether this computer opens a TCP connection to the address itself. */
function connectsFromHost(address: string, port: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = connectTcp({ host: address, port, timeout: DIRECT_TIMEOUT_MS });
    const end = (connected: boolean): void => { socket.destroy(); settle(connected); };
    socket.once("connect", () => { end(true); });
    socket.once("timeout", () => { end(false); });
    socket.once("error", () => { end(false); });
  });
}

/**
 * Open a TCP connection to the refused destination's address directly, as a
 * program that ignores proxy variables or opens its own sockets would, and
 * judge it with `directConnection` (proved): a connection that opened fails
 * the control whatever happened after, and a refusal passes only when this
 * computer connected to the same address itself. The address is resolved on
 * the host, so a sandbox without a resolver cannot pass by failing to look the
 * name up.
 */
async function networkDirect(probe: Probe): Promise<ControlResult> {
  const url = new URL(probe.site.refusedUrl);
  const host = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  const address = await lookup(host).then((found) => found.address, () => undefined);
  if (address === undefined) return { control: "network_direct", passed: false, detail: `${host} could not be resolved on this computer` };
  const port = url.port === "" ? url.protocol === "https:" ? 443 : 80 : Number(url.port);
  const run = await script(probe, "const [, , host, port] = process.argv;\n" +
    `const socket = require('node:net').connect({ host, port: Number(port), timeout: ${DIRECT_TIMEOUT_MS} });\n` +
    "const report = (text) => { process.stdout.write(`tesota-direct ${text}\\n`); socket.destroy(); };\n" +
    "socket.once('connect', () => { report('connected'); });\n" +
    "socket.once('timeout', () => { report('refused ETIMEDOUT'); });\n" +
    "socket.once('error', (error) => { report(`refused ${error.code ?? 'unknown'}`); });\n", [address, String(port)]);
  const connectedInside = /^tesota-direct connected$/mu.test(run.output);
  const refusal = /^tesota-direct refused (\S+)$/mu.exec(run.output)?.[1];
  const refusedInside = refusal !== undefined && REFUSALS.has(refusal);
  const connectedFromHost = !connectedInside && refusedInside && await connectsFromHost(address, port);
  const verdict = directConnection(connectedInside, refusedInside, connectedFromHost);
  const target = `${host} (${address}:${port})`;
  const detail = verdict === "connected" ? `a client ignoring the proxy connected to ${target} directly`
    : verdict === "blocked" ? `a client ignoring the proxy could not connect to ${target} (${refusal ?? ""}), which this computer reaches`
    : !refusedInside ? `a client ignoring the proxy gave no result for ${target} (${run.output.trim().slice(-200) || `outcome ${run.outcome}`})`
    : `${target} refused a client ignoring the proxy (${refusal ?? ""}), but this computer cannot connect to it either, so nothing was shown`;
  return { control: "network_direct", passed: verdict === "blocked", detail };
}

/** Where the control workspace's setup script records what it reached. */
const SETUP_EVIDENCE = ".tesota-control-setup.txt";

/**
 * Give a control workspace, before its environment is prepared, a setup
 * script that fetches the setup URL and records the HTTP status it saw, so
 * `setup_hosts_closed` finds setup's hosts opened and can show them closed.
 */
export async function writeSetupProbe(workspace: string, setupUrl: string): Promise<void> {
  await mkdir(join(workspace, ".tesota"), { recursive: true });
  await writeFile(join(workspace, ".tesota", "setup.sh"),
    `curl -sS -m 15 -o /dev/null -w '%{http_code}' ${quote(setupUrl)} > ${SETUP_EVIDENCE}\n`, "utf8");
}

/**
 * Setup's download hosts are open only while setup runs: the workspace's
 * setup script reached the setup URL, and a command after it cannot. Without
 * the first, nothing was opened, so nothing is shown closed.
 */
async function setupHostsClosed(probe: Probe): Promise<ControlResult> {
  const evidence = join(probe.site.workspace, SETUP_EVIDENCE);
  const during = existsSync(evidence) ? (await readFile(evidence, "utf8")).trim() || "000" : "no result";
  await rm(evidence, { force: true });
  const after = await status(probe, probe.site.setupUrl);
  const [reached, closed] = [/^[23]/u.test(during), !/^[23]/u.test(after)];
  const host = new URL(probe.site.setupUrl).host;
  const detail = !reached ? `setup did not reach ${host} (${during}), so its closing was not shown`
    : closed ? `setup reached ${host} (${during}) and a command after it was refused (${after})`
    : `a command after setup reached ${host} (${after})`;
  return { control: "setup_hosts_closed", passed: reached && closed, detail };
}

async function registryReachable(probe: Probe): Promise<ControlResult> {
  const code = await status(probe, probe.site.registryUrl);
  const passed = code.startsWith("2");
  return { control: "registry_reachable", passed, detail: passed ? "the package registry answered" : `the package registry gave ${code}` };
}

const controls: Readonly<Record<ControlName, (probe: Probe) => Promise<ControlResult>>> = {
  workspace_read_write: workspaceReadWrite, package_script: packageScript, cancel_children: cancelChildren, time_limit: timeLimit,
  outside_read: outsideRead, outside_write: outsideWrite, beside_read: besideRead, host_variables: hostVariables,
  network_refused: networkRefused, network_direct: networkDirect, registry_reachable: registryReachable,
  setup_hosts_closed: setupHostsClosed,
};

/** Run the named controls one after another in an environment, stopping early only when the caller cancels. */
export async function runControls(environment: ExecutionEnvironment, names: readonly ControlName[], site: ControlSite,
  signal: AbortSignal): Promise<ControlResult[]> {
  const results: ControlResult[] = [];
  for (const name of names) {
    if (signal.aborted) break;
    results.push(await controls[name]({ site, environment, signal }).catch((error: unknown): ControlResult =>
      ({ control: name, passed: false, detail: error instanceof Error ? error.message : "the control could not run" })));
  }
  return results;
}
