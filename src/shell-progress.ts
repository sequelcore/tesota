export const SHELL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export type TesotaShellProgress =
  | Readonly<{ phase: "preparing"; activity?: string }>
  | Readonly<{ phase: "working"; activity?: string }>
  | Readonly<{ phase: "awaiting_command" }>
  | Readonly<{ phase: "checking" }>
  | Readonly<{ phase: "reviewing"; activity?: string }>
  | Readonly<{ phase: "awaiting_decision" }>
  | Readonly<{ phase: "applying" }>;

const progressLabels: Readonly<Record<TesotaShellProgress["phase"], string>> = Object.freeze({
  preparing: "Preparing the environment",
  working: "Working",
  awaiting_command: "Waiting for command approval",
  checking: "Running checks",
  reviewing: "Reviewing",
  awaiting_decision: "Waiting for your decision",
  applying: "Applying changes",
});

export function tesotaShellProgressLabel(progress: TesotaShellProgress): string {
  return (progress.phase === "working" || progress.phase === "preparing" || progress.phase === "reviewing") &&
    progress.activity !== undefined &&
    progress.activity.length > 0 ? progress.activity : progressLabels[progress.phase];
}
