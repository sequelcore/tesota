import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ShellTheme } from "../../../../src/theme.ts";
import { terminalText } from "../../../../src/terminal-text.ts";
import type { TaskState, TaskStatus } from "../tasks.ts";

const words: Readonly<Record<TaskStatus, string>> = {
  pending: "pending    ", in_progress: "in progress", completed: "completed  ", cancelled: "cancelled  ",
};

const oneLine = (title: string): string => terminalText(title).replace(/\s+/gu, " ").trim();

/**
 * The agent's task list above the input: one row with its claimed counts and,
 * while the run goes (`live`), its current focus; expanded, every task with its
 * status word. It is the agent's claim, so it is drawn in the opinion's color,
 * never verification's. Nothing for no list or an empty one.
 */
export function tasksRow(state: TaskState, live: boolean, expanded: boolean, theme: ShellTheme, width: number): string[] {
  const fit = (line: string): string => truncateToWidth(` ${line}`, width, "…");
  if (state.kind === "unavailable") return [fit(theme.fg("warning", "Agent task list: could not be read back"))];
  if (state.kind === "none" || state.tasks.length === 0) return [];
  const done = state.tasks.filter(({ status }) => status === "completed").length;
  const focus = state.tasks.find(({ status }) => status === "in_progress");
  const counts = `${done}/${state.tasks.length} marked done`;
  const head = `${theme.fg("accent", "◇")} ${theme.fg("muted", live ? "Agent task list" : "Saved agent task list")}`
    + theme.fg("dim", ` · ${counts}`)
    + (live && focus !== undefined ? theme.fg("dim", " · now: ") + theme.fg("text", oneLine(focus.title)) : "")
    + (expanded ? "" : theme.fg("dim", " · Ctrl+O to expand"));
  if (!expanded) return [fit(head)];
  return [fit(head), ...state.tasks.map(({ title, status }) =>
    fit(`  ${theme.fg(status === "in_progress" ? "text" : "dim", `${words[status]}  ${oneLine(title)}`)}`))];
}
