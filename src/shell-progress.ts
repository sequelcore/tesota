export type TesotaShellProgress =
  | Readonly<{ phase: "working"; activity?: string }>
  | Readonly<{ phase: "awaiting_command" }>
  | Readonly<{ phase: "checking" }>
  | Readonly<{ phase: "awaiting_decision" }>
  | Readonly<{ phase: "applying" }>;

const progressLabels: Readonly<Record<TesotaShellProgress["phase"], string>> = Object.freeze({
  working: "Working",
  awaiting_command: "Waiting for command approval",
  checking: "Running checks",
  awaiting_decision: "Waiting for your decision",
  applying: "Applying changes",
});

export function tesotaShellProgressLabel(progress: TesotaShellProgress): string {
  return progress.phase === "working" && progress.activity !== undefined && progress.activity.length > 0
    ? progress.activity : progressLabels[progress.phase];
}
