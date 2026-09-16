import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { CONTAINER_ENGINE_ARGS, type IsolationInvocation } from "./command-isolation.js";

export interface RepositoryContainerLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminationWaitMs: number;
}

export type RepositoryContainerProcessObservation =
  | Readonly<{ status: "closed"; exitCode: number | null; signal: NodeJS.Signals | null;
    stdout: Buffer; stderr: Buffer; process: "exited"; container: "absent" }>
  | Readonly<{ status: "failed"; reason: "spawn_failed" | "timeout" | "cancelled" | "output_limit" |
    "process_error" | "cleanup_unconfirmed"; process: "not_started" | "exited" | "unconfirmed";
    container: "absent" | "unconfirmed"; pid?: number }>;

export type RepositoryContainerExecutor = (invocation: IsolationInvocation, containerName: string,
  limits: RepositoryContainerLimits, signal?: AbortSignal) => Promise<RepositoryContainerProcessObservation>;

function containerAbsent(executable: string, name: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const removed = spawnSync(executable, [...CONTAINER_ENGINE_ARGS, "rm", "--force", name], {
      env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
    });
    if (removed.error === undefined && removed.status === 0) return true;
    const inspected = spawnSync(executable, [...CONTAINER_ENGINE_ARGS, "container", "inspect", name], {
      env, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
    });
    return inspected.error === undefined && inspected.status !== 0 && /no such (?:object|container)/iu.test(inspected.stderr);
  } catch { return false; }
}

/** Settle the Docker client and named container independently for admitted repository checks. */
export function executeRepositoryContainer(invocation: IsolationInvocation, containerName: string,
  limits: RepositoryContainerLimits, signal?: AbortSignal): Promise<RepositoryContainerProcessObservation> {
  if (signal?.aborted === true) return Promise.resolve({ status: "failed", reason: "cancelled",
    process: "not_started", container: "absent" });
  return new Promise((settle) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(invocation.command, [...invocation.args], { cwd: invocation.cwd, env: invocation.env,
        shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      settle({ status: "failed", reason: "spawn_failed", process: "not_started", container: "absent" });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let done = false;
    let failure: "timeout" | "cancelled" | "output_limit" | "process_error" | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RepositoryContainerProcessObservation): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (deadline !== undefined) clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      settle(result);
    };
    const failed = (reason: NonNullable<typeof failure>, processState: "exited" | "unconfirmed", absent: boolean): void => {
      finish({ status: "failed", reason: absent ? reason : "cleanup_unconfirmed", process: processState,
        container: absent ? "absent" : "unconfirmed", ...(child.pid === undefined ? {} : { pid: child.pid }) });
    };
    const stop = (reason: NonNullable<typeof failure>): void => {
      if (failure !== undefined || done) return;
      failure = reason;
      try { child.kill("SIGKILL"); } catch { /* Reconciliation below remains authoritative. */ }
      if (containerAbsent(invocation.command, containerName, invocation.env)) {
        deadline = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); failed(reason, "unconfirmed", true); },
          limits.terminationWaitMs);
      } else finish({ status: "failed", reason: "cleanup_unconfirmed", process: "unconfirmed",
        container: "unconfirmed", ...(child.pid === undefined ? {} : { pid: child.pid }) });
    };
    const cancel = (): void => { stop("cancelled"); };
    const timeout = setTimeout(() => stop("timeout"), limits.timeoutMs);
    const capture = (chunk: Buffer, destination: Buffer[]): void => {
      if (done || failure !== undefined) return;
      capturedBytes += chunk.length;
      if (capturedBytes > limits.maxOutputBytes) stop("output_limit");
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
      const absent = containerAbsent(invocation.command, containerName, invocation.env);
      if (!absent) {
        finish({ status: "failed", reason: "cleanup_unconfirmed", process: "exited", container: "unconfirmed",
          ...(child.pid === undefined ? {} : { pid: child.pid }) });
      } else if (failure !== undefined) failed(failure, "exited", true);
      else finish({ status: "closed", exitCode, signal: closeSignal, stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr), process: "exited", container: "absent" });
    });
  });
}
