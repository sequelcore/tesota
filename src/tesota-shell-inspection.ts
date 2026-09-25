import type { ShellInspection } from "./tesota-shell-terminal.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

function checkDetail(check: CheckResult): string {
  const exit = check.exitCode === null ? "" : ` (exit ${check.exitCode})`;
  const output = check.output.trim().length === 0 ? "" : `\n${check.output.trimEnd()}`;
  return `${check.outcome.replace("_", " ")}${exit}: ${check.command}${output}`;
}

const verbs: Readonly<Record<WorkspaceSnapshot["changes"][number]["status"], string>> =
  { added: "add   ", modified: "edit  ", deleted: "delete" };

/**
 * The review of pending changes: a summary for the conversation, listing each
 * file and check once, and the full evidence for the result panel.
 */
export function inspectReview(snapshot: WorkspaceSnapshot, checks: readonly CheckResult[]): ShellInspection {
  const first = checks[0];
  const where = first === undefined ? "No checks ran." : first.guarantees.filesystem === "host"
    ? `Checks ran on this exact content on this computer (${first.environment}), without isolation.`
    : `Checks ran on this exact content in the isolated ${first.environment} environment.`;
  const files = snapshot.changes.map((change) => `  ${verbs[change.status]} ${change.path}`);
  const results = checks.map((check) => `  ${check.outcome === "passed" ? "✓" : "✗"} ${check.command}` +
    (check.outcome === "passed" ? "" : ` (${check.outcome.replace("_", " ")}${check.exitCode === null ? "" : `, exit ${check.exitCode}`})`));
  return {
    title: `Review · ${snapshot.changes.length} ${snapshot.changes.length === 1 ? "file" : "files"}`,
    summary: [...files, ...results, `${where} Checks do not show the change does what you asked.`].join("\n"),
    detail: `Files\n${snapshot.changes.map((change) => `  ${change.status} ${change.path}`).join("\n")}` +
      `\n\nChecks\n${checks.map(checkDetail).join("\n\n") || "  None"}` +
      `\n\nContent\n  tree ${snapshot.tree}\n  base ${snapshot.base}\n\nDiff\n${snapshot.diff}`,
  };
}
