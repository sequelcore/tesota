import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { runProcess } from "../../../../src/process.ts";
import type { EngineTool, ToolOutput } from "../tool.ts";
import { keepTail, type Kept, maxBytes } from "../truncate.ts";

/** The shell the agent's commands run in, as the model is told about it. */
export interface Shell {
  readonly tool: "bash" | "powershell";
  readonly executable: string;
  /** What the model is told it runs, such as "PowerShell 7 (pwsh)". */
  readonly label: string;
  args(command: string): string[];
}

/** PowerShell writes UTF-8 only when told to; Windows PowerShell 5.1 does not by default. */
const utf8 = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";

export function powershell(executable: string, version: 5 | 7): Shell {
  return {
    tool: "powershell",
    executable,
    label: version === 7 ? "PowerShell 7 (pwsh)" : "Windows PowerShell 5.1",
    args: (command) => ["-NoProfile", "-NonInteractive", "-Command", utf8 + command],
  };
}

export function bash(executable: string): Shell {
  return { tool: "bash", executable, label: "bash", args: (command) => ["-c", command] };
}

/**
 * The platform's own shell: PowerShell 7 on Windows when installed, otherwise
 * Windows PowerShell 5.1, which Windows always has; bash elsewhere. Git Bash
 * is not used: its paths are not the paths Windows tools take.
 */
export function platformShell(): Shell {
  if (process.platform !== "win32") return bash(Bun.which("bash") ?? "/bin/bash");
  const pwsh = Bun.which("pwsh");
  return pwsh !== null ? powershell(pwsh, 7)
    : powershell(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), 5);
}

const parameters = Type.Object({
  command: Type.String({ description: "Command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** Output beyond this stays on disk; the model gets the end of it. */
const spoolAfter = 2 * maxBytes;

/** A call's file prefix, safe even when the provider's id contains Windows path characters. */
export function outputPrefix(callId: string): string {
  return `${createHash("sha256").update(callId).digest("hex").slice(0, 24)}-`;
}

/** Collects every byte in a file from the start, keeping the end in memory. */
class Capture {
  #size = 0;
  #tail = Buffer.alloc(0);
  #file: number | undefined;
  #saved: string | undefined;
  #failed: string | undefined;
  constructor(path: () => string) {
    try {
      const saved = path();
      this.#file = openSync(saved, "wx");
      this.#saved = saved;
    } catch (error) {
      this.#failed = error instanceof Error ? error.message : String(error);
    }
  }
  add(chunk: Buffer): void {
    this.#size += chunk.length;
    this.#tail = Buffer.concat([this.#tail, chunk]).subarray(-spoolAfter);
    if (this.#file !== undefined) {
      try {
        for (let written = 0; written < chunk.length;) written += writeSync(this.#file, chunk, written);
      } catch (error) {
        this.#failed = error instanceof Error ? error.message : String(error);
        this.close();
      }
    }
  }
  close(): void {
    const file = this.#file;
    this.#file = undefined;
    if (file === undefined) return;
    try { closeSync(file); }
    catch (error) { this.#failed ??= error instanceof Error ? error.message : String(error); }
  }
  /** The output's end and the file holding all of it, or why that file could not be saved. */
  finish(): { kept: Kept; spooled: string | undefined; failed: string | undefined } {
    this.close();
    const lines = outputLines(this.#tail.toString("utf8"));
    const cut = this.#size > spoolAfter;
    const kept = keepTail(cut && lines.length > 1 ? lines.slice(1) : lines);
    if (this.#saved !== undefined && (!cut || this.#failed !== undefined)) {
      try { unlinkSync(this.#saved); }
      catch (error) { this.#failed ??= error instanceof Error ? error.message : String(error); }
      this.#saved = undefined;
    }
    return { kept, spooled: this.#saved, failed: cut || kept.truncated ? this.#failed : undefined };
  }
}

function outputLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** How a run ended, for the model, after its output. */
function ending(run: Awaited<ReturnType<typeof runProcess>>, timeout: number | undefined): string | undefined {
  if (run.ended === "timed_out") return `Command timed out after ${timeout} seconds.`;
  if (run.ended === "cancelled") return "Command was stopped.";
  if (run.ended === "not_started") return `Command could not start: ${run.output}`;
  return run.exitCode === 0 ? undefined : `Command exited with code ${run.exitCode}.`;
}

/**
 * Runs a command in `shell` from the session's folder. The model gets the
 * end of the output, at most Pi's limits; longer output is written to a
 * file under `spool()` and its path given. A timeout or a stop ends every
 * process the command started.
 */
export function shellTool(cwd: string, shell: Shell, spool: () => string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: shell.tool,
    access: "run",
    description: `Run a command in ${shell.label} from the session's folder. Returns stdout and stderr together and fails `
      + `when the command exits with a non-zero code. Long output keeps its end; the rest is saved to a file.`
      + (shell.label === "Windows PowerShell 5.1" ? " Windows PowerShell 5.1 has no && or ||: separate commands with ; "
        + "and check $? or $LASTEXITCODE." : ""),
    parameters,
    async execute({ command, timeout }, signal, callId): Promise<ToolOutput> {
      const capture = new Capture(() => join(spool(), `${outputPrefix(callId)}${randomUUID().slice(0, 8)}.txt`));
      let run: Awaited<ReturnType<typeof runProcess>>;
      try {
        run = await runProcess(shell.executable, shell.args(command), cwd, signal,
          timeout === undefined ? undefined : timeout * 1000, (chunk) => { capture.add(chunk); });
      } finally {
        capture.close();
      }
      const { kept, spooled, failed } = capture.finish();
      const notes = [
        spooled !== undefined ? `[Output truncated: showing the last ${kept.lines} lines. Full output: ${spooled}]`
          : failed !== undefined ? `[Output truncated: showing the last ${kept.lines} lines. The full output could not be saved: ${failed}]`
          : kept.truncated ? `[Output truncated: showing the last ${kept.lines} of ${kept.total} lines.]` : undefined,
        ending(run, timeout),
      ].filter((note) => note !== undefined);
      const text = [kept.text, ...notes].filter((part) => part !== "").join("\n\n");
      return { text: text === "" ? "(no output)" : text, isError: run.ended !== "exited" || run.exitCode !== 0 };
    },
  };
  return tool as EngineTool;
}
