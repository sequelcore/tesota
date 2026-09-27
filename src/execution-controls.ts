import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CommandShell, EnvironmentGuarantees, ExecutionEnvironment, RunOptions, RunResult } from "./execution-environment.js";

/**
 * The controls an execution environment must pass before its guarantees are
 * believed (decisions 014 and 030): the same for every provider, run by the
 * live suites and, on the operator's own machine, by qualification. Each is a
 * small probe run inside the environment and judged from the host. File and
 * process probes are JavaScript for the environment's runtime, so no shell's
 * syntax is assumed; network probes use `curl`, which honors a sandbox's
 * proxy, where JavaScript's `fetch` ignores proxy variables.
 */

export type ControlName = "workspace_read_write" | "cancel_children" | "time_limit" | "outside_read" | "outside_write" |
  "host_variables" | "network_refused" | "registry_reachable";

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
}

export interface ControlResult {
  readonly control: ControlName;
  readonly passed: boolean;
  /** What was observed, for the operator and the test report. */
  readonly detail: string;
}

/** Every environment must work in its workspace and stop what it runs. */
const processControls: readonly ControlName[] = ["workspace_read_write", "cancel_children", "time_limit"];
/** A `workspace` filesystem keeps the operator's files and variables out of reach. */
const filesystemControls: readonly ControlName[] = ["outside_read", "outside_write", "host_variables"];
/** An `allowlist` network refuses what is not allowed and still reaches package registries. */
const networkControls: readonly ControlName[] = ["network_refused", "registry_reachable"];

/** The controls a provider's claimed guarantees call for. */
export function controlsFor(guarantees: EnvironmentGuarantees): ControlName[] {
  return [...processControls, ...guarantees.filesystem === "workspace" ? filesystemControls : [],
    ...guarantees.network === "allowlist" ? networkControls : []];
}

const quote = (value: string): string => `"${value}"`;

/**
 * A program and its arguments as the environment's shell runs them: quoted
 * words in a POSIX shell, and in PowerShell after `&`, which a quoted program
 * needs, with `curl.exe`, since PowerShell's `curl` is Invoke-WebRequest.
 */
function commandLine(shell: CommandShell, program: string, args: readonly string[]): string {
  if (shell === "posix") return [program, ...args].map(quote).join(" ");
  return `& ${[program === "curl" ? "curl.exe" : program, ...args].map(quote).join(" ")}`;
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
    return await inside(probe, commandLine(probe.environment.shell, probe.site.runtime, [name, ...args]), options);
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
    const run = await inside(probe, commandLine(probe.environment.shell, "curl", ["-sS", "-m", "15", "-o", body, "-w", "%{http_code}", url]));
    return /\b(\d{3})\s*$/u.exec(run.output.trim())?.[1] ?? "000";
  } finally { await rm(join(probe.site.workspace, body), { force: true }); }
}

async function networkRefused(probe: Probe): Promise<ControlResult> {
  const code = await status(probe, probe.site.refusedUrl);
  const passed = !/^[23]/u.test(code);
  return { control: "network_refused", passed, detail: passed ? `a destination that is not allowed was refused (${code})`
    : `a destination that is not allowed answered ${code}` };
}

async function registryReachable(probe: Probe): Promise<ControlResult> {
  const code = await status(probe, probe.site.registryUrl);
  const passed = code.startsWith("2");
  return { control: "registry_reachable", passed, detail: passed ? "the package registry answered" : `the package registry gave ${code}` };
}

const controls: Readonly<Record<ControlName, (probe: Probe) => Promise<ControlResult>>> = {
  workspace_read_write: workspaceReadWrite, cancel_children: cancelChildren, time_limit: timeLimit,
  outside_read: outsideRead, outside_write: outsideWrite, host_variables: hostVariables,
  network_refused: networkRefused, registry_reachable: registryReachable,
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
