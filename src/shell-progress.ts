import type { TaskStartProgress } from "./task-start.js";

export type TesotaShellProgress =
  | Readonly<{ phase: "discovering"; operation: "repository_discovery" }>
  | Readonly<{ phase: "awaiting_clarification"; operation: "operator_answer" }>
  | TaskStartProgress;

const progressLabels: Readonly<Record<TesotaShellProgress["phase"], string>> = Object.freeze({
  discovering: "Inspecting the committed repository",
  awaiting_clarification: "Waiting for your answer",
  awaiting_approval: "Waiting for scope approval",
  executing: "Running the isolated candidate task",
  ready_for_review: "Waiting for review decision",
  promoting: "Promoting accepted candidate bytes",
});

export function tesotaShellProgressLabel(progress: TesotaShellProgress): string {
  return progressLabels[progress.phase];
}
