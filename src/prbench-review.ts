import type { FindingSeverity, ReviewInput, ReviewReport } from "./review.js";
import { parseUnifiedDiff } from "./tesota-shell-diff.js";

/**
 * Tesota's review on SWE-PRBench (decision 023): each pull request's official
 * context goes in as the request, as every benchmark agent receives it, and
 * what Tesota shows comes out in the benchmark's answer format, for the
 * benchmark's own parser, judge and scorer.
 */

export interface PrbenchTask {
  readonly taskId: string;
  /** The official rendered context for one configuration, such as `config_A`. */
  readonly context: string;
  /** The pull request's unified diff, as the dataset records it. */
  readonly diff: string;
}

/** A review of the task with nothing but its context: an empty checkout, no checks, no flags. */
export function prbenchReviewInput(task: PrbenchTask, checkout: string): ReviewInput {
  const changes = parseUnifiedDiff(task.diff).map((file) => ({ status: file.status, path: file.path }));
  return { checkout, requests: [task.context], checks: [], flags: [],
    snapshot: { base: "base", tree: task.taskId, changes, diff: task.diff } };
}

/** Tesota's severities in the benchmark's: something breaks, likely wrong, minor. */
const severities: Readonly<Record<FindingSeverity, "P0" | "P1" | "P2">> = { high: "P0", medium: "P1", low: "P2" };

/**
 * The findings Tesota shows the operator (not refuted, not repeats) as the
 * JSON array the benchmark asks for. When no reviewer finished there is no
 * array: the benchmark then scores the answer as a failure, as Tesota never
 * shows an unfinished review as clean.
 */
export function prbenchAnswer(reports: readonly ReviewReport[]): string {
  const finished = reports.flatMap((report) => report.status === "completed" ? [report] : []);
  if (finished.length === 0) {
    return `Tesota's review did not finish: ${reports.map((report) => report.status === "incomplete" ? report.reason : "").join("; ")}`;
  }
  return JSON.stringify(finished.flatMap((report) => report.findings)
    .filter((finding) => finding.standing !== "refuted" && finding.duplicateOf === undefined)
    .map((finding) => ({ body: `${finding.statement} ${finding.reason}`, file: finding.path ?? null, line: finding.line ?? null,
      severity: severities[finding.severity] })));
}
