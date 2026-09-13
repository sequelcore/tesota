import { createInterface } from "node:readline/promises";
import { formatConversationTurn, runRepositoryConversationForShell,
  type ConversationCommandResult } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import { runTaskStartCommand, type TaskStartProgress } from "./task-start.js";
import { askTerminalQuestion, type PromptTerminal } from "./terminal-question.js";

export type NativeShellProgress =
  | Readonly<{ phase: "discovering"; operation: "repository_discovery" }>
  | Readonly<{ phase: "awaiting_clarification"; operation: "operator_answer" }>
  | TaskStartProgress;

export interface NativeShellDependencies {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly discover: (input: ConversationInput) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void) => Promise<number>;
  readonly report?: (progress: NativeShellProgress) => void;
  readonly now?: () => number;
}

const progressLabels: Readonly<Record<NativeShellProgress["phase"], string>> = Object.freeze({
  discovering: "Inspecting the committed repository",
  awaiting_clarification: "Waiting for your answer",
  awaiting_approval: "Waiting for scope approval",
  executing: "Running the isolated candidate task",
  ready_for_review: "Waiting for review decision",
  promoting: "Promoting accepted candidate bytes",
});

function progressReporter(dependencies: NativeShellDependencies): (progress: NativeShellProgress) => void {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  return (progress) => {
    dependencies.report?.(progress);
    dependencies.write(`[${progress.phase}] ${progressLabels[progress.phase]} (${Math.floor((now() - startedAt) / 1_000)}s)\n`);
  };
}

async function runShellRequest(dependencies: NativeShellDependencies, request: string,
  report: (progress: NativeShellProgress) => void): Promise<{ readonly exitCode: number; readonly continue: boolean }> {
  let input: ConversationInput = { request };
  let clarificationBaseline: string | undefined;
  for (;;) {
    dependencies.write("\n");
    report({ phase: "discovering", operation: "repository_discovery" });
    const result = await dependencies.discover(input);
    if (result.status === "unavailable") {
      if (result.reason === "baseline_changed") {
        dependencies.write("The committed baseline changed during clarification. Start a new request. Nothing changed.\n");
        return { exitCode: result.exitCode, continue: false };
      }
      dependencies.write("Request blocked or unavailable. Nothing changed.\n");
      return { exitCode: result.exitCode, continue: false };
    }
    dependencies.write(formatConversationTurn(result.turn));
    if (result.turn.kind === "clarification") {
      if (clarificationBaseline !== undefined) {
        dependencies.write("A second clarification is not supported. Nothing changed.\n");
        return { exitCode: 1, continue: false };
      }
      clarificationBaseline = result.turn.baseline;
      report({ phase: "awaiting_clarification", operation: "operator_answer" });
      const answer = (await dependencies.ask("Answer: ")).trim();
      if (answer.length === 0) {
        dependencies.write("Clarification cancelled. Nothing changed.\n");
        return { exitCode: 0, continue: false };
      }
      input = { request, clarification: { question: result.turn.clarification.question, answer,
        baseline: clarificationBaseline } };
      continue;
    }
    if (result.turn.kind !== "task_proposal") {
      dependencies.write("Read-only turn complete. No execution authority was created.\n");
      return { exitCode: result.exitCode, continue: true };
    }
    if (result.exitCode !== 0 || result.turn.proposedTask.record.status !== "ready") {
      dependencies.write("Request blocked or unavailable. Nothing changed.\n");
      return { exitCode: result.exitCode, continue: false };
    }
    dependencies.write("Proposal ready. Execution still requires your approval.\n");
    return { exitCode: await dependencies.start(result.turn.proposedTask.record.id, report), continue: false };
  }
}

/** Release readline after one request so later Ctrl+C reaches the active task owner. */
export async function askNativeShellRequest(terminal: PromptTerminal, prompt: string): Promise<string> {
  return askTerminalQuestion(terminal, prompt);
}

/** First Tesota-owned operator surface; execution remains a later admitted consumer. */
export async function runNativeShell(dependencies: NativeShellDependencies): Promise<number> {
  dependencies.write(
    `Tesota\nRepository: ${dependencies.cwd}\n` +
    "Ask about the repository or describe a change. File names are optional.\n\n",
  );
  const report = progressReporter(dependencies);
  let completedTurn = false;
  for (;;) {
    const request = (await dependencies.ask("> ")).trim();
    if (request.length === 0) {
      dependencies.write(completedTurn ? "Tesota session ended. Nothing changed.\n" : "No request entered. Nothing changed.\n");
      return 0;
    }
    const result = await runShellRequest(dependencies, request, report);
    if (!result.continue) return result.exitCode;
    completedTurn = true;
  }
}

export async function runNativeShellCommand(): Promise<number> {
  let terminal: ReturnType<typeof createInterface> | undefined;
  try {
    return await runNativeShell({
      cwd: process.cwd(),
      write: (text) => { process.stdout.write(text); },
      ask: async (prompt) => {
        terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        return askNativeShellRequest(terminal, prompt);
      },
      discover: runRepositoryConversationForShell,
      start: runTaskStartCommand,
    });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    process.stderr.write(cancelled
      ? "Tesota session cancelled. Nothing changed.\n"
      : "Tesota session ended before the read-only turn completed. Nothing changed.\n");
    return cancelled ? 130 : 1;
  } finally {
    terminal?.close();
  }
}
