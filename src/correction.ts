import type { Finding, ReviewReport } from "./review.js";
import type { CheckResult } from "./workspace-checks.js";

/** Rounds in which Tesota sends problems back to the working agent before the operator decides (decision 015). */
export const MAX_CORRECTION_ROUNDS = 2;
const outputTail = 2_000;

/** What the working agent is asked to fix in one round. */
export interface CorrectionRound {
  readonly failedChecks: readonly CheckResult[];
  readonly findings: readonly Finding[];
}

/**
 * Failed or timed-out checks and `fixable` findings go back to the agent.
 * Findings for the operator, incomplete reviews and checks that could not run
 * or changed files stay with the operator: the agent cannot settle them.
 */
export function correctionFor(checks: readonly CheckResult[], reviews: readonly ReviewReport[]): CorrectionRound | undefined {
  const failedChecks = checks.filter((check) => check.outcome === "failed" || check.outcome === "timed_out");
  const findings = reviews.flatMap((report) => report.status === "completed"
    ? report.findings.filter((finding) => finding.disposition === "fixable") : []);
  return failedChecks.length === 0 && findings.length === 0 ? undefined : { failedChecks, findings };
}

export function problemCount(round: CorrectionRound): number {
  return round.failedChecks.length + round.findings.length;
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
    `Problems to fix:\n${[...round.failedChecks.map(checkProblem), ...round.findings.map(findingProblem)].join("\n")}\n\n` +
    "Fix these problems in the workspace. Do not weaken, skip or delete tests or checks to make them pass. If a " +
    "problem cannot be fixed without the user's decision, do not guess: say so in your summary.";
}
