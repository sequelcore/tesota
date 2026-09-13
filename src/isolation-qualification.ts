import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  const keys = ["sourceWrite", "siblingWriteDenied", "buildWrite", "scratchWrite", "outsideReadDenied", "credentialAbsent", "networkDenied"] as const;
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
): Promise<ProbeExecution> {
  const child = spawn(invocation.command, [...invocation.args], {
    cwd: invocation.cwd, env: invocation.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let cancellationRequested = false;
  let canceled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 16_384) stdout += chunk;
    if (!cancellationRequested && stdout.includes("TESOTA_PROBE_READY")) {
      cancellationRequested = true;
      canceled = cancel(child);
    }
  });
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 4_096) stderr += chunk; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await waitForClose(child);
  clearTimeout(deadline);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const report = parseProbeReport(stdout);
  const diagnostic = report === undefined ? (stderr.trim().slice(-1_000) || "Probe did not return its fixed report") : undefined;
  return {
    ...(report === undefined ? {} : { report }),
    canceled,
    descendantSettled: !existsSync(latePath),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
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

async function qualifyCodex(paths: IsolationPaths): Promise<IsolationBackendResult> {
  const identity = versionOf("codex");
  const binary = resolveCodexBinary();
  if (identity === "unavailable" || binary === undefined) return { backend: "codex-windows", identity, status: "unavailable", diagnostic: "Native Codex sandbox binary is unavailable" };
  const configured = buildCodexSandboxInvocation(paths);
  const invocation = { ...configured, command: binary };
  const execution = await executeProbe(invocation, join(paths.buildOutput, "late.txt"), (child) => child.kill("SIGINT"));
  return resultFor("codex-windows", identity, execution);
}

async function qualifyContainer(paths: IsolationPaths): Promise<IsolationBackendResult> {
  const identity = containerIdentity();
  if (identity === undefined) return { backend: "docker-container", identity: "unavailable", status: "unavailable", diagnostic: "Docker engine or the pinned image is unavailable" };
  const name = `tesota-isolation-${randomUUID()}`;
  const invocation = buildContainerInvocation(paths, name);
  let execution: ProbeExecution | undefined;
  let failure: unknown;
  try { execution = await executeProbe(invocation, join(paths.buildOutput, "late.txt"), () => stopDocker(name, invocation.env)); }
  catch (error) { failure = error; }
  if (!removeDocker(name, invocation.env)) throw new Error("Isolation container cleanup was not confirmed");
  if (failure !== undefined) throw failure;
  if (execution === undefined) throw new Error("Isolation container returned no result");
  return resultFor("docker-container", identity, execution);
}

export async function qualifyCommandIsolation(): Promise<IsolationQualification> {
  if (process.platform !== "win32") throw new Error("This qualification currently targets the Windows host contract");
  const root = mkdtempSync(join(tmpdir(), "tesota-isolation-"));
  try {
    const codex = await qualifyCodex(createFixture(join(root, "codex")));
    const container = await qualifyContainer(createFixture(join(root, "container")));
    return {
      command: "node isolation-probe.mjs",
      image: CONTAINER_IMAGE,
      selected: container.status === "passed" ? "docker-container" : "none",
      results: [codex, container],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runIsolationQualificationCommand(): Promise<number> {
  try {
    const result = await qualifyCommandIsolation();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.selected === "docker-container" ? 0 : 1;
  } catch {
    process.stderr.write("Command isolation qualification failed closed.\n");
    return 2;
  }
}
