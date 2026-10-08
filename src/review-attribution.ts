import type { ModelRole } from "./model-roles.js";
import type { ReviewReport } from "./review.js";

/**
 * Who did what in a review, recorded with the evidence and shown where each
 * role acts (decision on roles shown, 2026-10): each report names the model
 * that wrote it, and the refuter's model when it tested that report's
 * findings or obligations. A report recorded before carries neither, and
 * nothing is shown for it rather than a guess.
 */
export function attributed(reports: readonly ReviewReport[], models: Readonly<{ reviewer: string; refuter?: string }>,
): ReviewReport[] {
  return reports.map((report) => {
    const model = report.model ?? models.reviewer;
    if (report.status !== "completed" || models.refuter === undefined || !tested(report)) return { ...report, model };
    return { ...report, model, refuter: models.refuter };
  });
}

/** Whether the refuter settled anything in a report: a finding or an obligation with a standing. */
function tested(report: Extract<ReviewReport, { status: "completed" }>): boolean {
  return report.findings.some((finding) => finding.standing !== undefined) ||
    (report.obligations ?? []).some((obligation) => obligation.standing !== undefined);
}

/** A step's status line with the role doing it and its model, as `Reviewing · reviewer chatgpt:gpt-6.1-sol`. */
export function activityBy(activity: string, role: ModelRole, model: string | undefined): string {
  return model === undefined || model.length === 0 ? activity : `${activity} · ${role} ${model}`;
}

/** The line under a review naming who verified it, or nothing when its reports name no model. */
export function verifiedBy(reports: readonly ReviewReport[]): string | undefined {
  const distinct = (values: readonly (string | undefined)[]): string[] =>
    [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
  const reviewers = distinct(reports.map((report) => report.model));
  const refuters = distinct(reports.map((report) => report.status === "completed" ? report.refuter : undefined));
  if (reviewers.length === 0) return undefined;
  return `Reviewed by ${reviewers.join(", ")}${refuters.length === 0 ? "" : `; findings tested by ${refuters.join(", ")}`}.`;
}
