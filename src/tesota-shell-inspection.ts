import type { ShellInspection } from "./tesota-shell-terminal.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

function checkDetail(check: CheckResult): string {
  const exit = check.exitCode === null ? "" : ` (exit ${check.exitCode})`;
  const output = check.output.trim().length === 0 ? "" : `\n${check.output.trimEnd()}`;
  return `${check.outcome.replace("_", " ")}${exit}: ${check.command}${output}`;
}

export function inspectReview(snapshot: WorkspaceSnapshot, checks: readonly CheckResult[]): ShellInspection {
  const failed = checks.filter((check) => check.outcome !== "passed");
  const checkSummary = checks.length === 0 ? "No checks ran." :
    failed.length === 0 ? `All ${checks.length} checks passed.` : `${failed.length} of ${checks.length} checks did not pass.`;
  return {
    title: "Changes",
    summary: `${snapshot.changes.length} changed files. ${checkSummary} Checks ran on this exact content, ` +
      "without a sandbox. They do not show the change does what you asked.",
    detail: `Files\n${snapshot.changes.map((change) => `  ${change.status} ${change.path}`).join("\n")}` +
      `\n\nChecks\n${checks.map(checkDetail).join("\n\n") || "  None"}` +
      `\n\nContent\n  tree ${snapshot.tree}\n  base ${snapshot.base}\n\nDiff\n${snapshot.diff}`,
  };
}
