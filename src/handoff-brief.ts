import type { Finding, FindingSeverity, ReviewReport } from "./review.js";
import type { WorkspaceChange } from "./workspace.js";

/**
 * What a working agent starting a new conversation in a session is told about
 * the session so far (decision 026). It is copied from Tesota's own records,
 * never written by a model: the operator's requests for the pending changes,
 * the changes, the findings still open from their last review, and the
 * previous agent's last reply. Records can be incomplete, so the agent is
 * told to check the workspace rather than trust the brief.
 */

/** The previous agent's last reply is cut to its end past this many characters. */
export const HANDOFF_REPLY_LIMIT: number = 6_000;

export interface OpenFinding {
  readonly severity: FindingSeverity;
  readonly statement: string;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
}

export interface SessionHistory {
  readonly requests: readonly string[];
  readonly changes: readonly WorkspaceChange[];
  /** The last review of the pending changes, and whether it reviewed their current state. */
  readonly review?: Readonly<{ current: boolean; findings: readonly OpenFinding[] }> | undefined;
  readonly lastReply?: string | undefined;
}

/** Findings that still stand: from completed reviews, not refuted, and not repeating another finding. */
export function openFindings(reports: readonly ReviewReport[]): OpenFinding[] {
  return reports.flatMap((report) => report.status === "completed"
    ? report.findings.filter((finding: Finding) => finding.standing !== "refuted" && finding.duplicateOf === undefined)
      .map(({ severity, statement, path, line }) => ({ severity, statement, path, line }))
    : []);
}

export function hasHistory(history: SessionHistory): boolean {
  return history.requests.length > 0 || history.changes.length > 0 || (history.review?.findings.length ?? 0) > 0 ||
    (history.lastReply?.trim().length ?? 0) > 0;
}

const changeVerbs: Readonly<Record<WorkspaceChange["status"], string>> = { added: "add", modified: "edit", deleted: "delete" };

function findingLine(finding: OpenFinding): string {
  const where = finding.path === undefined ? "" : ` ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}:`;
  return `- [${finding.severity}]${where} ${finding.statement}`;
}

/** The brief, or undefined when the session has nothing recorded to carry over. */
export function handoffBrief(history: SessionHistory): string | undefined {
  if (!hasHistory(history)) return undefined;
  const parts = ["Tesota handoff (not written by the user): this session's earlier work was done in another " +
    "conversation, and you do not have that conversation. This is what Tesota recorded of it; it may be incomplete, " +
    "so check the workspace rather than relying on it."];
  if (history.requests.length > 0) {
    parts.push(`The user's requests for the pending changes, unchanged:\n${history.requests
      .map((request, index) => `${index + 1}. ${request}`).join("\n")}`);
  }
  if (history.changes.length > 0) {
    parts.push(`Pending changes in the workspace:\n${history.changes
      .map((change) => `  ${changeVerbs[change.status]} ${change.path}`).join("\n")}`);
  }
  const review = history.review;
  if (review !== undefined && review.findings.length > 0) {
    parts.push(`Findings still open from the last review${review.current ? "" : ", of an earlier state of these changes"}:\n` +
      review.findings.map(findingLine).join("\n"));
  }
  const reply = history.lastReply?.trim() ?? "";
  if (reply.length > 0) {
    parts.push(reply.length > HANDOFF_REPLY_LIMIT
      ? `The previous agent's last reply (its beginning is left out):\n…${reply.slice(-HANDOFF_REPLY_LIMIT)}`
      : `The previous agent's last reply:\n${reply}`);
  }
  return parts.join("\n\n");
}
