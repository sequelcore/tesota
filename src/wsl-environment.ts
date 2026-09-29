import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { release } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type HostMessage, type SandboxMessage, sandboxMessage } from "./bubblewrap-sandbox.js";
import { type EnvironmentGuarantees, type ExecutionEnvironment, type ExecutionProvider, isNetworkDestination,
  type NetworkControl, type PrepareOptions, type PreparationStep, type ProviderReadiness, type RunOptions, type RunResult,
  type SetupStep } from "./execution-environment.js";
import { miseInstallScript, planToolchain } from "./toolchain.js";
import { distributionStep } from "./verification/wsl-settings-rule.js";
import { windowsSystemProgram } from "./windows-system.js";

/**
 * The WSL sandbox (issue 163): the candidate to replace the native Windows
 * sandbox, qualified by the same controls. Tesota keeps a WSL distribution of
 * its own, with its own user and Windows interop off, and starts one process
 * in it per prepared environment (`bubblewrap-sandbox.ts`), which runs each
 * command in a bubblewrap sandbox and hosts the egress proxy. Commands run in
 * a POSIX shell, and see the workspace at its path under `/mnt`. WSL itself is
 * not the boundary: bubblewrap's namespaces are, inside WSL's virtual machine.
 * It is chosen only by name, `tesota sandbox use wsl`, until the comparison
 * with the native sandbox decides which one Windows keeps.
 */

export const WSL_GUARANTEES: EnvironmentGuarantees = { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" };

/** Tesota's own distribution, so its tools, user and interop setting are Tesota's to set. */
export const WSL_DISTRIBUTION = "tesota";
const WSL_USER = "tesota";
const DISTRIBUTION_IMAGE = "Ubuntu-24.04";

/** Starts the sandbox's process with arguments, somewhere it can run bubblewrap. */
export type Launch = (args: readonly string[]) => ChildProcessWithoutNullStreams;

/** The built sandbox process, whether this module runs from `dist` or, in tests, from `src`. */
const SERVER = fileURLToPath(new URL("../dist/bubblewrap-sandbox-server.js", import.meta.url));

/** WSL's command, by its place in the system directory: never one `PATH` or the working folder could supply. */
function wslProgram(): string {
  return windowsSystemProgram("wsl.exe");
}

/** Where the distribution's setup puts Tesota's pinned runtimes, as the Docker Sandboxes kit does. */
const RUNTIMES = ["node", "bun"] as const;
const RUNTIMES_PATH = RUNTIMES.map((tool) => `/opt/tesota/${tool}/bin`).join(":");

/** The sandbox's process inside Tesota's distribution, run by Tesota's pinned Node from Tesota's own files on the Windows drive. */
const wslLaunch: Launch = (args) => spawn(wslProgram(), ["--distribution", WSL_DISTRIBUTION, "--user", WSL_USER, "--cd", "~",
  "--exec", "sh", "-c", `PATH=${RUNTIMES_PATH}:$PATH exec node "$(wslpath -a -u "$0")" "$@"`, SERVER, ...args, "--wsl"],
  { windowsHide: true });

const STOP_MS = 10_000;
const OUTPUT_TAIL = 4 * 1024;
const SETUP_STEP_MS = 15 * 60_000;

/** One sandbox process: messages to it, answers by id, and its end. */
class Connection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #listeners = new Map<string, (message: SandboxMessage) => void>();
  readonly #closed: Promise<void>;
  #ended = false;
  #errors = "";
  readonly first: Promise<SandboxMessage>;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => { this.#errors = `${this.#errors}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL); });
    let opened: (message: SandboxMessage) => void = () => undefined;
    this.first = new Promise((settle) => { opened = settle; });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let parsed: ReturnType<typeof sandboxMessage.safeParse> | undefined;
      try { parsed = sandboxMessage.safeParse(JSON.parse(line)); } catch { parsed = undefined; }
      if (parsed?.success !== true) return;
      const message = parsed.data;
      if ("id" in message) this.#listeners.get(message.id)?.(message);
      else opened(message);
    });
    this.#closed = new Promise((settle) => {
      const end = (): void => {
        this.#ended = true;
        opened({ type: "failed", message: this.#errors.trim() || "The sandbox's process ended before it was ready" });
        // A command whose process is gone cannot be confirmed stopped.
        for (const [id, listener] of this.#listeners) listener({ type: "ended", id, outcome: "unconfirmed", exitCode: null });
        settle();
      };
      child.once("error", (error) => { this.#errors = error.message; end(); });
      child.once("close", end);
    });
  }

  send(message: HostMessage): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Answers to one id; once the process has ended, the only answer is that nothing can be confirmed. */
  listen(id: string, listener: (message: SandboxMessage) => void): () => void {
    if (this.#ended) queueMicrotask(() => { listener({ type: "ended", id, outcome: "unconfirmed", exitCode: null }); });
    else this.#listeners.set(id, listener);
    return () => { this.#listeners.delete(id); };
  }

  /** End the process's input, so it stops what runs and closes its proxy, and wait for it; kill it if it does not end. */
  async close(): Promise<void> {
    this.#child.stdin.end();
    const timer = setTimeout(() => { this.#child.kill(); }, STOP_MS);
    await this.#closed;
    clearTimeout(timer);
  }
}

function sandboxNetwork(connection: Connection): NetworkControl {
  return {
    blockedSince: (time) => new Promise((settle, fail) => {
      const id = randomUUID();
      const stop = connection.listen(id, (message) => {
        stop();
        if (message.type === "blocked") settle(message.destinations);
        else fail(new Error("The sandbox's network log is unavailable"));
      });
      connection.send({ type: "blocked", id, since: time.getTime() });
    }),
    allow: async (destinations) => {
      if (!destinations.every(isNetworkDestination)) throw new Error("Only host:port destinations can be allowed");
      connection.send({ type: "allow", destinations });
    },
  };
}

function runIn(connection: Connection, workspace: string, command: string, options: RunOptions): Promise<RunResult> {
  const within = relative(workspace, resolve(options.cwd));
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return Promise.resolve({ outcome: "not_started", exitCode: null });
  if (options.signal?.aborted === true) return Promise.resolve({ outcome: "cancelled", exitCode: null });
  const id = randomUUID();
  return new Promise((settle) => {
    const abort = (): void => { connection.send({ type: "stop", id }); };
    const stop = connection.listen(id, (message) => {
      if (message.type === "output") { options.onOutput(Buffer.from(message.data, "base64")); return; }
      if (message.type !== "ended") return;
      stop();
      options.signal?.removeEventListener("abort", abort);
      settle({ outcome: message.outcome, exitCode: message.exitCode });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    connection.send({ type: "run", id, command, cwd: within.split(sep).join("/"), env: { ...options.env },
      ...options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds } });
  });
}

/**
 * Install the repository's dependencies from its lockfile, inside the sandbox,
 * so they are Linux's and land on WSL's own disk. A marker in the sandbox's
 * home skips an install nothing changed. Mise's files and `.tesota/setup.sh`
 * download toolchains from hosts beyond the registries, which this sandbox
 * does not open yet, so they are reported and not run.
 */
async function prepareDependencies(connection: Connection, workspace: string, options: PrepareOptions):
  Promise<PreparationStep[]> {
  const plan = planToolchain(workspace);
  const steps: PreparationStep[] = [];
  const downloads = [...plan.miseFiles, ...plan.setupScript === null ? [] : [plan.setupScript]];
  if (downloads.length > 0) {
    steps.push({ description: `Set up ${downloads.join(" and ")}`, outcome: "failed",
      output: "The WSL sandbox does not open the toolchain downloads these need yet." });
  }
  if (plan.dependencies === null) return steps;
  const marker = `"$HOME/.tesota-setup"`;
  const run = async (command: string): Promise<{ result: RunResult; output: string }> => {
    let output = "";
    const result = await runIn(connection, workspace, command, { cwd: workspace, timeoutSeconds: SETUP_STEP_MS / 1_000,
      onOutput: (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL); },
      ...options.signal === undefined ? {} : { signal: options.signal } });
    return { result, output };
  };
  if ((await run(`cat ${marker} 2>/dev/null || true`)).output.trim() === plan.fingerprint) return steps;
  options.onProgress?.(`Preparing the sandbox: installing dependencies (${plan.dependencies})`);
  const installed = await run(plan.dependencies);
  const done = installed.result.outcome === "exited" && installed.result.exitCode === 0;
  steps.push({ description: `Install dependencies (${plan.dependencies})`, outcome: done ? "done" : "failed", output: done ? "" : installed.output });
  if (done) await run(`echo ${plan.fingerprint} > ${marker}`);
  return steps;
}

/**
 * Start a workspace's sandbox process with `launch`, wait until it is ready,
 * and install the workspace's dependencies in it. Stopping the preparation
 * ends the process, which stops what it runs and closes its proxy.
 */
export async function bubblewrapEnvironment(launch: Launch, workspace: string, options: PrepareOptions = {}): Promise<ExecutionEnvironment> {
  options.signal?.throwIfAborted();
  const root = resolve(workspace);
  const connection = new Connection(launch(["serve", "--workspace", root,
    ...options.cacheDirectory === undefined ? [] : ["--cache", options.cacheDirectory]]));
  const stop = (): void => { void connection.close(); };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    const first = await connection.first;
    if (first.type !== "ready") throw new Error(`The WSL sandbox could not start: ${first.type === "failed" ? first.message : first.type}`);
    options.signal?.throwIfAborted();
    const preparation = await prepareDependencies(connection, root, options);
    options.signal?.throwIfAborted();
    return { provider: "wsl", shell: "posix", ...first.workspace === root ? {} : { commandRoot: first.workspace },
      guarantees: WSL_GUARANTEES, preparation,
      network: sandboxNetwork(connection), run: (command, runOptions) => runIn(connection, root, command, runOptions),
      dispose: () => connection.close() };
  } catch (error) {
    await connection.close();
    throw error;
  } finally { options.signal?.removeEventListener("abort", stop); }
}

interface Invocation { readonly status: number | null; readonly stdout: Buffer }

function invoke(program: string, args: readonly string[], timeoutMs: number = 60_000): Promise<Invocation> {
  return new Promise((settle) => {
    const chunks: Buffer[] = [];
    const child = spawn(program, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.once("error", () => { clearTimeout(timer); settle({ status: null, stdout: Buffer.concat(chunks) }); });
    child.once("close", (status) => { clearTimeout(timer); settle({ status, stdout: Buffer.concat(chunks) }); });
  });
}

/** The distributions `wsl.exe --list --quiet` names; it writes UTF-16. */
export function listedDistributions(output: Buffer): string[] {
  return output.toString("utf16le").replace(/^﻿/u, "").split(/\r?\n/u).map((line) => line.replaceAll("\0", "").trim())
    .filter((line) => line.length > 0);
}

/** What the sandbox's process reports it still needs, and the versions qualification depends on. */
async function checkDistribution(launch: Launch): Promise<Extract<SandboxMessage, { type: "checked" }> | undefined> {
  const child = launch(["check"]);
  child.stdin.end();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  await new Promise<void>((settle) => { child.once("error", () => { settle(); }); child.once("close", () => { settle(); }); });
  try {
    const parsed = sandboxMessage.safeParse(JSON.parse(output.trim()));
    return parsed.success && parsed.data.type === "checked" ? parsed.data : undefined;
  } catch { return undefined; }
}

/** The runtimes Tesota itself pins, which run the sandbox's process and serve as the distribution's Node and Bun. */
function pinnedRuntimes(): { node: string; bun: string } {
  const manifest: unknown = createRequire(import.meta.url)("../package.json");
  const node = String(Reflect.get(Reflect.get(Object(manifest), "engines") ?? {}, "node") ?? "");
  const bun = /^bun@(.+)$/u.exec(String(Reflect.get(Object(manifest), "packageManager") ?? ""))?.[1] ?? "";
  return { node, bun };
}

/**
 * Root's script that makes Tesota's distribution a sandbox host: bubblewrap
 * and Git from the distribution, Node and Bun at Tesota's pinned versions
 * under `/opt/tesota` through the pinned, hash-checked mise, a user of its
 * own, and WSL's settings for the next start: interop off, and Windows'
 * drives owned by that user, since a distribution created without its
 * first-run setup mounts them as root's.
 */
export function distributionSetupScript(): string {
  const versions = pinnedRuntimes();
  const mise = "\"$HOME/.local/bin/mise\"";
  return ["set -eu", "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -q", "apt-get install -y -q --no-install-recommends bubblewrap git curl ca-certificates xz-utils unzip",
    miseInstallScript(), "export MISE_DATA_DIR=/tmp/tesota-mise MISE_YES=1", "mkdir -p /opt/tesota",
    ...RUNTIMES.flatMap((tool) => [`${mise} install ${tool}@${versions[tool]}`,
      `rm -rf /opt/tesota/${tool}`, `cp -a "$(${mise} where ${tool}@${versions[tool]})" /opt/tesota/${tool}`]),
    "rm -rf /tmp/tesota-mise",
    `id -u ${WSL_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${WSL_USER}`,
    `printf '[automount]\\noptions = "uid=%s,gid=%s"\\n[user]\\ndefault=%s\\n[interop]\\nenabled=false\\nappendWindowsPath=false\\n' ` +
      `"$(id -u ${WSL_USER})" "$(id -g ${WSL_USER})" ${WSL_USER} > /etc/wsl.conf`].join("\n");
}

/** The first missing step only: each depends on the ones before it. */
async function readinessSteps(launch: Launch): Promise<SetupStep[]> {
  const wsl = wslProgram();
  const listed = await invoke(wsl, ["--list", "--quiet"]);
  if (listed.status === null) {
    const script = `& '${wsl.replaceAll("'", "''")}' --install --no-distribution`;
    return [{ description: "Install WSL", elevated: true, restart: true, command: script, action: { kind: "elevated-powershell", script } }];
  }
  if (!listedDistributions(listed.stdout).includes(WSL_DISTRIBUTION)) {
    const args = ["--install", DISTRIBUTION_IMAGE, "--name", WSL_DISTRIBUTION, "--no-launch"];
    return [{ description: "Create Tesota's WSL distribution", command: `"${wsl}" ${args.join(" ")}`,
      action: { kind: "process", program: wsl, args } }];
  }
  const checked = await checkDistribution(launch);
  // Setup while anything it installs or writes is missing; a restart only for settings already written (proved).
  const step = distributionStep(checked === undefined || checked.problems.length > 0, (checked?.settings.length ?? 0) > 0);
  if (step === "setup" || checked === undefined) {
    // The script travels encoded, so no quoting between Windows and the distribution's shell can change it.
    const args = ["--distribution", WSL_DISTRIBUTION, "--user", "root", "--exec", "sh", "-c",
      `echo ${Buffer.from(distributionSetupScript(), "utf8").toString("base64")} | base64 -d | sh`];
    const problems = checked?.problems.join("; ") ?? "Node.js cannot run there yet";
    return [{ description: `Set up Tesota's WSL distribution: bubblewrap, Git, Node.js, Bun, its own user and settings (${problems})`,
      command: `"${wsl}" ${args.slice(0, 7).join(" ")} "<setup script>"`, action: { kind: "process", program: wsl, args } }];
  }
  if (step === "ready") return [];
  const args = ["--terminate", WSL_DISTRIBUTION];
  return [{ description: `Restart Tesota's WSL distribution so its settings apply (${checked.settings.join("; ")})`,
    command: `"${wsl}" ${args.join(" ")}`, action: { kind: "process", program: wsl, args } }];
}

export const wslProvider: ExecutionProvider = {
  name: "wsl",
  guarantees: WSL_GUARANTEES,
  async readiness(): Promise<ProviderReadiness> {
    if (process.platform !== "win32") return { ready: false, steps: [{ description: "The WSL sandbox runs on Windows" }] };
    const steps = await readinessSteps(wslLaunch);
    return steps.length === 0 ? { ready: true } : { ready: false, steps };
  },
  prepare: (workspace, options) => bubblewrapEnvironment(wslLaunch, workspace, options),
  /** Qualification holds for one Windows build, one WSL kernel and one bubblewrap. */
  async fingerprint(): Promise<string> {
    return `windows ${release()}; ${(await checkDistribution(wslLaunch))?.versions ?? "unknown"}`;
  },
  async release(workspace) {
    if (process.platform !== "win32") return;
    const child = wslLaunch(["release", "--workspace", resolve(workspace)]);
    child.stdin.end();
    await new Promise<void>((settle) => { child.once("error", () => { settle(); }); child.once("close", () => { settle(); }); });
  },
};
