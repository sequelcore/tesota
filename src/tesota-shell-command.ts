import { homedir } from "node:os";
import { resolve } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { runRepositoryConversationForShell, type ConversationCommandResult } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { runTesotaShell } from "./tesota-shell.js";
import { createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import { startTask, type TaskStartProgress } from "./task-start.js";

export interface TesotaShellCommandDependencies {
  readonly surface: TesotaShellTerminal;
  readonly discover: (input: ConversationInput) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void) => Promise<number>;
}

function interruptActiveOperation(): void { process.emit("SIGINT"); }

export function createProcessTesotaShell(cwd: string = process.cwd()): TesotaShellCommandDependencies {
  const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
  const surface = createTesotaShellTerminal({ cwd, tui, interrupt: interruptActiveOperation });
  return {
    surface,
    discover: runRepositoryConversationForShell,
    start: (proposalId, report) => startTask({
      proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
      sourceDirectory: cwd,
      reference: proposalId,
      ask: (prompt) => surface.ask(prompt),
      write: (text) => { surface.write(text); },
      report,
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
      ? "Tesota session cancelled. Nothing changed.\n"
      : "Tesota session ended before the active turn completed. Nothing changed.\n");
    return cancelled ? 130 : 1;
  } finally {
    surface.stop();
  }
}
