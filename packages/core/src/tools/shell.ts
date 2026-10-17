import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { runProcess } from "../../../../src/process.ts";
import type { EngineTool, ToolOutput } from "../tool.ts";
import { keepTail, maxBytes } from "../truncate.ts";

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

/** Collects what a command prints: all of it in memory while it is small, then to a file, keeping the end in memory. */
class Capture {
  #small: Buffer[] = [];
  #size = 0;
  #tail = Buffer.alloc(0);
  #file: WriteStream | undefined;
  readonly #path: () => string;
  constructor(path: () => string) { this.#path = path; }
  add(chunk: Buffer): void {
    this.#size += chunk.length;
    this.#tail = Buffer.concat([this.#tail, chunk]).subarray(-spoolAfter);
    if (this.#file === undefined && this.#size > spoolAfter) {
      this.#file = createWriteStream(this.#path());
      for (const part of this.#small) this.#file.write(part);
      this.#small = [];
    }
    if (this.#file !== undefined) this.#file.write(chunk);
    else this.#small.push(chunk);
  }
  /** The output's lines, without a partial first line when only the end was kept, and the file holding all of it. */
  async finish(): Promise<{ lines: string[]; spooled: string | undefined }> {
    const file = this.#file;
    if (file === undefined) return { lines: outputLines(Buffer.concat(this.#small).toString("utf8")), spooled: undefined };
    await new Promise<void>((done) => { file.end(done); });
    return { lines: outputLines(this.#tail.toString("utf8")).slice(1), spooled: file.path.toString() };
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
  let runs = 0;
  const tool: EngineTool<typeof parameters> = {
    name: shell.tool,
    access: "run",
    description: `Run a command in ${shell.label} from the session's folder. Returns stdout and stderr together and fails `
      + `when the command exits with a non-zero code. Long output keeps its end; the rest is saved to a file.`
      + (shell.label === "Windows PowerShell 5.1" ? " Windows PowerShell 5.1 has no && or ||: separate commands with ; "
        + "and check $? or $LASTEXITCODE." : ""),
    parameters,
    async execute({ command, timeout }, signal): Promise<ToolOutput> {
      const capture = new Capture(() => join(spool(), `output-${++runs}.txt`));
      const run = await runProcess(shell.executable, shell.args(command), cwd, signal,
        timeout === undefined ? undefined : timeout * 1000, (chunk) => { capture.add(chunk); });
      const { lines, spooled } = await capture.finish();
      const kept = keepTail(lines);
      const notes = [
        spooled !== undefined ? `[Output truncated: showing the last ${kept.lines} lines. Full output: ${spooled}]`
          : kept.truncated ? `[Output truncated: showing the last ${kept.lines} of ${kept.total} lines.]` : undefined,
        ending(run, timeout),
      ].filter((note) => note !== undefined);
      const text = [kept.text, ...notes].filter((part) => part !== "").join("\n\n");
      return { text: text === "" ? "(no output)" : text, isError: run.ended !== "exited" || run.exitCode !== 0 };
    },
  };
  return tool as EngineTool;
}
