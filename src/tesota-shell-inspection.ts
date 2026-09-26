import type { Finding, ReviewReport } from "./review.js";
import type { DepthDecision } from "./review-depth.js";
import { costText, type ReviewMeasurement } from "./review-forecast.js";
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
  readonly reviews: readonly ReviewReport[];
  /** How deeply the candidate was reviewed and why; absent when no review ran. */
  readonly depth?: DepthDecision;
  /** What the review step took, shown beside a deep review's forecast. */
  readonly measurement?: ReviewMeasurement;
}

function checkDetail(check: CheckResult): string {
  const exit = check.exitCode === null ? "" : ` (exit ${check.exitCode})`;
  const output = check.output.trim().length === 0 ? "" : `\n${check.output.trimEnd()}`;
  return `${check.outcome.replace("_", " ")}${exit}: ${check.command}\n  Claim: ${check.claim}\n  Limits: ${check.limits}${output}`;
}

const verbs: Readonly<Record<WorkspaceSnapshot["changes"][number]["status"], string>> =
  { added: "add   ", modified: "edit  ", deleted: "delete" };
const flagVerbs: Readonly<Record<VerificationChange["status"], string>> =
  { added: "added", modified: "edited", deleted: "deleted" };

function location(finding: Finding): string {
  if (finding.path === undefined) return "";
  return `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} — `;
}

/**
 * One line per finding: ✗ for a defect this change introduced, ⚠ for the
 * operator's call, including a problem whose cause Tesota could not
 * establish, · for a problem that was already there. An unfinished review
 * never looks clean.
 */
function reviewLines(report: ReviewReport): string[] {
  if (report.status === "incomplete") return [`  ✗ ${report.reviewer} did not finish: ${report.reason}`];
  const standing = report.findings.filter((finding) => finding.standing !== "refuted" && finding.duplicateOf === undefined);
  const attention = standing.filter((finding) => finding.origin !== "preexisting");
  const lines = attention.map((finding) => {
    const what = finding.origin === "unknown" ? `cause unclear · ${finding.severity}`
      : finding.disposition === "operator" ? "needs you" : finding.severity;
    if (finding.standing === "unsettled") return `  ? unsettled · ${what} · ${location(finding)}${finding.statement}`;
    const mark = finding.origin === "introduced" && finding.disposition === "fixable" ? "✗" : "⚠";
    return `  ${mark} ${what} · ${location(finding)}${finding.statement}`;
  });
  const duplicates = report.findings.filter((finding) => finding.duplicateOf !== undefined).length;
  if (attention.length === 0 && duplicates === 0) lines.push(`  ✓ ${report.reviewer}: no problems introduced`);
  lines.push(...standing.filter((finding) => finding.origin === "preexisting")
    .map((finding) => `  · already there · ${location(finding)}${finding.statement}`));
  const refuted = report.findings.filter((finding) => finding.standing === "refuted").length;
  if (refuted > 0) lines.push(`  · ${refuted} ${refuted === 1 ? "finding was" : "findings were"} refuted; see the result panel`);
  return lines;
}

function reviewDetail(report: ReviewReport): string {
  if (report.status === "incomplete") return `  ${report.reviewer}: did not finish (${report.reason})`;
  return `  ${report.reviewer}\n  ${report.summary}` + report.findings.map((finding) =>
    `\n\n  ${finding.origin === "preexisting" ? "already there" : finding.origin === "unknown" ? "cause unclear" :
      finding.disposition === "operator" ? "needs you" : `${finding.severity}, fixable`}: ` +
    `${location(finding)}${finding.statement}${finding.standing === undefined ? "" : ` [${finding.standing}]`}\n  ${finding.reason}` +
    (finding.originNote === undefined ? "" : `\n  Origin: ${finding.originNote}`) +
    (finding.refutation === undefined ? "" : `\n  Refuter: ${finding.refutation}`) +
    (finding.duplicateOf === undefined ? "" : `\n  Same problem as ${finding.duplicateOf}`)).join("");
}

/**
 * The review of a candidate: a summary for the conversation, listing each
 * file, check, flagged change and finding once, and the full record for the
 * result panel.
 */
export function inspectReview({ snapshot, checks, flags, requests, reviews, depth, measurement }: ReviewRecord): ShellInspection {
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
    summary: [...files, ...results, ...flagged,
      ...(depth?.depth === "deep" ? [`  · deep review${measurement === undefined ? "" :
        ` (took ${costText(measurement.durationMs, measurement.tokens)})`}: ${depth.reasons.join("; ")}`] : []),
      ...reviews.flatMap(reviewLines), ...flagNote,
      `${where} Checks and review do not replace reading the change.`].join("\n"),
    detail: `Requested\n${requests.map((request, index) => `  ${index + 1}. ${request}`).join("\n") || "  (not recorded)"}` +
      `\n\nFiles\n${snapshot.changes.map((change) => `  ${change.status} ${change.path}`).join("\n")}` +
      (flags.length === 0 ? "" : `\n\nChanges to what gets checked\n${flags.map((flag) =>
        `  ${flag.status} ${flag.path} (${flag.kind})`).join("\n")}`) +
      `\n\nChecks\n${checks.map(checkDetail).join("\n\n") || "  None"}` +
      `\n\nReview\n${reviews.map(reviewDetail).join("\n\n") || "  None"}` +
      `\n\nContent\n  tree ${snapshot.tree}\n  base ${snapshot.base}`,
    diff: snapshot.diff,
  };
}
