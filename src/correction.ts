import type { Finding, Obligation, ReviewReport } from "./review.js";
import { actionOfCheck, actionOfFinding, actionOfObligation, reviewRoundStarts } from "./review-action.js";
import { type CheckResult, testList } from "./workspace-checks.js";

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

/**
 * What goes back to the agent: every check, finding and obligation whose
 * action is the agent's (decision 041). The rest is the operator's or context:
 * a repeat, a problem that was already there, an unclear cause, a trade-off, a
 * check that could not run, and an unfinished review, which the agent cannot
 * or should not settle. Low-severity findings alone start no round; they go to
 * the operator, or travel with a round that starts for another reason (#254).
 */
export function correctionFor(checks: readonly CheckResult[], reviews: readonly ReviewReport[]): CorrectionRound | undefined {
  const failedChecks = checks.filter((check) => actionOfCheck(check) === "agent");
  const completed = reviews.flatMap((report) => report.status === "completed" ? [report] : []);
  const starts = reviewRoundStarts(checks, reviews);
  const findings = completed.flatMap((report) => report.findings.filter((finding) => actionOfFinding(finding, starts) === "agent"));
  const obligations = completed.flatMap((report) => (report.obligations ?? []).filter((item) => actionOfObligation(item) === "agent"));
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
  const tests = check.base?.introducedTests ?? [];
  const introduced = tests.length === 0 ? "" :
    `\n  It also fails without your changes; these tests fail only with them: ${testList(tests)}`;
  return `- The check \`${check.command}\` ${how}.${introduced}${output}`;
}

/** Changed lines a proof covers, by file, with the contracts that cover them, as `proofGuarantees` records them. */
export type ProvedLines = readonly { readonly path: string; readonly lines: readonly number[]; readonly contracts: readonly string[] }[];

/**
 * A finding on a proved line means its contract allowed the behavior
 * (docs/design/proofs.md, "Where each problem goes"), so the agent is asked to
 * fix the code and strengthen that contract, which its next proof then checks.
 */
function strengthenNote(finding: Finding, proved: ProvedLines): string {
  const entry = proved.find((item) => finding.line !== undefined && finding.path?.replaceAll("\\", "/") === item.path &&
    item.lines.includes(finding.line));
  if (entry === undefined) return "";
  return `\n  This line is proved, so its contract allowed this behavior:\n${entry.contracts.map((contract) =>
    contract.split("\n").map((line) => `    ${line}`).join("\n")).join("\n")}\n  Fix the code, and strengthen that ` +
    "contract so its proof rules this behavior out; keep it provable. Do not loosen anything else in it.";
}

function findingProblem(finding: Finding, proved: ProvedLines): string {
  const where = finding.path === undefined ? "" : ` ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
  return `- [${finding.severity}]${where}: ${finding.statement}\n  Why: ${finding.reason}${strengthenNote(finding, proved)}`;
}

/**
 * The message for a correction round: the user's requests unchanged, then each
 * problem with its evidence. With `proved`, a finding on a proved line also
 * asks for its contract to be strengthened.
 */
export function correctionPrompt(requests: readonly string[], round: CorrectionRound, proved: ProvedLines = []): string {
  return "Tesota review of your changes (not written by the user). Tesota ran the repository's checks on your " +
    "result, and an independent reviewer compared it with the user's requests.\n\n" +
    `The user's requests, unchanged:\n${requests.map((request, index) => `${index + 1}. ${request}`).join("\n") ||
      "(not recorded)"}\n\n` +
    `Problems to fix:\n${[...round.failedChecks.map(checkProblem),
      ...round.findings.map((finding) => findingProblem(finding, proved)),
      ...round.obligations.map(obligationProblem)].join("\n")}\n\n` +
    "Fix these problems in the workspace; a request for a change is met only by the change itself, and a question " +
    "by a correct answer. Do not weaken, skip or delete tests or checks to make them pass. If a " +
    "problem cannot be fixed without the user's decision, do not guess: say so in your summary.";
}
