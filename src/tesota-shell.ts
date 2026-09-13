import { formatConversationTurn, type ConversationCommandResult } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import type { TaskStartProgress } from "./task-start.js";

export interface TesotaShellDependencies {
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly discover: (input: ConversationInput) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void) => Promise<number>;
  readonly report?: (progress: TesotaShellProgress) => void;
}

function ignoreProgress(_progress: TesotaShellProgress): void {}

async function runShellRequest(dependencies: TesotaShellDependencies, request: string,
  report: (progress: TesotaShellProgress) => void): Promise<{ readonly exitCode: number; readonly continue: boolean }> {
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

/** Surface-independent conversation and admitted-task lifecycle for Tesota Shell. */
export async function runTesotaShell(dependencies: TesotaShellDependencies): Promise<number> {
  const report = dependencies.report ?? ignoreProgress;
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
