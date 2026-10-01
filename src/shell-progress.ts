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

/**
 * What a session is doing, as one line: its activity, such as the command it
 * runs, or the phase's own label. A command may span lines, as a heredoc
 * does; the label keeps its first line and marks the rest, which the
 * transcript shows whole, so a status line never grows.
 */
export function tesotaShellProgressLabel(progress: TesotaShellProgress): string {
  const activity = (progress.phase === "working" || progress.phase === "preparing" || progress.phase === "reviewing")
    ? progress.activity?.trim() : undefined;
  if (activity === undefined || activity.length === 0) return progressLabels[progress.phase];
  const [first = "", ...rest] = activity.split(/\r?\n/u);
  return rest.some((line) => line.trim().length > 0) ? `${first.trimEnd()} …` : first;
}
