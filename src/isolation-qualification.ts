import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import {
  CONTAINER_IMAGE,
  ISOLATION_PROBE_FILE,
  ISOLATION_PROBE_SOURCE,
  assessIsolationProbe,
  buildCodexSandboxInvocation,
  buildContainerInvocation,
  type IsolationAssessment,
  type IsolationInvocation,
  type IsolationPaths,
  type IsolationProbeReport,
} from "./command-isolation.js";

export interface IsolationBackendResult {
  readonly backend: "codex-windows" | "docker-container";
  readonly identity: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly assessment?: IsolationAssessment;
  readonly diagnostic?: string;
}

export interface IsolationQualification {
  readonly command: "node isolation-probe.mjs";
  readonly image: typeof CONTAINER_IMAGE;
  readonly selected: "docker-container" | "none";
  readonly results: readonly IsolationBackendResult[];
}

interface ProbeExecution {
  readonly report?: IsolationProbeReport;
  readonly canceled: boolean;
  readonly descendantSettled: boolean;
  readonly diagnostic?: string;
}

class QualificationAbortedError extends Error {}
export class CleanupUnconfirmedError extends Error {
  public readonly resources: readonly string[];

  public constructor(resources: readonly string[]) {
    super(`Cleanup was not confirmed: ${resources.join(", ")}`);
    this.resources = resources;
  }
}

interface NamedCleanup {
  readonly name: string;
  readonly remove: () => boolean;
}

export function collectUnconfirmedResources(cleanups: readonly NamedCleanup[]): readonly string[] {
  const pending: string[] = [];
  for (const cleanup of cleanups) {
    try {
      if (!cleanup.remove()) pending.push(cleanup.name);
    } catch {
      pending.push(cleanup.name);
    }
  }
  return pending;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof QualificationAbortedError
    || (error instanceof DOMException && error.name === "AbortError");
}

function createFixture(root: string): IsolationPaths {
  const candidate = join(root, "candidate");
  const source = join(candidate, "source");
  const buildOutput = join(root, "build");
  const verifierScratch = join(root, "scratch");
  const outsideDirectory = join(root, "outside");
  for (const directory of [source, buildOutput, verifierScratch, outsideDirectory]) mkdirSync(directory, { recursive: true });
  const writableSource = join(source, "allowed.txt");
  const outside = join(outsideDirectory, "sentinel.txt");
  writeFileSync(join(candidate, ISOLATION_PROBE_FILE), ISOLATION_PROBE_SOURCE, { encoding: "utf8", mode: 0o600 });
  writeFileSync(writableSource, "original\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(source, "denied.txt"), "unchanged\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(outside, "synthetic-private\n", { encoding: "utf8", mode: 0o600 });
  return { candidate, writableSource, buildOutput, verifierScratch, outside };
}

function parseProbeReport(output: string): IsolationProbeReport | undefined {
  const firstLine = output.split(/\r?\n/u)[0];
  if (firstLine === undefined || firstLine.length > 2_048) return undefined;
  let value: unknown;
  try { value = JSON.parse(firstLine); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["sourceWrite", "siblingWriteDenied", "buildWrite", "scratchWrite", "outsideReadDenied", "credentialAbsent", "networkDenied", "descendantStarted"] as const;
  if (keys.some((key) => typeof record[key] !== "boolean")) return undefined;
  return record as unknown as IsolationProbeReport;
}

function waitForClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function stopDocker(name: string, env: NodeJS.ProcessEnv): boolean {
  const stopped = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "stop", "--signal=SIGINT", "--timeout=1", name], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  return stopped.error === undefined && stopped.status === 0;
}

function removeDocker(name: string, env: NodeJS.ProcessEnv): boolean {
  const removed = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "rm", "--force", name], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  return removed.error === undefined && removed.status === 0;
}

async function executeProbe(
  invocation: IsolationInvocation,
  latePath: string,
  cancel: (child: ChildProcess) => boolean,
  signal?: AbortSignal,
): Promise<ProbeExecution> {
  if (isAborted(signal)) throw new QualificationAbortedError("Qualification canceled");
  const child = spawn(invocation.command, [...invocation.args], {
    cwd: invocation.cwd, env: invocation.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let cancellationRequested = false;
  let canceled = false;
  let externallyAborted = false;
  const requestCancellation = (): void => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    canceled = cancel(child);
  };
  const onAbort = (): void => {
    externallyAborted = true;
    requestCancellation();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 16_384) stdout += chunk;
    if (stdout.includes("TESOTA_PROBE_READY")) requestCancellation();
  });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 4_096) stderr += chunk; });
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    await waitForClose(child);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
  if (externallyAborted || isAborted(signal)) throw new QualificationAbortedError("Qualification canceled");
  const report = parseProbeReport(stdout);
  const diagnostic = report === undefined ? (stderr.trim().slice(-1_000) || "Probe did not return its fixed report") : undefined;
  return {
    ...(report === undefined ? {} : { report }),
    canceled,
    descendantSettled: !existsSync(latePath),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function startNetworkControl(): Promise<{ readonly server: Server; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("Network control has no TCP port"));
      else resolve({ server, port: address.port });
    });
  });
}

function closeNetworkControl(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function hostCanReachNetworkControl(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean): void => { socket.destroy(); resolve(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(2_000, () => finish(false));
  });
}

function versionOf(command: string): string {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 4_096 });
  return result.error === undefined && result.status === 0 ? result.stdout.trim().slice(0, 200) : "unavailable";
}

function containerIdentity(): string | undefined {
  const version = versionOf("docker");
  if (version === "unavailable") return undefined;
  const image = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "image", "inspect", CONTAINER_IMAGE], {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  return image.error === undefined && image.status === 0 ? `${version}; ${CONTAINER_IMAGE}` : undefined;
}

interface ContainerNetworkControl {
  readonly network: string;
  readonly server: string;
  readonly address: string;
  readonly port: number;
}

function removeDockerNetwork(name: string, env: NodeJS.ProcessEnv): boolean {
  const removed = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "network", "rm", name], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  return removed.error === undefined && removed.status === 0;
}

function dockerResourceIsAbsent(kind: "container" | "network", name: string, env: NodeJS.ProcessEnv): boolean {
  const inspected = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", kind, "inspect", name], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  return inspected.error === undefined
    && inspected.status !== 0
    && /no such (?:object|container|network)/iu.test(inspected.stderr);
}

function reconcileContainerAbsence(name: string, env: NodeJS.ProcessEnv): boolean {
  return removeDocker(name, env) || dockerResourceIsAbsent("container", name, env);
}

function reconcileNetworkAbsence(name: string, env: NodeJS.ProcessEnv): boolean {
  return removeDockerNetwork(name, env) || dockerResourceIsAbsent("network", name, env);
}

interface NetworkControlReachability {
  readonly reachable: boolean;
  readonly pending: readonly string[];
}

function containerCanReachNetworkControl(control: ContainerNetworkControl, env: NodeJS.ProcessEnv): NetworkControlReachability {
  const name = `tesota-network-control-${randomUUID()}`;
  const script = "const net=require('node:net');const deadline=Date.now()+3000;function attempt(){const s=net.connect(Number(process.argv[1]),process.argv[2],()=>{s.destroy();process.exit(0)});s.on('error',()=>{s.destroy();if(Date.now()<deadline)setTimeout(attempt,100);else process.exit(1)})}attempt()";
  const run = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "run", "--name", name,
    "--pull=never", `--network=${control.network}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=65534:65534", "--pids-limit=8", "--memory=64m", "--memory-swap=64m", "--cpus=1", "--log-driver=none",
    "--entrypoint=node", CONTAINER_IMAGE, "-e", script, String(control.port), control.address], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  const removed = reconcileContainerAbsence(name, env);
  return {
    reachable: run.error === undefined && run.status === 0,
    pending: removed ? [] : [name],
  };
}

function createContainerNetworkControl(env: NodeJS.ProcessEnv): ContainerNetworkControl | undefined {
  const id = randomUUID();
  const partial = { network: `tesota-isolation-net-${id}`, server: `tesota-isolation-server-${id}`, port: 43123 };
  const network = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "network", "create", "--internal", partial.network], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  if (network.error !== undefined || network.status !== 0) {
    if (!reconcileNetworkAbsence(partial.network, env)) {
      throw new CleanupUnconfirmedError([partial.network]);
    }
    return undefined;
  }
  const script = "require('node:net').createServer(s=>s.end()).listen(Number(process.argv[1]),'0.0.0.0');setInterval(()=>{},1000)";
  const server = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "run", "--detach", "--name", partial.server,
    "--pull=never", `--network=${partial.network}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=65534:65534", "--pids-limit=8", "--memory=64m", "--memory-swap=64m", "--cpus=1", "--log-driver=none",
    "--entrypoint=node", CONTAINER_IMAGE, "-e", script, String(partial.port)], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  const inspected = spawnSync("docker", ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine", "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", partial.server], {
    env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
  });
  const address = inspected.stdout.trim();
  const control = { ...partial, address };
  const serverReady = server.error === undefined && server.status === 0 && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address);
  const reachability = serverReady ? containerCanReachNetworkControl(control, env) : { reachable: false, pending: [] };
  if (reachability.reachable) return control;
  const pending = [
    ...reachability.pending,
    ...collectUnconfirmedResources([
      { name: partial.server, remove: () => reconcileContainerAbsence(partial.server, env) },
      { name: partial.network, remove: () => reconcileNetworkAbsence(partial.network, env) },
    ]),
  ];
  if (pending.length > 0) throw new CleanupUnconfirmedError(pending);
  return undefined;
}

function removeContainerNetworkControl(control: ContainerNetworkControl, env: NodeJS.ProcessEnv): readonly string[] {
  return collectUnconfirmedResources([
    { name: control.server, remove: () => reconcileContainerAbsence(control.server, env) },
    { name: control.network, remove: () => reconcileNetworkAbsence(control.network, env) },
  ]);
}

function resolveCodexBinary(): string | undefined {
  const appData = process.env["APPDATA"];
  if (appData === undefined) return undefined;
  const architecture = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
  if (architecture === undefined) return undefined;
  const binary = join(appData, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai",
    `codex-win32-${architecture}`, "vendor", `${architecture === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`, "bin", "codex.exe");
  return existsSync(binary) ? binary : undefined;
}

function resultFor(backend: IsolationBackendResult["backend"], identity: string, execution: ProbeExecution): IsolationBackendResult {
  if (execution.report === undefined) return {
    backend,
    identity,
    status: identity === "unavailable" ? "unavailable" : "failed",
    ...(execution.diagnostic === undefined ? {} : { diagnostic: execution.diagnostic }),
  };
  const assessment = assessIsolationProbe(execution.report, execution);
  return { backend, identity, status: assessment.status, assessment };
}

async function qualifyCodex(paths: IsolationPaths, networkPort: number, signal?: AbortSignal): Promise<IsolationBackendResult> {
  const identity = versionOf("codex");
  const binary = resolveCodexBinary();
  if (identity === "unavailable" || binary === undefined) return { backend: "codex-windows", identity, status: "unavailable", diagnostic: "Native Codex sandbox binary is unavailable" };
  const configured = buildCodexSandboxInvocation(paths, networkPort);
  const invocation = { ...configured, command: binary };
  const execution = await executeProbe(invocation, join(paths.buildOutput, "late.txt"), (child) => child.kill("SIGINT"), signal);
  return resultFor("codex-windows", identity, execution);
}

async function qualifyContainer(paths: IsolationPaths, signal?: AbortSignal): Promise<IsolationBackendResult> {
  const identity = containerIdentity();
  if (identity === undefined) return { backend: "docker-container", identity: "unavailable", status: "unavailable", diagnostic: "Docker engine or the pinned image is unavailable" };
  const controlEnvironment = buildContainerInvocation(paths, "unused").env;
  const control = createContainerNetworkControl(controlEnvironment);
  if (control === undefined) return { backend: "docker-container", identity, status: "unavailable", diagnostic: "Container network positive control was unavailable" };
  const name = `tesota-isolation-${randomUUID()}`;
  const invocation = buildContainerInvocation(paths, name, control.port, control.address);
  let execution: ProbeExecution | undefined;
  let failure: unknown;
  try { execution = await executeProbe(invocation, join(paths.buildOutput, "late.txt"), () => stopDocker(name, invocation.env), signal); }
  catch (error) { failure = error; }
  const containerRemoved = reconcileContainerAbsence(name, invocation.env);
  const pendingControlResources = removeContainerNetworkControl(control, invocation.env);
  if (!containerRemoved || pendingControlResources.length > 0) {
    const pending = [
      ...(!containerRemoved ? [name] : []),
      ...pendingControlResources,
    ];
    throw new CleanupUnconfirmedError(pending);
  }
  if (failure !== undefined) throw failure;
  if (execution === undefined) throw new Error("Isolation container returned no result");
  if (isAborted(signal)) throw new QualificationAbortedError("Qualification canceled");
  return resultFor("docker-container", identity, execution);
}

export async function qualifyCommandIsolation(signal?: AbortSignal): Promise<IsolationQualification> {
  if (process.platform !== "win32") throw new Error("This qualification currently targets the Windows host contract");
  const root = mkdtempSync(join(tmpdir(), "tesota-isolation-"));
  let network: Awaited<ReturnType<typeof startNetworkControl>> | undefined;
  let qualification: IsolationQualification | undefined;
  try {
    network = await startNetworkControl();
    if (!await hostCanReachNetworkControl(network.port)) throw new Error("Host network positive control was unavailable");
    const codex = await qualifyCodex(createFixture(join(root, "codex")), network.port, signal);
    const container = await qualifyContainer(createFixture(join(root, "container")), signal);
    qualification = {
      command: "node isolation-probe.mjs",
      image: CONTAINER_IMAGE,
      selected: container.status === "passed" ? "docker-container" : "none",
      results: [codex, container],
    };
  } finally {
    if (network !== undefined) await closeNetworkControl(network.server);
    rmSync(root, { recursive: true, force: true });
  }
  if (isAborted(signal)) throw new QualificationAbortedError("Qualification canceled");
  if (qualification === undefined) throw new Error("Command isolation qualification returned no result");
  return qualification;
}

export type IsolationQualifier = (signal: AbortSignal) => Promise<IsolationQualification>;

export async function runIsolationQualificationCommand(
  qualifier: IsolationQualifier = qualifyCommandIsolation,
): Promise<number> {
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const result = await qualifier(controller.signal);
    if (isAborted(controller.signal)) throw new QualificationAbortedError("Qualification canceled");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.selected === "docker-container" ? 0 : 1;
  } catch (error) {
    if (isCancellationError(error)) return 130;
    const cleanupDiagnostic = error instanceof CleanupUnconfirmedError ? ` ${error.message}` : "";
    process.stderr.write(`Command isolation qualification failed closed.${cleanupDiagnostic}\n`);
    return 2;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}
