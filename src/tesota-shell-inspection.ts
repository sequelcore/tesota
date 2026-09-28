import type { Finding, Obligation, ReviewReport } from "./review.js";
import { type ObligationOutcome, obligationOutcome } from "./verification/obligation-outcome.js";
import type { DepthDecision } from "./review-depth.js";
import { costText, type ReviewMeasurement } from "./review-forecast.js";
import type { ShellInspection } from "./tesota-shell-terminal.js";
import type { VerificationChange } from "./verification-changes.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import { type CheckResult, describeBase } from "./workspace-checks.js";

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

/** A check with its claim and limits beneath it, and its output behind a gutter so it never reads as part of the record. */
function checkDetail(check: CheckResult): string {
  const exit = check.exitCode === null ? "" : ` (exit ${check.exitCode})`;
  const output = check.output.trim().length === 0 ? "" :
    `\n${check.output.replace(/^\n+/u, "").trimEnd().split("\n").map((line) => `    │ ${line}`).join("\n")}`;
  return `  ${check.outcome === "passed" ? "✓" : "✗"} ${check.outcome.replace("_", " ")}${exit}: ${check.command}` +
    `\n    Claim: ${check.claim}\n    Limits: ${check.limits}` +
    `${check.base === undefined ? "" : `\n    Base: ${describeBase(check.base)}`}${output}`;
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

function outcomeOf(obligation: Obligation): ObligationOutcome {
  return obligationOutcome(obligation.status, obligation.standing ?? "untested");
}

function tally(obligations: readonly Obligation[]): string {
  const count = (outcome: ObligationOutcome): number => obligations.filter((item) => outcomeOf(item) === outcome).length;
  return [["held", count("held")], ["not held", count("not_held")], ["uncertain", count("uncertain")]]
    .flatMap(([label, number]) => number === 0 ? [] : [`${number} ${label}`]).join(", ");
}

/**
 * How the requests and the plan steps the agent claimed held up (decision
 * 034), one line each: a request holds only when all its obligations do.
 */
function obligationLines(report: ReviewReport): string[] {
  if (report.status !== "completed" || report.obligations === undefined || report.obligations.length === 0) return [];
  const requests = [...new Set(report.obligations.filter((item) => item.source === "request").map((item) => item.index))];
  const outcome = (index: number): ObligationOutcome => {
    const outcomes = report.obligations?.filter((item) => item.source === "request" && item.index === index).map(outcomeOf) ?? [];
    return outcomes.includes("not_held") ? "not_held" : outcomes.includes("uncertain") ? "uncertain" : "held";
  };
  const held = requests.filter((index) => outcome(index) === "held").length;
  const rest = ["not_held", "uncertain"].flatMap((kind) => {
    const number = requests.filter((index) => outcome(index) === kind).length;
    return number === 0 ? [] : [`${number} ${kind === "not_held" ? "not held" : "uncertain"}`];
  });
  const steps = report.obligations.filter((item) => item.source === "plan");
  return [...requests.length === 0 ? [] : [`  Requests: ${held} of ${requests.length} held${rest.map((part) => `, ${part}`).join("")}`],
    ...steps.length === 0 ? [] : [`  Plan steps claimed done: ${tally(steps)}`]];
}

const outcomeMarks: Readonly<Record<ObligationOutcome, string>> = { held: "✓", not_held: "✗", uncertain: "?" };

function obligationDetail(obligation: Obligation): string {
  const outcome = outcomeOf(obligation);
  const what = obligation.source === "request" ? `Request ${obligation.index}` : `Plan step ${obligation.index}`;
  return `    ${outcomeMarks[outcome]} ${what}: ${obligation.obligation} (${outcome.replace("_", " ")}: ${obligation.evidence})` +
    (obligation.refutation === undefined ? "" : `\n      Refuter: ${obligation.refutation}`);
}

/** The summary's mark for a finding, with a refuted finding set back as context. */
function findingMark(finding: Finding): string {
  if (finding.standing === "refuted" || finding.origin === "preexisting") return "·";
  if (finding.standing === "unsettled") return "?";
  return finding.origin === "introduced" && finding.disposition === "fixable" ? "✗" : "⚠";
}

function findingDetail(finding: Finding): string {
  const what = finding.origin === "preexisting" ? "already there" : finding.origin === "unknown" ? "cause unclear" :
    finding.disposition === "operator" ? "needs you" : `${finding.severity}, fixable`;
  return `\n\n    ${findingMark(finding)} ${what}: ${location(finding)}${finding.statement}` +
    `${finding.standing === undefined ? "" : ` [${finding.standing}]`}\n      ${finding.reason}` +
    (finding.originNote === undefined ? "" : `\n      Origin: ${finding.originNote}`) +
    (finding.refutation === undefined ? "" : `\n      Refuter: ${finding.refutation}`) +
    (finding.duplicateOf === undefined ? "" : `\n      Same problem as ${finding.duplicateOf}`);
}

/** One reviewer: its name, then its summary and each finding and obligation nested under it. */
function reviewDetail(report: ReviewReport): string {
  if (report.status === "incomplete") return `  ✗ ${report.reviewer} did not finish (${report.reason})`;
  return `  ${report.reviewer}\n    ${report.summary}` + report.findings.map(findingDetail).join("") +
    (report.obligations === undefined || report.obligations.length === 0 ? ""
      : `\n\n    What the result must hold\n${report.obligations.map(obligationDetail).join("\n")}`);
}

/**
 * The check of a turn that changed no files (decision 034): how each request
 * held against the repository and the agent's reply; there is nothing to apply.
 */
export function inspectAnswer(requests: readonly string[], reviews: readonly ReviewReport[]): ShellInspection {
  const incomplete = reviews.flatMap((report) => report.status === "incomplete"
    ? [`  ✗ ${report.reviewer} did not finish: ${report.reason}`] : []);
  return {
    title: "Answer check",
    summary: [...incomplete, ...reviews.flatMap(obligationLines),
      "No files changed. The reviewer checked your requests against the repository and the agent's reply."].join("\n"),
    detail: `Requested\n${requests.map((request, index) => `  ${index + 1}. ${request}`).join("\n") || "  (not recorded)"}` +
      `\n\nReview\n${reviews.map(reviewDetail).join("\n\n") || "  None"}`,
  };
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
    (check.outcome === "passed" ? "" : ` (${check.outcome.replace("_", " ")}${check.exitCode === null ? "" : `, exit ${check.exitCode}`})`) +
    (check.base === undefined ? "" : `\n      ${describeBase(check.base)}`));
  const flagged = flags.map((flag) => `  ⚠ ${flagVerbs[flag.status]} ${flag.kind}: ${flag.path}`);
  const flagNote = flags.length === 0 ? [] :
    ["Changes marked ⚠ alter what checks this result; only you can decide whether they are legitimate."];
  return {
    title: `Review · ${snapshot.changes.length} ${snapshot.changes.length === 1 ? "file" : "files"}`,
    summary: [...files, ...results, ...flagged,
      ...(depth?.depth === "deep" ? [`  · deep review${measurement === undefined ? "" :
        ` (took ${costText(measurement.durationMs, measurement.tokens)})`}: ${depth.reasons.join("; ")}`] : []),
      ...reviews.flatMap(reviewLines), ...reviews.flatMap(obligationLines), ...flagNote,
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
