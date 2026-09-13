export const CONTAINER_IMAGE = "node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f";
export const CONTAINER_ENGINE_ARGS: readonly ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine"] =
  ["--host", "npipe:////./pipe/dockerDesktopLinuxEngine"];
export const ISOLATION_PROBE_FILE = "isolation-probe.mjs";

export interface IsolationPaths {
  readonly candidate: string;
  readonly writableSource: string;
  readonly buildOutput: string;
  readonly verifierScratch: string;
  readonly outside: string;
}

export interface IsolationInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface IsolationProbeReport {
  readonly sourceWrite: boolean;
  readonly siblingWriteDenied: boolean;
  readonly buildWrite: boolean;
  readonly scratchWrite: boolean;
  readonly outsideReadDenied: boolean;
  readonly credentialAbsent: boolean;
  readonly networkDenied: boolean;
  readonly descendantStarted: boolean;
}

export interface IsolationAssessment {
  readonly status: "passed" | "failed";
  readonly failedControls: readonly string[];
}

const operationalEnvironment = [
  "APPDATA", "ComSpec", "LOCALAPPDATA", "OS", "Path", "PATH", "PATHEXT",
  "PROCESSOR_ARCHITECTURE", "SystemDrive", "SystemRoot", "SYSTEMROOT", "TEMP",
  "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
] as const;

function safeHostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of operationalEnvironment) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function dockerMount(source: string, target: string, readonly = false): string {
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

function portableWindowsPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function containerRunPolicyArgs(name: string): readonly string[] {
  return [
    ...CONTAINER_ENGINE_ARGS, "run", "--name", name, "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--pids-limit=32",
    "--memory=128m", "--memory-swap=128m", "--cpus=1", "--log-driver=none",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
  ];
}

export function buildContainerInvocation(
  paths: IsolationPaths,
  name: string,
  networkPort = 43123,
  networkHost = "tesota-network-control",
): IsolationInvocation {
  const args = [
    ...containerRunPolicyArgs(name),
    "--mount", dockerMount(paths.candidate, "/workspace", true),
    "--mount", dockerMount(paths.writableSource, "/workspace/source/allowed.txt"),
    "--mount", dockerMount(paths.buildOutput, "/workspace-build"),
    "--mount", dockerMount(paths.verifierScratch, "/verifier-scratch"),
    "--workdir", "/workspace", "--entrypoint=node",
    "--env", "TESOTA_SOURCE=/workspace/source/allowed.txt",
    "--env", "TESOTA_SIBLING=/workspace/source/denied.txt",
    "--env", "TESOTA_BUILD=/workspace-build/output.txt",
    "--env", "TESOTA_SCRATCH=/verifier-scratch/output.txt",
    "--env", "TESOTA_LATE=/workspace-build/late.txt",
    "--env", "TESOTA_CHILD_READY=/verifier-scratch/child-ready.txt",
    "--env", "TESOTA_OUTSIDE=/host-outside/sentinel.txt",
    "--env", `TESOTA_NETWORK_HOST=${networkHost}`,
    "--env", `TESOTA_NETWORK_PORT=${networkPort}`,
    CONTAINER_IMAGE, ISOLATION_PROBE_FILE,
  ];
  return {
    command: "docker",
    args,
    cwd: paths.candidate,
    env: { ...safeHostEnvironment(), TESOTA_QUALIFICATION_SECRET: "synthetic-private" },
  };
}

function codexFilesystem(paths: IsolationPaths): string {
  const entries = [
    [":minimal", "read"],
    [portableWindowsPath(paths.candidate), "read"],
    [portableWindowsPath(paths.writableSource), "write"],
    [portableWindowsPath(paths.buildOutput), "write"],
    [portableWindowsPath(paths.verifierScratch), "write"],
  ];
  return `{${entries.map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(",")}}`;
}

export function buildCodexSandboxInvocation(paths: IsolationPaths, networkPort = 43123): IsolationInvocation {
  const probeEnvironment = {
    TESOTA_SOURCE: portableWindowsPath(paths.writableSource),
    TESOTA_SIBLING: portableWindowsPath(paths.candidate + "\\source\\denied.txt"),
    TESOTA_BUILD: portableWindowsPath(paths.buildOutput + "\\output.txt"),
    TESOTA_SCRATCH: portableWindowsPath(paths.verifierScratch + "\\output.txt"),
    TESOTA_LATE: portableWindowsPath(paths.buildOutput + "\\late.txt"),
    TESOTA_CHILD_READY: portableWindowsPath(paths.verifierScratch + "\\child-ready.txt"),
    TESOTA_OUTSIDE: portableWindowsPath(paths.outside),
    TESOTA_NETWORK_HOST: "127.0.0.1",
    TESOTA_NETWORK_PORT: String(networkPort),
  };
  const env = { ...safeHostEnvironment(), ...probeEnvironment, TESOTA_QUALIFICATION_SECRET: "synthetic-private" };
  const childEnvironment = [
    "Path", "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    ...Object.keys(probeEnvironment),
  ];
  const args = [
    "sandbox",
    "-c", `permissions.tesota-qualification.filesystem=${codexFilesystem(paths)}`,
    "-c", "permissions.tesota-qualification.network.enabled=false",
    "-c", `shell_environment_policy.include_only=${JSON.stringify(childEnvironment)}`,
    "-P", "tesota-qualification", "-C", paths.candidate,
    "node", ISOLATION_PROBE_FILE,
  ];
  return { command: "codex", args, cwd: paths.candidate, env };
}

export function assessIsolationProbe(
  report: IsolationProbeReport,
  lifecycle: { readonly canceled: boolean; readonly descendantSettled: boolean },
): IsolationAssessment {
  const controls = { ...report, ...lifecycle };
  const failedControls = Object.entries(controls).filter(([, passed]) => !passed).map(([control]) => control);
  return { status: failedControls.length === 0 ? "passed" : "failed", failedControls };
}

export const ISOLATION_PROBE_SOURCE: string = String.raw`
import { writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { connect } from "node:net";

async function succeeds(action) { try { await action(); return true; } catch { return false; } }
async function networkIsDenied() {
  return await new Promise((resolve) => {
    const socket = connect({ host: process.env.TESOTA_NETWORK_HOST, port: Number(process.env.TESOTA_NETWORK_PORT) });
    const finish = (denied) => { socket.destroy(); resolve(denied); };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(800, () => finish(true));
  });
}

const sourceWrite = await succeeds(() => writeFile(process.env.TESOTA_SOURCE, "qualified\n"));
const siblingWriteDenied = !await succeeds(() => writeFile(process.env.TESOTA_SIBLING, "escape\n"));
const buildWrite = await succeeds(() => writeFile(process.env.TESOTA_BUILD, "build\n"));
const scratchWrite = await succeeds(() => writeFile(process.env.TESOTA_SCRATCH, "scratch\n"));
const outsideReadDenied = !await succeeds(() => readFile(process.env.TESOTA_OUTSIDE));
const credentialAbsent = process.env.TESOTA_QUALIFICATION_SECRET === undefined;
const networkDenied = await networkIsDenied();
const childCode = "await import('node:fs/promises').then(m=>m.writeFile(process.env.TESOTA_CHILD_READY,'ready\\n'));setTimeout(async()=>{await import('node:fs/promises').then(m=>m.writeFile(process.env.TESOTA_LATE,'late\\n'))},2500)";
const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: "ignore" });
child.unref();
let descendantStarted = false;
for (let attempt = 0; attempt < 20 && !descendantStarted; attempt += 1) {
  descendantStarted = await succeeds(() => readFile(process.env.TESOTA_CHILD_READY));
  if (!descendantStarted) await new Promise(resolve => setTimeout(resolve, 50));
}
process.stdout.write(JSON.stringify({ sourceWrite, siblingWriteDenied, buildWrite, scratchWrite, outsideReadDenied, credentialAbsent, networkDenied, descendantStarted }) + "\nTESOTA_PROBE_READY\n");
setInterval(() => {}, 1000);
`;
