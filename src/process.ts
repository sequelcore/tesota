import { spawn } from "node:child_process";
import { join } from "node:path";

/** How a process run ended: it exited, ran past its limit, was stopped, or could not start. */
export interface ProcessRun {
  readonly ended: "exited" | "timed_out" | "cancelled" | "not_started";
  /** Its exit code when it exited; null otherwise. */
  readonly exitCode: number | null;
  /** The end of what it printed, or why it did not start. */
  readonly output: string;
}

const outputLimit = 8 * 1024;
// A process that exits while a descendant still holds its output never closes it; the run ends this long after the exit.
const closeGraceMs = 2_000;

/** Stop a process and every process it started: `taskkill /T` on Windows, the process group elsewhere. */
function stopTree(pid: number): void {
  if (process.platform === "win32") {
    spawn(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
      { stdio: "ignore", windowsHide: true }).once("error", () => undefined);
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

/**
 * Run `executable` with `args` from `cwd`, without a shell between, keeping
 * the end of what it prints. A run past `timeoutMs`, or one `signal` stops,
 * ends with every process it started. Tesota starts and stops every process
 * it runs for a verifier here.
 */
export function runProcess(executable: string, args: readonly string[], cwd: string, signal: AbortSignal,
  timeoutMs: number): Promise<ProcessRun> {
  if (signal.aborted) return Promise.resolve({ ended: "cancelled", exitCode: null, output: "" });
  return new Promise((settle) => {
    let output = "";
    let timedOut = false;
    const child = spawn(executable, [...args], { cwd, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-outputLimit); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = (): void => { if (child.pid !== undefined) stopTree(child.pid); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    let grace: NodeJS.Timeout | undefined;
    const finish = (run: ProcessRun): void => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal.removeEventListener("abort", stop);
      settle(run);
    };
    const ended = (code: number | null): ProcessRun => signal.aborted ? { ended: "cancelled", exitCode: null, output }
      : timedOut ? { ended: "timed_out", exitCode: null, output } : { ended: "exited", exitCode: code, output };
    child.once("error", (error) => { finish({ ended: "not_started", exitCode: null, output: error.message }); });
    child.once("exit", (code) => { grace = setTimeout(() => { finish(ended(code)); }, closeGraceMs); });
    child.once("close", (code) => { finish(ended(code)); });
  });
}
