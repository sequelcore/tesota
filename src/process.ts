import { type ChildProcess, spawn } from "node:child_process";
import { Effect, Option } from "effect";
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
  };
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
    return child;
  });
  // Whatever ended the run, a process still running is stopped with its tree before the run reports.
  const stop = (child: ChildProcess) => Effect.promise(() => child.exitCode === null && child.signalCode === null && child.pid !== undefined
    ? stopTree(child.pid) : Promise.resolve());
  const run = Effect.acquireUseRelease(start, (child) => {
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
