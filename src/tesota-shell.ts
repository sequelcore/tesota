import { formatConversationTurn, type ConversationCommandResult } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import type { TaskStartProgress, TaskStartResult } from "./task-start.js";

export interface TesotaShellDependencies {
  readonly write: (text: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly discover: (input: ConversationInput) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void) => Promise<TaskStartResult>;
  readonly report?: (progress: TesotaShellProgress) => void;
}

function ignoreProgress(_progress: TesotaShellProgress): void {}

function toolFailureDetail(result: ConversationCommandResult): string {
  if (result.status !== "unavailable" || result.reason !== "tool_failed" || result.toolFailure == null) return "";
  return ` (${result.toolFailure.tool}: ${result.toolFailure.cause})`;
}

async function runShellRequest(dependencies: TesotaShellDependencies, request: string,
  report: (progress: TesotaShellProgress) => void): Promise<{ readonly exitCode: number; readonly continue: boolean }> {
  let input: ConversationInput = { request };
  let clarificationBaseline: string | undefined;
  for (;;) {
    dependencies.write("\n");
    report({ phase: "discovering", operation: "repository_discovery" });
    const result = await dependencies.discover(input);
    if (result.status === "cancelled") {
      dependencies.write("Repository discovery cancelled. Nothing changed.\n");
      return { exitCode: result.exitCode, continue: true };
    }
    if (result.status === "unsettled") {
      dependencies.write("Repository discovery settlement is unconfirmed. End this session before retrying.\n");
      return { exitCode: result.exitCode, continue: false };
    }
    if (result.status === "unavailable") {
      if (result.reason === "invalid_result" || result.reason === "tool_failed") {
        dependencies.write(result.reason === "invalid_result"
          ? "The model returned an invalid response. Nothing changed.\n"
          : `A repository tool failed or was denied${toolFailureDetail(result)}. Nothing changed.\n`);
        return { exitCode: result.exitCode, continue: false };
      }
      if (result.reason === "baseline_changed") {
        dependencies.write("The repository baseline changed during this conversation. Start a new Tesota session. Nothing changed.\n");
        return { exitCode: result.exitCode, continue: false };
      }
      if (result.reason === "context_limit") {
        dependencies.write("The conversation reached the model context limit. Start a new Tesota session. Nothing changed.\n");
        return { exitCode: result.exitCode, continue: false };
      }
      if (result.reason === "limits_exhausted") {
        dependencies.write("The bounded conversation limit was reached. Start a new Tesota session. Nothing changed.\n");
        return { exitCode: result.exitCode, continue: false };
      }
      if (result.reason === "timeout") {
        dependencies.write("Repository discovery timed out after confirmed settlement. Start a new request. Nothing changed.\n");
        return { exitCode: result.exitCode, continue: true };
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
    const started = await dependencies.start(result.turn.proposedTask.record.id, report);
    return { exitCode: started.exitCode, continue: started.status === "settled" };
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
