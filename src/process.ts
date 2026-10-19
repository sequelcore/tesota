import { type ChildProcess, spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { join } from "node:path";

/** How a process run ended: it exited, ran past its limit, was stopped, or could not start. */
export interface ProcessRun {
  readonly ended: "exited" | "timed_out" | "cancelled" | "not_started";
  /** Its exit code when it exited; null otherwise. */
  readonly exitCode: number | null;
  /** The end of what it printed, or why it did not start. */
  readonly output: string;
  /** The start of what it wrote to each stream, apart, up to 64 KiB each: a hook's answer and its reason (#457). */
  readonly stdout: string;
  readonly stderr: string;
}

/** What else a run may need: text for its standard input, its environment, and on Windows its command line as written. */
export interface ProcessOptions {
  /** Standard output apart from errors, for tools that consume a process's records. */
  readonly onStdout?: (chunk: Buffer) => void;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Windows: pass `args` to the process unquoted, as `cmd.exe` needs a command line it reads itself. */
  readonly verbatim?: boolean;
}

const outputLimit = 8 * 1024;
const streamLimit = 64 * 1024;
// A process that exits while a descendant still holds its output never closes it; the run ends this long after the exit.
const closeGraceMs = 2_000;

/**
 * Stop a process and every process it started: `taskkill /T` on Windows, the
 * process group elsewhere. Resolves once `taskkill` has finished, so a
 * stopped run reports only after its processes are gone.
 */
function stopTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((done) => {
      spawn(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true }).once("error", () => { done(); }).once("exit", () => { done(); });
    });
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  return Promise.resolve();
}

/** kernel32's job functions as Bun's FFI binds them (#490). */
interface Kernel32Jobs {
  CreateJobObjectW(attributes: null, name: null): unknown;
  OpenProcess(access: number, inherit: number, pid: number): unknown;
  AssignProcessToJobObject(job: unknown, process: unknown): number;
  TerminateJobObject(job: unknown, exitCode: number): number;
  CloseHandle(handle: unknown): number;
}

/** A failed call's handle: null, or zero as a number or a bigint, as Bun gives a pointer. */
const isNull = (handle: unknown): boolean => handle === null || handle === 0 || handle === 0n;

// Named apart so that Node, which has no `bun:ffi` and runs the root tests, never resolves it.
const bunFfi = "bun:ffi";
let kernel32: Promise<Kernel32Jobs | undefined> | undefined;

/**
 * kernel32's job functions, on Windows under Bun, which runs Tesota; none
 * under Node or elsewhere. Loaded once, when a process is first run.
 */
function windowsJobs(): Promise<Kernel32Jobs | undefined> {
  kernel32 ??= (async () => {
    if (process.platform !== "win32" || process.versions["bun"] === undefined) return undefined;
    const { dlopen, FFIType } = await import(bunFfi) as {
      dlopen(name: string, symbols: Record<string, { args: number[]; returns: number }>): { symbols: Kernel32Jobs };
      FFIType: Record<"ptr" | "u32" | "i32", number>;
    };
    return dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
  })();
  return kernel32;
}

/**
 * A Windows job holding the process `pid` and every process it starts, which
 * inherit it however their parents come and go: Git's bash runs a script
 * through a process that exits, which breaks the parent chain `taskkill /T`
 * follows (#490). Undefined when the process could not be put in one.
 */
function jobFor(jobs: Kernel32Jobs, pid: number): unknown {
  const job = jobs.CreateJobObjectW(null, null);
  if (isNull(job)) return undefined;
  const processSetQuota = 0x0100, processTerminate = 0x0001;
  const handle = jobs.OpenProcess(processSetQuota | processTerminate, 0, pid);
  const assigned = !isNull(handle) && jobs.AssignProcessToJobObject(job, handle) !== 0;
  if (!isNull(handle)) jobs.CloseHandle(handle);
  if (assigned) return job;
  jobs.CloseHandle(job);
  return undefined;
}

/** What a run collects as it goes: the end of what it printed, and the start of each stream apart. */
interface Collected { output: string; stdout: string; stderr: string }

/** The process's end: its exit code once its output closed, or this long after it exited if a descendant holds the output. */
const closed = (child: ChildProcess): Effect.Effect<number | null, Error> => Effect.callback<number | null, Error>((resume) => {
  let grace: NodeJS.Timeout | undefined;
  child.once("error", (error) => { resume(Effect.fail(error)); });
  child.once("exit", (code) => { grace = setTimeout(() => { resume(Effect.succeed(code)); }, closeGraceMs); });
  child.once("close", (code) => { resume(Effect.succeed(code)); });
  // Interrupted by a stop or the time limit: the grace timer must not outlive the run.
  return Effect.sync(() => { clearTimeout(grace); });
});

/**
 * Run `executable` with `args` from `cwd`, without a shell between, keeping
 * the end of what it prints and passing all of it to `onOutput` as it comes.
 * A run past `timeoutMs`, when there is one, or one `signal` stops, ends
 * with every process it started, and reports only after they have stopped.
 * Tesota starts and stops every process it runs for a verifier and for the
 * agent's shell here. The run is an Effect: the process is a resource whose
 * release stops its tree whatever ended the run, so a stop and the time limit
 * are interruptions, not flags to check.
 */
export async function runProcess(executable: string, args: readonly string[], cwd: string, signal: AbortSignal,
  timeoutMs: number | undefined, onOutput?: (chunk: Buffer) => void, options: ProcessOptions = {}): Promise<ProcessRun> {
  const got: Collected = { output: "", stdout: "", stderr: "" };
  const result = (ended: ProcessRun["ended"], exitCode: number | null = null): ProcessRun => ({ ended, exitCode, ...got });
  if (signal.aborted) return result("cancelled");
  const append = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    got.output = (got.output + text).slice(-outputLimit);
    if (got[stream].length < streamLimit) got[stream] = (got[stream] + text).slice(0, streamLimit);
    onOutput?.(chunk);
    if (stream === "stdout") options.onStdout?.(chunk);
  };
  const jobs = await windowsJobs();
  const start = Effect.sync(() => {
    const child = spawn(executable, [...args], { cwd, windowsHide: true, detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...options.env === undefined ? {} : { env: options.env }, windowsVerbatimArguments: options.verbatim === true });
    child.stdout?.on("data", append("stdout"));
    child.stderr?.on("data", append("stderr"));
    if (options.input !== undefined && child.stdin !== null) {
      // A process that exits before reading all of it closes the pipe: that is its business, not the run's failure.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
    // Put in its job before it can start anything, so all it starts is in the job too.
    return { child, job: jobs === undefined || child.pid === undefined ? undefined : jobFor(jobs, child.pid) };
  });
  // A run a stop or the time limit ended has its processes stopped before it reports: on Windows its whole job, however
  // their parents came and went; elsewhere, or without a job, its tree. One that ended by itself leaves what outlived it.
  const stop = ({ child, job }: { child: ChildProcess; job: unknown }, exit: Exit.Exit<Option.Option<number | null>, Error>) =>
    Effect.promise(async () => {
      const stopped = !Exit.isSuccess(exit) || Option.isNone(exit.value) || (child.exitCode === null && child.signalCode === null);
      const closed = stopped && child.pid !== undefined && child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); }) : Promise.resolve();
      if (stopped && jobs !== undefined && job !== undefined) jobs.TerminateJobObject(job, 1);
      else if (stopped && child.pid !== undefined) await stopTree(child.pid);
      await closed;
      if (jobs !== undefined && job !== undefined) jobs.CloseHandle(job);
    });
  const run = Effect.acquireUseRelease(start, ({ child }) => {
    const ended = closed(child);
    return timeoutMs === undefined ? Effect.map(ended, Option.some) : Effect.timeoutOption(ended, timeoutMs);
  }, stop);
  try {
    const code = await Effect.runPromise(run, { signal });
    return Option.isSome(code) ? result("exited", code.value) : result("timed_out");
  } catch (error) {
    if (signal.aborted) return result("cancelled");
    return { ended: "not_started", exitCode: null, output: error instanceof Error ? error.message : String(error), stdout: "", stderr: "" };
  }
}
