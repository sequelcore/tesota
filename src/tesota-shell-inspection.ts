import type { TriageDecision } from "./integrations/answer-triage.js";
import type { Finding, Obligation, ReviewReport } from "./review.js";
import { actionOfCheck, actionOfFinding, actionOfObligation } from "./review-action.js";
import { type ObligationOutcome, obligationOutcome } from "./verification/obligation-outcome.js";
import type { ReviewAction } from "./verification/review-action-rule.js";
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
  /** What the review step took, shown beside a thorough review's forecast. */
  readonly measurement?: ReviewMeasurement;
}

/**
 * The summary's lines under who acts on them (decision 041): what goes back
 * to the agent, what needs the operator, and what is context.
 */
type Groups = Record<ReviewAction, string[]>;

const groupTitles: Readonly<Record<ReviewAction, string>> =
  { agent: "For the agent to fix", operator: "Needs you", context: "For context" };
const nextWords: Readonly<Record<ReviewAction, string>> =
  { agent: "sent back to the agent", operator: "needs your decision", context: "for context" };

function grouped(groups: Groups): string[] {
  return (["agent", "operator", "context"] as const).flatMap((action) =>
    groups[action].length === 0 ? [] : [groupTitles[action], ...groups[action]]);
}

const outcomeWords: Readonly<Record<ObligationOutcome, string>> = { held: "done", not_held: "not done", uncertain: "unclear" };

function outcomeOf(obligation: Obligation): ObligationOutcome {
  return obligationOutcome(obligation.status, obligation.standing ?? "untested");
}

function location(finding: Finding): string {
  if (finding.path === undefined) return "";
  return `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`} — `;
}

/** Why a finding is where it is: its severity for the agent, what the operator must weigh, or that it was already there. */
function findingLabel(finding: Finding, action: ReviewAction): string {
  if (action === "context") return "already there before";
  if (action === "agent") return finding.severity;
  if (finding.standing === "unsettled") return `${finding.severity} · the second check could not decide`;
  if (finding.standing === undefined) return `${finding.severity} · not checked a second time`;
  if (finding.origin === "unknown") return `${finding.severity} · cause unclear`;
  return "your call";
}

const findingMarks: Readonly<Record<ReviewAction, string>> = { agent: "✗", operator: "⚠", context: "·" };

function findingMark(finding: Finding, action: ReviewAction): string {
  return action === "operator" && finding.standing !== "confirmed" ? "?" : findingMarks[action];
}

function checkLine(check: CheckResult, action: ReviewAction): string {
  const mark = check.outcome === "passed" ? "✓" : action === "agent" ? "✗" : action === "operator" ? "⚠" : "·";
  const ended = check.outcome === "passed" ? "" :
    ` (${check.outcome.replace("_", " ")}${check.exitCode === null ? "" : `, exit ${check.exitCode}`})`;
  return `  ${mark} ${check.command}${ended}${check.base === undefined ? "" : `\n      ${describeBase(check.base)}`}`;
}

function obligationSubject(obligation: Obligation): string {
  return obligation.source === "request" ? `Request ${obligation.index}` : `Plan step ${obligation.index}, marked done,`;
}

/**
 * Each finding, request and unfinished review, under who acts on it; with
 * `clean`, a line saying so when no reviewer left anything to act on.
 */
function addReviews(groups: Groups, reviews: readonly ReviewReport[], clean: boolean): void {
  const findings = reviews.flatMap((report) => report.status === "completed" ? report.findings : []);
  if (clean && reviews.length > 0 && reviews.every((report) => report.status === "completed") &&
    findings.every((finding) => actionOfFinding(finding) === "context")) {
    groups.context.push("  ✓ The reviewers found no problem this change caused");
  }
  for (const report of reviews) {
    if (report.status === "incomplete") { groups.operator.push(`  ✗ ${report.reviewer} did not finish: ${report.reason}`); continue; }
    for (const finding of report.findings) {
      const action = actionOfFinding(finding);
      // Repeats and findings the second check ruled out are counted below, not listed.
      if (action === "context" && finding.origin !== "preexisting") continue;
      groups[action].push(`  ${findingMark(finding, action)} ${findingLabel(finding, action)} · ${location(finding)}${finding.statement}`);
    }
    for (const obligation of report.obligations ?? []) {
      const action = actionOfObligation(obligation);
      if (action === "context") continue;
      groups[action].push(`  ${action === "agent" ? "✗" : "?"} ${obligationSubject(obligation)} is ` +
        `${outcomeWords[outcomeOf(obligation)]}: ${obligation.obligation}`);
    }
  }
  const ruledOut = findings.filter((finding) => finding.standing === "refuted" && finding.duplicateOf === undefined).length;
  if (ruledOut > 0) {
    groups.context.push(`  · ${ruledOut} suspected ${ruledOut === 1 ? "problem was" : "problems were"} ruled out by a second check; ` +
      "see the result panel");
  }
}

function tally(obligations: readonly Obligation[]): string {
  const count = (outcome: ObligationOutcome): number => obligations.filter((item) => outcomeOf(item) === outcome).length;
  return (["held", "not_held", "uncertain"] as const)
    .flatMap((outcome) => count(outcome) === 0 ? [] : [`${count(outcome)} ${outcomeWords[outcome]}`]).join(", ");
}

/**
 * How the requests and the plan steps the agent marked done held up
 * (decision 034), one line each: a request is done only when all its parts are.
 */
function progressLines(reviews: readonly ReviewReport[]): string[] {
  return reviews.flatMap((report) => {
    if (report.status !== "completed" || report.obligations === undefined || report.obligations.length === 0) return [];
    const parts = report.obligations.filter((item) => item.source === "request");
    const requests = [...new Set(parts.map((item) => item.index))];
    const outcome = (index: number): ObligationOutcome => {
      const outcomes = parts.filter((item) => item.index === index).map(outcomeOf);
      return outcomes.includes("not_held") ? "not_held" : outcomes.includes("uncertain") ? "uncertain" : "held";
    };
    const done = requests.filter((index) => outcome(index) === "held").length;
    const rest = (["not_held", "uncertain"] as const).flatMap((kind) => {
      const number = requests.filter((index) => outcome(index) === kind).length;
      return number === 0 ? [] : [`, ${number} ${outcomeWords[kind]}`];
    });
    const steps = report.obligations.filter((item) => item.source === "plan");
    return [...requests.length === 0 ? [] : [`Your requests: ${done} of ${requests.length} done${rest.join("")}`],
      ...steps.length === 0 ? [] : [`Plan steps the agent marked done: ${tally(steps)}`]];
  });
}

const outcomeMarks: Readonly<Record<ObligationOutcome, string>> = { held: "✓", not_held: "✗", uncertain: "?" };

function obligationDetail(obligation: Obligation): string {
  const outcome = outcomeOf(obligation);
  const what = obligation.source === "request" ? `Request ${obligation.index}` : `Plan step ${obligation.index}`;
  return `    ${outcomeMarks[outcome]} ${what}: ${obligation.obligation} (${outcomeWords[outcome]}: ${obligation.evidence})` +
    (obligation.refutation === undefined ? "" : `\n      Second check: ${obligation.refutation}`);
}

const standingWords: Readonly<Record<NonNullable<Finding["standing"]>, string>> =
  { confirmed: "confirmed", refuted: "ruled out", unsettled: "could not decide" };

function causeWords(finding: Finding): string {
  return finding.origin === "introduced" ? "this change" : finding.origin === "preexisting" ? "already there before" : "unclear";
}

function findingDetail(finding: Finding): string {
  const action = actionOfFinding(finding);
  const mark = finding.standing === "refuted" || finding.duplicateOf !== undefined ? "·" : findingMark(finding, action);
  const who = finding.premise === true ? "your call, the request's premise" : finding.disposition === "operator" ? "your call" : "fixable";
  const second = finding.standing === undefined ? "" :
    `\n      Second check: ${standingWords[finding.standing]}${finding.refutation === undefined ? "" : `. ${finding.refutation}`}`;
  return `\n\n    ${mark} ${finding.severity}, ${who}: ${location(finding)}${finding.statement}\n      ${finding.reason}` +
    `\n      Next: ${nextWords[action]}\n      Cause: ${causeWords(finding)}` +
    `${finding.originNote === undefined ? "" : `. ${finding.originNote}`}${second}` +
    (finding.duplicateOf === undefined ? "" : `\n      Same problem as ${finding.duplicateOf}`);
}

/** One reviewer: its name, then its summary and each finding and request nested under it. */
function reviewDetail(report: ReviewReport): string {
  if (report.status === "incomplete") return `  ✗ ${report.reviewer} did not finish (${report.reason})`;
  return `  ${report.reviewer}\n    ${report.summary}` + report.findings.map(findingDetail).join("") +
    (report.obligations === undefined || report.obligations.length === 0 ? ""
      : `\n\n    What was asked\n${report.obligations.map(obligationDetail).join("\n")}`);
}

/** A check with what a pass shows and does not show beneath it, and its output behind a gutter so it never reads as part of the record. */
function checkDetail(check: CheckResult): string {
  const exit = check.exitCode === null ? "" : ` (exit ${check.exitCode})`;
  const output = check.output.trim().length === 0 ? "" :
    `\n${check.output.replace(/^\n+/u, "").trimEnd().split("\n").map((line) => `    │ ${line}`).join("\n")}`;
  return `  ${check.outcome === "passed" ? "✓" : "✗"} ${check.outcome.replace("_", " ")}${exit}: ${check.command}` +
    `\n    Next: ${nextWords[actionOfCheck(check)]}` +
    `\n    A pass shows: ${check.claim}\n    It does not show: ${check.limits}` +
    `${check.base === undefined ? "" : `\n    ${describeBase(check.base)}`}${output}`;
}

function requestedDetail(requests: readonly string[]): string {
  return `Your requests\n${requests.map((request, index) => `  ${index + 1}. ${request}`).join("\n") || "  (not recorded)"}`;
}

/**
 * The check of a turn that changed no files (decision 034): how each request
 * held against the repository and the agent's reply; there is nothing to apply.
 */
export function inspectAnswer(requests: readonly string[], reviews: readonly ReviewReport[],
  triage?: Readonly<{ model: string; decision: TriageDecision }>): ShellInspection {
  const groups: Groups = { agent: [], operator: [], context: [] };
  addReviews(groups, reviews, false);
  return {
    title: "Answer check",
    summary: [...grouped(groups), ...progressLines(reviews),
      "No files changed. The reviewer checked your requests against the repository and the agent's reply."].join("\n"),
    detail: `${requestedDetail(requests)}${triage === undefined ? "" : `\n\n${firstPassDetail(triage.model, triage.decision)}`}` +
      `\n\nReview\n${reviews.map(reviewDetail).join("\n\n") || "  None"}`,
  };
}

/** Why the full check ran: the first pass found something checkable, or decided nothing. */
function firstPassDetail(model: string, decision: TriageDecision): string {
  const outcome = decision.decided ? "found something to check" : "decided nothing, so the full check ran";
  return `First pass\n  ${model} ${outcome}: ${decision.reason}`;
}

const verbs: Readonly<Record<WorkspaceSnapshot["changes"][number]["status"], string>> =
  { added: "add   ", modified: "edit  ", deleted: "delete" };
const flagVerbs: Readonly<Record<VerificationChange["status"], string>> =
  { added: "added", modified: "edited", deleted: "deleted" };

/**
 * The review of a candidate: a summary for the conversation, with the changed
 * files and then every check, flagged change and finding once, under who acts
 * on it, and the full record for the result panel.
 */
export function inspectReview({ snapshot, checks, flags, requests, reviews, depth, measurement }: ReviewRecord): ShellInspection {
  const first = checks[0];
  const where = first === undefined ? "No checks ran." : first.guarantees.filesystem === "host"
    ? `Checks ran on this exact content on this computer (${first.environment}), without isolation.`
    : `Checks ran on this exact content in the isolated ${first.environment} environment.`;
  const groups: Groups = { agent: [], operator: [], context: [] };
  for (const check of checks) {
    const action = actionOfCheck(check);
    groups[action].push(checkLine(check, action));
  }
  groups.operator.push(...flags.map((flag) => `  ⚠ ${flagVerbs[flag.status]} ${flag.kind}: ${flag.path}`));
  if (flags.length > 0) {
    groups.operator.push("    These change how the result is checked; only you can tell whether that is legitimate.");
  }
  addReviews(groups, reviews, true);
  if (depth?.depth === "deep") {
    groups.context.push(`  · thorough review${measurement === undefined ? "" :
      ` (took ${costText(measurement.durationMs, measurement.tokens)})`}: ${depth.reasons.join("; ")}`);
  }
  return {
    title: `Review · ${snapshot.changes.length} ${snapshot.changes.length === 1 ? "file" : "files"}`,
    summary: [...snapshot.changes.map((change) => `  ${verbs[change.status]} ${change.path}`), ...grouped(groups),
      ...progressLines(reviews), `${where} Checks and review do not replace reading the change.`].join("\n"),
    detail: `${requestedDetail(requests)}` +
      `\n\nFiles\n${snapshot.changes.map((change) => `  ${change.status} ${change.path}`).join("\n")}` +
      (flags.length === 0 ? "" : `\n\nChanges to how the result is checked\n${flags.map((flag) =>
        `  ${flag.status} ${flag.path} (${flag.kind})`).join("\n")}`) +
      `\n\nChecks\n${checks.map(checkDetail).join("\n\n") || "  None"}` +
      `\n\nReview\n${reviews.map(reviewDetail).join("\n\n") || "  None"}` +
      `\n\nContent\n  tree ${snapshot.tree}\n  base ${snapshot.base}`,
    diff: snapshot.diff,
  };
}
