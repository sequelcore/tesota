import type { Finding, Obligation, ReviewReport } from "./review.js";
import { obligationOutcome } from "./verification/obligation-outcome.js";
import type { CheckResult } from "./workspace-checks.js";

/** Rounds in which Tesota sends problems back to the working agent before the operator decides (decision 015). */
export const MAX_CORRECTION_ROUNDS = 2;
const outputTail = 2_000;

/** What the working agent is asked to fix in one round. */
export interface CorrectionRound {
  readonly failedChecks: readonly CheckResult[];
  readonly findings: readonly Finding[];
  /** Parts of a request, or plan steps the agent marked done, that the refuter confirmed are missing (decision 034). */
  readonly obligations: readonly Obligation[];
}

/** Whether an obligation did not hold (`obligationOutcome`): a gap the refuter confirmed. */
export function notHeld(obligation: Obligation): boolean {
  return obligationOutcome(obligation.status, obligation.standing ?? "untested") === "not_held";
}

/**
 * Failed or timed-out checks, fixable findings the candidate introduced
 * that survived refutation, and obligations that did not hold, go back to the agent. Findings for the operator,
 * problems that were already there or whose cause is unknown, incomplete
 * reviews and checks that could not run or changed files stay with the
 * operator: the agent cannot or should not settle them.
 */
export function correctionFor(checks: readonly CheckResult[], reviews: readonly ReviewReport[]): CorrectionRound | undefined {
  const failedChecks = checks.filter((check) => check.outcome === "failed" || check.outcome === "timed_out");
  const findings = reviews.flatMap((report) => report.status === "completed"
    ? report.findings.filter((finding) => finding.disposition === "fixable" && finding.origin === "introduced" &&
      finding.standing === "confirmed" && finding.duplicateOf === undefined) : []);
  const obligations = reviews.flatMap((report) => report.status === "completed" ? (report.obligations ?? []).filter(notHeld) : []);
  return failedChecks.length === 0 && findings.length === 0 && obligations.length === 0 ? undefined
    : { failedChecks, findings, obligations };
}

export function problemCount(round: CorrectionRound): number {
  return round.failedChecks.length + round.findings.length + round.obligations.length;
}

function obligationProblem(obligation: Obligation): string {
  const done = obligation.status === "partial" ? "is only partly done" : "is not done";
  const what = obligation.source === "request" ? `Request ${obligation.index} ${done}` : `Plan step ${obligation.index}, marked done, ${done}`;
  return `- ${what}: ${obligation.obligation}\n  Why: ${obligation.evidence}`;
}

function checkProblem(check: CheckResult): string {
  const how = check.outcome === "timed_out" ? "ran past its time limit" : `failed${check.exitCode === null ? "" : ` (exit ${check.exitCode})`}`;
  const output = check.output.trim().length === 0 ? "" :
    `\n  Last output:\n${check.output.trimEnd().slice(-outputTail).replace(/^/gmu, "    ")}`;
  return `- The check \`${check.command}\` ${how}.${output}`;
}

function findingProblem(finding: Finding): string {
  const where = finding.path === undefined ? "" : ` ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
  return `- [${finding.severity}]${where}: ${finding.statement}\n  Why: ${finding.reason}`;
}

/** The message for a correction round: the user's requests unchanged, then each problem with its evidence. */
export function correctionPrompt(requests: readonly string[], round: CorrectionRound): string {
  return "Tesota review of your changes (not written by the user). Tesota ran the repository's checks on your " +
    "result, and an independent reviewer compared it with the user's requests.\n\n" +
    `The user's requests, unchanged:\n${requests.map((request, index) => `${index + 1}. ${request}`).join("\n") ||
      "(not recorded)"}\n\n` +
    `Problems to fix:\n${[...round.failedChecks.map(checkProblem), ...round.findings.map(findingProblem),
      ...round.obligations.map(obligationProblem)].join("\n")}\n\n` +
    "Fix these problems in the workspace; a request for a change is met only by the change itself, and a question " +
    "by a correct answer. Do not weaken, skip or delete tests or checks to make them pass. If a " +
    "problem cannot be fixed without the user's decision, do not guess: say so in your summary.";
}
