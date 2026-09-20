import { homedir } from "node:os";
import { resolve } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { runRepositoryConversationForShell, type ConversationCommandResult } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { runTesotaShell } from "./tesota-shell.js";
import { createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import { startTask, type TaskStartProgress, type TaskStartResult } from "./task-start.js";
import { runProposalTask } from "./task-run.js";

export interface TesotaShellCommandDependencies {
  readonly surface: TesotaShellTerminal;
  readonly discover: (input: ConversationInput) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void) => Promise<TaskStartResult>;
}

export function createProcessTesotaShell(cwd: string = process.cwd()): TesotaShellCommandDependencies {
  let activeOperation: AbortController | undefined;
  const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
  const interrupt = (): void => { activeOperation?.abort(); };
  const runOperation = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (activeOperation !== undefined) throw new Error("Tesota Shell operation already active");
    const cancellation = new AbortController();
    activeOperation = cancellation;
    try { return await operation(cancellation.signal); }
    finally {
      if (activeOperation === cancellation) activeOperation = undefined;
    }
  };
  const surface = createTesotaShellTerminal({ cwd, tui, interrupt });
  return {
    surface,
    discover: (input) => runOperation((signal) =>
      runRepositoryConversationForShell(input, (text) => { surface.write(text); }, signal)),
    start: (proposalId, report) => runOperation((signal) => startTask({
      proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
      sourceDirectory: cwd,
      reference: proposalId,
      ask: (prompt) => surface.ask(prompt),
      write: (text) => { surface.write(text); },
      report,
      execute: (grant) => runProposalTask(grant, {
        signal,
        write: (text) => { surface.write(text); },
        writeError: (text) => { surface.write(text); },
      }),
    })),
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
