import type { ShellInspection } from "./tesota-shell-terminal.js";
import type { VerificationChange } from "./verification-changes.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/** Everything the operator decides on for one candidate. */
export interface ReviewRecord {
  readonly snapshot: WorkspaceSnapshot;
  readonly checks: readonly CheckResult[];
  readonly flags: readonly VerificationChange[];
  /** The operator's requests behind the candidate, verbatim. */
  readonly requests: readonly string[];
}

function checkDetail(check: CheckResult): string {
  const exit = check.exitCode === null ? "" : ` (exit ${check.exitCode})`;
  const output = check.output.trim().length === 0 ? "" : `\n${check.output.trimEnd()}`;
  return `${check.outcome.replace("_", " ")}${exit}: ${check.command}${output}`;
}

const verbs: Readonly<Record<WorkspaceSnapshot["changes"][number]["status"], string>> =
  { added: "add   ", modified: "edit  ", deleted: "delete" };
const flagVerbs: Readonly<Record<VerificationChange["status"], string>> =
  { added: "added", modified: "edited", deleted: "deleted" };

/**
 * The review of a candidate: a summary for the conversation, listing each
 * file, check and flagged change once, and the full record for the result panel.
 */
export function inspectReview({ snapshot, checks, flags, requests }: ReviewRecord): ShellInspection {
  const first = checks[0];
  const where = first === undefined ? "No checks ran." : first.guarantees.filesystem === "host"
    ? `Checks ran on this exact content on this computer (${first.environment}), without isolation.`
    : `Checks ran on this exact content in the isolated ${first.environment} environment.`;
  const files = snapshot.changes.map((change) => `  ${verbs[change.status]} ${change.path}`);
  const results = checks.map((check) => `  ${check.outcome === "passed" ? "✓" : "✗"} ${check.command}` +
    (check.outcome === "passed" ? "" : ` (${check.outcome.replace("_", " ")}${check.exitCode === null ? "" : `, exit ${check.exitCode}`})`));
  const flagged = flags.map((flag) => `  ⚠ ${flagVerbs[flag.status]} ${flag.kind}: ${flag.path}`);
  const flagNote = flags.length === 0 ? [] :
    ["Changes marked ⚠ alter what checks this result; only you can decide whether they are legitimate."];
  return {
    title: `Review · ${snapshot.changes.length} ${snapshot.changes.length === 1 ? "file" : "files"}`,
    summary: [...files, ...results, ...flagged, ...flagNote,
      `${where} Checks do not show the change does what you asked.`].join("\n"),
    detail: `Requested\n${requests.map((request, index) => `  ${index + 1}. ${request}`).join("\n") || "  (not recorded)"}` +
      `\n\nFiles\n${snapshot.changes.map((change) => `  ${change.status} ${change.path}`).join("\n")}` +
      (flags.length === 0 ? "" : `\n\nChanges to what gets checked\n${flags.map((flag) =>
        `  ${flag.status} ${flag.path} (${flag.kind})`).join("\n")}`) +
      `\n\nChecks\n${checks.map(checkDetail).join("\n\n") || "  None"}` +
      `\n\nContent\n  tree ${snapshot.tree}\n  base ${snapshot.base}\n\nDiff\n${snapshot.diff}`,
  };
}
