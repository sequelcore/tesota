import { spawn } from "node:child_process";
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

/**
 * Run `executable` with `args` from `cwd`, without a shell between, keeping
 * the end of what it prints and passing all of it to `onOutput` as it comes.
 * A run past `timeoutMs`, when there is one, or one `signal` stops, ends
 * with every process it started, and reports only after they have stopped.
 * Tesota starts and stops every process it runs for a verifier and for the
 * agent's shell here.
 */
export function runProcess(executable: string, args: readonly string[], cwd: string, signal: AbortSignal,
  timeoutMs: number | undefined, onOutput?: (chunk: Buffer) => void, options: ProcessOptions = {}): Promise<ProcessRun> {
  if (signal.aborted) return Promise.resolve({ ended: "cancelled", exitCode: null, output: "", stdout: "", stderr: "" });
  return new Promise((settle) => {
    let output = "";
    const streams = { stdout: "", stderr: "" };
    let timedOut = false;
    let stopping: Promise<void> | undefined;
    let finished = false;
    const child = spawn(executable, [...args], { cwd, windowsHide: true, detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...options.env === undefined ? {} : { env: options.env }, windowsVerbatimArguments: options.verbatim === true });
    const append = (stream: keyof typeof streams) => (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-outputLimit);
      if (streams[stream].length < streamLimit) streams[stream] = (streams[stream] + text).slice(0, streamLimit);
      onOutput?.(chunk);
    };
    child.stdout?.on("data", append("stdout"));
    child.stderr?.on("data", append("stderr"));
    if (options.input !== undefined && child.stdin !== null) {
      // A process that exits before reading all of it closes the pipe: that is its business, not the run's failure.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
    const stop = (): void => { if (child.pid !== undefined) stopping ??= stopTree(child.pid); };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    let grace: NodeJS.Timeout | undefined;
    const finish = (run: ProcessRun): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal.removeEventListener("abort", stop);
      void (stopping ?? Promise.resolve()).then(() => { settle(run); });
    };
    const ended = (code: number | null): ProcessRun => signal.aborted ? { ended: "cancelled", exitCode: null, output, ...streams }
      : timedOut ? { ended: "timed_out", exitCode: null, output, ...streams } : { ended: "exited", exitCode: code, output, ...streams };
    child.once("error", (error) => { finish({ ended: "not_started", exitCode: null, output: error.message, stdout: "", stderr: "" }); });
    child.once("exit", (code) => { grace = setTimeout(() => { finish(ended(code)); }, closeGraceMs); });
    child.once("close", (code) => { finish(ended(code)); });
  });
}
