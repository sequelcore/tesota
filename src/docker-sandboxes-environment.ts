import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EnvironmentGuarantees, ExecutionEnvironment, ExecutionProvider, ProviderReadiness, RunOptions,
  RunResult, SetupStep } from "./execution-environment.js";

/**
 * Commands run in a Docker Sandboxes microVM per workspace. Only the workspace
 * is mounted, egress goes through the host proxy under a deny-all policy with
 * per-sandbox allow rules, and CPU and memory are capped. These guarantees were
 * observed on 2026-09-26 (decision 014); the live qualification suite reruns them.
 */
const guarantees: EnvironmentGuarantees = Object.freeze({
  filesystem: "workspace", network: "allowlist", secrets: "none", resources: "bounded",
});

/** Package registries every sandbox may reach; anything else is refused by the proxy. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org",
]);

const commandTimeoutMs = 120_000;
const daemonStartMs = 30_000;
const stopAttempts = 3;

interface Invocation { readonly status: number | null; readonly stdout: string; readonly stderr: string }

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
  const query = await invoke("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
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

function sandboxName(workspace: string): string {
  return `tesota-${createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 16)}`;
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

function sandboxEnvironment(sbx: string, name: string, workspace: string): ExecutionEnvironment {
  return {
    provider: "docker-sandboxes",
    guarantees,
    async run(command: string, options: RunOptions): Promise<RunResult> {
      if (!contains(workspace, resolve(options.cwd))) return { outcome: "not_started", exitCode: null };
      if (options.signal?.aborted === true) return { outcome: "cancelled", exitCode: null };
      const tag = `TESOTA_RUN=${randomUUID()}`;
      const variables = Object.entries(options.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
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
      if (stopping !== undefined) return { outcome: await stopped ? stopping : "unconfirmed", exitCode: null };
      if (exit === "error") return { outcome: "not_started", exitCode: null };
      return { outcome: "exited", exitCode: exit ?? 1 };
    },
    dispose: async () => {},
  };
}

async function readinessSteps(): Promise<SetupStep[]> {
  if (!await hypervisorPlatformEnabled()) {
    return [{ description: "Turn on the Windows Hypervisor Platform", elevated: true, restart: true,
      command: "Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All" }];
  }
  const sbx = await locateSbx();
  if (sbx === null) return [{ description: "Install Docker Sandboxes", command: "winget install -h Docker.sbx" }];
  if (!await ensureDaemon(sbx)) return [{ description: "Start the Docker Sandboxes daemon", command: "sbx daemon start" }];
  if ((await invoke(sbx, ["ls"])).status !== 0) return [{ description: "Sign in to Docker", command: "sbx login" }];
  const policy = await invoke(sbx, ["policy", "ls"]);
  if (policy.status !== 0 || !policy.stdout.includes("default-deny-all")) {
    return [{ description: "Block all sandbox network traffic by default", command: "sbx policy init deny-all" }];
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
  async prepare(workspace: string): Promise<ExecutionEnvironment> {
    const sbx = await locateSbx();
    if (sbx === null || !await ensureDaemon(sbx)) throw new Error("Docker Sandboxes is not available");
    const name = sandboxName(workspace);
    const listed = await invoke(sbx, ["ls"]);
    if (listed.status !== 0) throw new Error("Docker Sandboxes is not signed in");
    if (!listed.stdout.split(/\r?\n/u).some((line) => line.split(/\s+/u)[0] === name)) {
      const created = await invoke(sbx, ["create", "shell", workspace, "--name", name, "--cpus", String(Math.max(2, Math.floor(cpus().length / 2))),
        "--memory", `${Math.max(2, Math.min(8, Math.floor(totalmem() / 2 ** 31)))}g`, "--quiet"], 300_000);
      if (created.status !== 0) throw new Error("The sandbox could not be created");
      const allowed = await invoke(sbx, ["policy", "allow", "network", "--sandbox", name, DEFAULT_ALLOWED_HOSTS.join(",")]);
      if (allowed.status !== 0) {
        await invoke(sbx, ["rm", "--force", name]);
        throw new Error("The sandbox network rules could not be set");
      }
    }
    return sandboxEnvironment(sbx, name, resolve(workspace));
  },
  async release(workspace: string): Promise<void> {
    const sbx = await locateSbx();
    if (sbx !== null) await invoke(sbx, ["rm", "--force", sandboxName(workspace)]);
  },
};
