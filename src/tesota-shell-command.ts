import { homedir } from "node:os";
import { resolve } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { runRepositoryConversationForShell, type ConversationCommandResult } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { runTesotaShell } from "./tesota-shell.js";
import { createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import { startTask, type TaskStartProgress } from "./task-start.js";
import { runProposalTask } from "./task-run.js";

export interface TesotaShellCommandDependencies {
  readonly surface: TesotaShellTerminal;
  readonly discover: (input: ConversationInput) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void) => Promise<number>;
}

export function createProcessTesotaShell(cwd: string = process.cwd()): TesotaShellCommandDependencies {
  const cancellation = new AbortController();
  const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
  const interrupt = (): void => {
    cancellation.abort();
    process.emit("SIGINT");
  };
  const surface = createTesotaShellTerminal({ cwd, tui, interrupt });
  return {
    surface,
    discover: (input) => runRepositoryConversationForShell(input, (text) => { surface.write(text); }),
    start: (proposalId, report) => startTask({
      proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
      sourceDirectory: cwd,
      reference: proposalId,
      ask: (prompt) => surface.ask(prompt),
      write: (text) => { surface.write(text); },
      report,
      execute: (grant) => runProposalTask(grant, {
        signal: cancellation.signal,
        write: (text) => { surface.write(text); },
        writeError: (text) => { surface.write(text); },
        exitUnsettled: (code) => {
          surface.stop();
          process.exit(code);
        },
      }),
    }),
  };
}

export async function runTesotaShellCommand(
  dependencies: TesotaShellCommandDependencies = createProcessTesotaShell(),
): Promise<number> {
  const { surface } = dependencies;
  surface.start();
  try {
    return await runTesotaShell({
      ask: (prompt) => surface.ask(prompt),
      write: (text) => { surface.write(text); },
      discover: dependencies.discover,
      start: dependencies.start,
      report: (progress: TesotaShellProgress) => { surface.report(progress); },
    });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    surface.write(cancelled
      ? "Tesota session cancelled. Inspect retained evidence before retrying.\n"
      : "Tesota session failed. Inspect retained evidence before retrying.\n");
    return cancelled ? 130 : 1;
  } finally {
    surface.stop();
  }
}
