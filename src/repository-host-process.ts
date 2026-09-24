import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { readRepositoryInput, sha256 } from "./repository-check-input.js";
import type { RepositoryContainerLimits, RepositoryContainerProcessObservation } from "./repository-container-process.js";

export interface HostNodeRuntimeIdentity {
  readonly executable: string;
  readonly executableSha256: string;
}

function insideProtectedPath(executable: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((path) => {
    const fromPath = relative(path, executable);
    return fromPath === "" || !isAbsolute(fromPath) && fromPath !== ".." && !fromPath.startsWith(`..${sep}`);
  });
}

/** The local route is trusted-host execution, not an OS sandbox. */
export async function resolveHostNodeRuntime(protectedPaths: readonly string[]): Promise<HostNodeRuntimeIdentity> {
  if (process.platform !== "win32") throw new Error("Host-local repository checks currently require Windows");
  const protectedRoots = await Promise.all(protectedPaths.map((path) => realpath(path)));
  const paths = process.env["Path"] ?? process.env["PATH"] ?? "";
  const candidates = [process.execPath, ...paths.split(delimiter).filter((path) => isAbsolute(path))
    .map((path) => join(path, "node.exe"))];
  let executable: string | undefined;
  for (const candidate of candidates) {
    if (basename(candidate).toLowerCase() !== "node.exe") continue;
    let resolved: string;
    try { resolved = await realpath(candidate); } catch { continue; }
    if (insideProtectedPath(resolved, protectedRoots)) continue;
    executable = resolved;
    break;
  }
  if (executable === undefined) throw new Error("Host-local Node runtime unavailable");
  return { executable, executableSha256: sha256(await readRepositoryInput(executable, 128 * 1024 * 1024)) };
}

export function hostProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export function executeRepositoryHostProcess(executable: string, args: readonly string[], cwd: string,
  limits: RepositoryContainerLimits, signal?: AbortSignal): Promise<RepositoryContainerProcessObservation> {
  if (signal?.aborted === true) return Promise.resolve({ status: "failed", reason: "cancelled",
    process: "not_started", container: "absent" });
  return new Promise((settle) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, [...args], { cwd, env: hostProcessEnvironment(), shell: false,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      settle({ status: "failed", reason: "spawn_failed", process: "not_started", container: "absent" });
      return;
    }
    let finished = false;
    let stopping: "timeout" | "cancelled" | "output_limit" | "process_error" | null = null;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RepositoryContainerProcessObservation): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (stopDeadline !== undefined) clearTimeout(stopDeadline);
      signal?.removeEventListener("abort", cancel);
      settle(result);
    };
    const stop = (reason: NonNullable<typeof stopping>): void => {
      if (finished || stopping !== null) return;
      stopping = reason;
      if (child.pid !== undefined) {
        const systemRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
        if (systemRoot !== undefined) {
          spawnSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, shell: false, timeout: limits.terminationWaitMs, stdio: "ignore" });
        }
      }
      try { child.kill("SIGKILL"); } catch { /* Settlement remains unconfirmed. */ }
      stopDeadline = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish({ status: "failed", reason, process: "unconfirmed", container: "absent",
          ...(child.pid === undefined ? {} : { pid: child.pid }) });
      }, limits.terminationWaitMs);
    };
    const cancel = (): void => stop("cancelled");
    const timeout = setTimeout(() => stop("timeout"), limits.timeoutMs);
    const capture = (chunk: Buffer, destination: Buffer[]): void => {
      if (finished || stopping !== null) return;
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) stop("output_limit");
      else destination.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, stderr));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true) cancel();
    child.once("error", () => {
      if (child.pid === undefined) finish({ status: "failed", reason: "spawn_failed", process: "not_started", container: "absent" });
      else stop("process_error");
    });
    child.once("close", (exitCode, closeSignal) => {
      if (stopping !== null) finish({ status: "failed", reason: stopping, process: "unconfirmed", container: "absent",
        ...(child.pid === undefined ? {} : { pid: child.pid }) });
      else finish({ status: "closed", exitCode, signal: closeSignal, stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr), process: "exited", container: "absent" });
    });
  });
}
