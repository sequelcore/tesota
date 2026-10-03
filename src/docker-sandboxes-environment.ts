import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { windowsPowerShell } from "./windows-system.js";
import { type EnvironmentGuarantees, type ExecutionEnvironment, type ExecutionProvider, isNetworkDestination,
  type NetworkControl, PACKAGE_REGISTRY_HOSTS, type PrepareOptions, type PreparationStep, type ProviderReadiness, type RunOptions,
  type RunResult, type SetupStep } from "./execution-environment.js";
import { DEPENDENCIES_ARGUMENT, KIT_RUNTIMES, kitRuntimes, writeToolchainKit } from "./docker-sandboxes-kit.js";
import { type MiseUse, needsDownloadHosts, needsSetup, planToolchain, setupStages, TOOLCHAIN_HOSTS,
  type ToolchainPlan } from "./toolchain.js";

/**
 * Commands run in a Docker Sandboxes microVM per workspace. Only the workspace
 * is mounted, egress goes through the host proxy under a deny-all policy with
 * per-sandbox allow rules, and CPU and memory are capped. These guarantees were
 * observed on 2026-09-26 (decision 014); the live qualification suite reruns them.
 * The network is not declared an allowlist while `network_direct` sees a TCP
 * connection that ignores the proxy open (decision 044): Docker documents a
 * transparent proxy that allows a connection only when a rule matches, but
 * not what a refused connection receives, so the control cannot tell the
 * proxy from the destination. Until that is shown, its commands ask first.
 */
const guarantees: EnvironmentGuarantees = Object.freeze({
  filesystem: "workspace", network: "open", secrets: "none", resources: "bounded",
});

const commandTimeoutMs = 120_000;
const daemonStartMs = 30_000;
const stopAttempts = 3;

interface Invocation { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/**
 * Whether `sbx policy check network <host>` shows the global policy denying a
 * host that no rule names, which is what a deny-all policy does. It is read
 * from the decision, not from how `sbx policy ls` lists policies, which
 * changes between versions.
 */
export function deniesByDefault(check: Invocation): boolean {
  return /^Denied:/mu.test(check.stdout) && /\(default deny\)/u.test(check.stdout);
}

function invoke(executable: string, args: readonly string[], timeoutMs: number = commandTimeoutMs): Promise<Invocation> {
  return new Promise((resolveInvocation) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); resolveInvocation({ status: null, stdout, stderr: error.message }); });
    child.once("close", (status) => { clearTimeout(timer); resolveInvocation({ status, stdout, stderr }); });
  });
}

/** The `sbx` executable on PATH, or where its Windows installer puts it. */
async function locateSbx(): Promise<string | null> {
  const lookup = await invoke(process.platform === "win32" ? "where.exe" : "which", ["sbx"], 10_000);
  const found = lookup.status === 0 ? lookup.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() : undefined;
  if (found !== undefined) return found;
  const installed = join(process.env["LOCALAPPDATA"] ?? "", "DockerSandboxes", "bin", "sbx.exe");
  return process.platform === "win32" && existsSync(installed) ? installed : null;
}

async function hypervisorPlatformEnabled(): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const query = await invoke(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-CimInstance -ClassName Win32_OptionalFeature -Filter \"Name='HypervisorPlatform'\").InstallState"], 30_000);
  return query.status === 0 && query.stdout.trim() === "1";
}

/** Start the daemon in the background when it is not running, and wait until it answers. */
async function ensureDaemon(sbx: string): Promise<boolean> {
  const running = async (): Promise<boolean> => /Status:\s*running/u.test((await invoke(sbx, ["daemon", "status"], 15_000)).stdout);
  if (await running()) return true;
  const daemon = spawn(sbx, ["daemon", "start"], { detached: true, windowsHide: true, stdio: "ignore" });
  daemon.once("error", () => {});
  daemon.unref();
  const deadline = Date.now() + daemonStartMs;
  while (Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 500));
    if (await running()) return true;
  }
  return false;
}

/** Git Bash form used inside the VM: `C:\Users\x` becomes `/c/Users/x`. */
export function sandboxPath(hostPath: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(hostPath);
  if (drive === null) return hostPath.replaceAll("\\", "/");
  return `/${(drive[1] ?? "").toLowerCase()}/${(drive[2] ?? "").replaceAll("\\", "/")}`;
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

/** Every sandbox of a workspace starts with this; the suffix names its toolchain. */
function sandboxPrefix(workspace: string): string {
  return `tesota-${createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 12)}-`;
}

function listedSandboxes(listing: string): string[] {
  return listing.split(/\r?\n/u).map((line) => line.split(/\s+/u)[0] ?? "").filter((name) => name.length > 0);
}

/** Kill every process tagged with this run and report whether any remain. */
function stopScript(tag: string): string {
  const scan = `for p in /proc/[0-9]*; do if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx '${tag}'; then`;
  return `${scan} kill -KILL "\${p#/proc/}" 2>/dev/null; fi; done; sleep 0.2; ` +
    `left=0; ${scan} left=1; fi; done; echo "remaining=$left"`;
}

async function stopRun(sbx: string, name: string, tag: string): Promise<boolean> {
  for (let attempt = 0; attempt < stopAttempts; attempt++) {
    const result = await invoke(sbx, ["exec", name, "sh", "-c", stopScript(tag)], 30_000);
    if (result.status === 0 && result.stdout.includes("remaining=0")) return true;
  }
  return false;
}

function variableFlags(variables: Readonly<Record<string, string>>): string[] {
  return Object.entries(variables).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

const logSlackMs = 2_000;
const policyLogSchema = z.object({ blocked_hosts: z.array(z.object({
  host: z.string(), vm_name: z.string(), last_seen: z.string() })).nullish() });

/** Destinations `sbx policy log --json` reports as refused for this sandbox at or after a time. */
export function blockedDestinations(log: string, sandbox: string, since: Date): string[] {
  const entries = policyLogSchema.parse(JSON.parse(log)).blocked_hosts ?? [];
  return [...new Set(entries.filter((entry) => entry.vm_name === sandbox && isNetworkDestination(entry.host) &&
    Date.parse(entry.last_seen) >= since.getTime()).map((entry) => entry.host))];
}

/** What the sandbox's proxy refused since a command started, from its log. */
async function refusedSince(sbx: string, name: string, started: Date): Promise<string[]> {
  const log = await invoke(sbx, ["policy", "log", name, "--json"]);
  if (log.status !== 0) throw new Error(`The sandbox's network log is unavailable: ${log.stderr.trim().slice(-300)}`);
  // An entry can land in the log after the command that caused it ended, stamped slightly earlier.
  return blockedDestinations(log.stdout, name, new Date(started.getTime() - logSlackMs));
}

function sandboxNetwork(sbx: string, name: string): NetworkControl {
  return {
    async allow(destinations) {
      if (destinations.length === 0) return;
      if (!destinations.every(isNetworkDestination)) throw new Error("Only host:port destinations can be allowed");
      const result = await invoke(sbx, ["policy", "allow", "network", "--sandbox", name, destinations.join(",")]);
      if (result.status !== 0) throw new Error(`The sandbox did not accept the rule: ${`${result.stdout}${result.stderr}`.trim().slice(-300)}`);
    },
  };
}

function sandboxEnvironment(sbx: string, name: string, workspace: string, prepared: PreparedToolchain): ExecutionEnvironment {
  return {
    provider: "docker-sandboxes",
    guarantees,
    preparation: prepared.steps,
    network: sandboxNetwork(sbx, name),
    async run(command: string, options: RunOptions): Promise<RunResult> {
      // The sandbox's virtual machine syncs the workspace alone; no other folder can stand in its place.
      if (!contains(workspace, resolve(options.cwd)) || options.root !== undefined) return { outcome: "not_started", exitCode: null };
      if (options.signal?.aborted === true) return { outcome: "cancelled", exitCode: null };
      const tag = `TESOTA_RUN=${randomUUID()}`;
      const started = new Date();
      const variables = variableFlags({ ...prepared.variables, ...options.env });
      const child = spawn(sbx, ["exec", "-w", sandboxPath(resolve(options.cwd)), "-e", tag, ...variables, name, "sh", "-c", command],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", options.onOutput);
      child.stderr.on("data", options.onOutput);
      let stopping: "timed_out" | "cancelled" | undefined;
      let stopped: Promise<boolean> | undefined;
      const stop = (reason: "timed_out" | "cancelled"): void => {
        if (stopping !== undefined) return;
        stopping = reason;
        stopped = stopRun(sbx, name, tag).finally(() => { child.kill(); });
      };
      const timer = options.timeoutSeconds === undefined ? undefined
        : setTimeout(() => { stop("timed_out"); }, options.timeoutSeconds * 1000);
      const abort = (): void => { stop("cancelled"); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const exit = await new Promise<number | null | "error">((settle) => {
        child.once("error", () => { settle("error"); });
        child.once("close", (status) => { settle(status); });
      });
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (stopping === "timed_out" && await stopped) {
        return { outcome: "timed_out", exitCode: null, refused: await refusedSince(sbx, name, started) };
      }
      if (stopping !== undefined) return { outcome: await stopped ? stopping : "unconfirmed", exitCode: null };
      if (exit === "error") return { outcome: "not_started", exitCode: null };
      return { outcome: "exited", exitCode: exit ?? 1, refused: await refusedSince(sbx, name, started) };
    },
    dispose: async () => {},
  };
}

interface PreparedToolchain {
  readonly steps: readonly PreparationStep[];
  /** Variables every command needs, such as the PATH that puts the installed runtimes first. */
  readonly variables: Readonly<Record<string, string>>;
}

const setupStepMs = 15 * 60_000;
const outputTail = 4 * 1024;
const setupMarker = "$HOME/.tesota-setup";

function execScript(sbx: string, name: string, cwd: string, script: string, variables: Readonly<Record<string, string>>,
  timeoutMs: number = commandTimeoutMs): Promise<Invocation> {
  return invoke(sbx, ["exec", "-w", cwd, ...variableFlags(variables), name, "sh", "-c", script], timeoutMs);
}

/** Close the setup-only hosts; true only when the sandbox's rule list no longer allows any of them. */
async function closeToolchainHosts(sbx: string, name: string): Promise<boolean> {
  for (const host of TOOLCHAIN_HOSTS) {
    await invoke(sbx, ["policy", "rm", "network", "--sandbox", name, "--resource", host, "--force"]);
  }
  const rules = await invoke(sbx, ["policy", "ls", name, "--wide"]);
  if (rules.status !== 0) return false;
  const resources = new Set(rules.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).at(-1)));
  return TOOLCHAIN_HOSTS.every((host) => !resources.has(host));
}

/** The kit carries the pinned runtimes, so setup installs mise itself, for mise's own files, reached through its shims. */
const MISE: MiseUse = { install: true, runtimes: {}, reach: "shims" };

/** Run each setup stage in order, stopping at the first failure as other agents' setup steps do. */
async function runSetupStages(sbx: string, name: string, cwd: string, plan: ToolchainPlan,
  variables: Readonly<Record<string, string>>, onProgress: (text: string) => void): Promise<PreparationStep[]> {
  const steps: PreparationStep[] = [];
  for (const stage of setupStages(plan, MISE)) {
    onProgress(`Preparing the sandbox: ${stage.description}`);
    const result = await execScript(sbx, name, cwd, stage.script, variables, setupStepMs);
    const done = result.status === 0;
    steps.push({ description: stage.description, outcome: done ? "done" : "failed",
      output: done ? "" : `${result.stdout}${result.stderr}`.slice(-outputTail) });
    if (!done) break;
  }
  return steps;
}

/** Run the stages, opening the toolchain hosts only when they are needed and confirming they close. */
async function runSetup(sbx: string, name: string, cwd: string, plan: ToolchainPlan,
  variables: Readonly<Record<string, string>>, onProgress: (text: string) => void): Promise<PreparationStep[]> {
  if (!needsDownloadHosts(plan, MISE)) return runSetupStages(sbx, name, cwd, plan, variables, onProgress);
  if ((await invoke(sbx, ["policy", "allow", "network", "--sandbox", name, TOOLCHAIN_HOSTS.join(",")])).status !== 0) {
    throw new Error("The setup network rules could not be added");
  }
  const steps = await runSetupStages(sbx, name, cwd, plan, variables, onProgress).catch((error: unknown) => error);
  if (!await closeToolchainHosts(sbx, name)) {
    await invoke(sbx, ["rm", "--force", name]);
    throw new Error("The setup network rules could not be removed, so the sandbox was deleted");
  }
  if (!Array.isArray(steps)) throw steps instanceof Error ? steps : new Error("Sandbox setup failed");
  return steps;
}

/**
 * Finish preparing a sandbox whose image already carries the pinned runtimes:
 * mise's own files, the setup script and the dependency install. A marker
 * skips unchanged setups.
 */
async function prepareToolchain(sbx: string, name: string, workspace: string, plan: ToolchainPlan,
  onProgress: (text: string) => void): Promise<PreparedToolchain> {
  const cwd = sandboxPath(workspace);
  const [home, defaultPath] = (await execScript(sbx, name, cwd, "printf '%s\\n%s' \"$HOME\" \"$PATH\"", {})).stdout.split("\n");
  if (home === undefined || defaultPath === undefined) throw new Error("The sandbox environment could not be read");
  const runtimes = KIT_RUNTIMES.map((tool) => `/opt/tesota/${tool}/bin`).join(":");
  const variables = { MISE_YES: "1", MISE_TRUSTED_CONFIG_PATHS: cwd, NPM_CONFIG_PREFIX: `${home}/.npm-global`,
    BUN_INSTALL: `${home}/.bun`, PATH: [`${home}/.local/share/mise/shims`, runtimes, `${home}/.local/bin`,
      `${home}/.npm-global/bin`, `${home}/.bun/bin`, defaultPath.trim()].join(":") };
  if (!needsSetup(plan)) return { steps: [], variables };
  const marker = await execScript(sbx, name, cwd, `cat "${setupMarker}" 2>/dev/null || true`, {});
  if (marker.stdout.trim() === plan.fingerprint) return { steps: [], variables };
  const steps = await runSetup(sbx, name, cwd, plan, variables, onProgress);
  if (steps.every((step) => step.outcome === "done")) {
    await execScript(sbx, name, cwd, `echo ${plan.fingerprint} > "${setupMarker}"`, {});
  }
  return { steps, variables };
}

const createTimeoutMs = 20 * 60_000;

/** Create a sandbox from a kit directory, with the registry allowlist and resource caps. */
async function createSandbox(sbx: string, name: string, workspace: string, kit: string,
  kitArguments: readonly string[]): Promise<void> {
  const created = await invoke(sbx, ["create", kit, workspace, "--name", name,
    ...kitArguments.flatMap((argument) => ["--kit-arg", argument]),
    "--cpus", String(Math.max(2, Math.floor(cpus().length / 2))),
    "--memory", `${Math.max(2, Math.min(8, Math.floor(totalmem() / 2 ** 31)))}g`, "--quiet"], createTimeoutMs);
  if (created.status !== 0) {
    throw new Error(`The sandbox could not be created: ${`${created.stdout}${created.stderr}`.trim().slice(-600)}`);
  }
  const allowed = await invoke(sbx, ["policy", "allow", "network", "--sandbox", name, PACKAGE_REGISTRY_HOSTS.join(",")]);
  if (allowed.status !== 0) {
    await invoke(sbx, ["rm", "--force", name]);
    throw new Error("The sandbox network rules could not be set");
  }
}

/** The first missing step only: each depends on the ones before it. */
async function readinessSteps(): Promise<SetupStep[]> {
  if (!await hypervisorPlatformEnabled()) {
    const script = "Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart";
    return [{ description: "Turn on the Windows Hypervisor Platform", elevated: true, restart: true,
      command: script, action: { kind: "elevated-powershell", script } }];
  }
  const sbx = await locateSbx();
  if (sbx === null) {
    const args = ["install", "--exact", "--id", "Docker.sbx"];
    return [{ description: "Install Docker Sandboxes", command: `winget ${args.join(" ")}`,
      action: { kind: "process", program: "winget", args } }];
  }
  // The daemon runs in the foreground, so it is started here rather than as a step to wait on.
  if (!await ensureDaemon(sbx)) return [{ description: "Start the Docker Sandboxes daemon; it did not start on its own", command: "sbx daemon start" }];
  if ((await invoke(sbx, ["ls"])).status !== 0) {
    return [{ description: "Sign in to Docker", command: "sbx login", action: { kind: "process", program: sbx, args: ["login"] } }];
  }
  if (!deniesByDefault(await invoke(sbx, ["policy", "check", "network", "example.com"]))) {
    const args = ["policy", "init", "deny-all"];
    return [{ description: "Block all sandbox network traffic by default", command: `sbx ${args.join(" ")}`,
      action: { kind: "process", program: sbx, args } }];
  }
  return [];
}

export const dockerSandboxesProvider: ExecutionProvider = {
  name: "docker-sandboxes",
  guarantees,
  async readiness(): Promise<ProviderReadiness> {
    const steps = await readinessSteps();
    return steps.length === 0 ? { ready: true } : { ready: false, steps };
  },
  async prepare(workspace: string, options: PrepareOptions = {}): Promise<ExecutionEnvironment> {
    const sbx = await locateSbx();
    if (sbx === null || !await ensureDaemon(sbx)) throw new Error("Docker Sandboxes is not available");
    const onProgress = options.onProgress ?? (() => {});
    const plan = planToolchain(workspace);
    const runtimes = kitRuntimes(plan);
    const kit = await writeToolchainKit(runtimes);
    const modules = ["", ...plan.packages].map((folder) => join(workspace, folder, "node_modules"));
    // The mounts are fixed when the sandbox is created, so a new set of packages makes a new sandbox.
    const name = `${sandboxPrefix(workspace)}${createHash("sha256").update(JSON.stringify([kit.id, plan.packages])).digest("hex").slice(0, 8)}`;
    const listed = await invoke(sbx, ["ls"]);
    if (listed.status !== 0) throw new Error("Docker Sandboxes is not signed in");
    const existing = listedSandboxes(listed.stdout).filter((sandbox) => sandbox.startsWith(sandboxPrefix(workspace)));
    for (const stale of existing.filter((sandbox) => sandbox !== name)) await invoke(sbx, ["rm", "--force", stale]);
    // A sandbox is kept and reused by name, so a stop between steps leaves nothing that its workspace's release does not remove.
    options.signal?.throwIfAborted();
    // Every sandbox keeps node_modules on its own disk, the root's and each package's, so an install never writes Linux
    // packages into the operator's checkout, even one that becomes a JavaScript package mid-session; the startup bind
    // mounts land on these folders on every start.
    for (const folder of modules) await mkdir(folder, { recursive: true });
    if (!existing.includes(name)) {
      const tools = Object.entries(runtimes).map(([tool, version]) => `${tool} ${version}`).join(", ");
      onProgress(`Creating the sandbox${tools.length === 0 ? "" : ` with ${tools}`}`);
      await createSandbox(sbx, name, workspace, kit.directory,
        [`${DEPENDENCIES_ARGUMENT}=${modules.map((folder) => sandboxPath(resolve(folder))).join(":")}`]);
    }
    options.signal?.throwIfAborted();
    const allowed = [...plan.registries.map((host) => `${host}:443`), ...options.allowed ?? []];
    if (allowed.length > 0) await sandboxNetwork(sbx, name).allow(allowed);
    const prepared = await prepareToolchain(sbx, name, resolve(workspace), plan, onProgress);
    options.signal?.throwIfAborted();
    return sandboxEnvironment(sbx, name, resolve(workspace), prepared);
  },
  async release(workspace: string): Promise<void> {
    const sbx = await locateSbx();
    if (sbx === null) return;
    const listed = await invoke(sbx, ["ls"]);
    for (const sandbox of listedSandboxes(listed.stdout).filter((entry) => entry.startsWith(sandboxPrefix(workspace)))) {
      await invoke(sbx, ["rm", "--force", sandbox]);
    }
    // The node_modules mount points, removed only while empty, so nothing the operator put there is lost.
    for (const folder of ["", ...planToolchain(workspace).packages]) await rmdir(join(workspace, folder, "node_modules")).catch(() => undefined);
  },
};
