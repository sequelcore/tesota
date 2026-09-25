import type { VerificationChange } from "./verification-changes.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * Reviewers judge whether a candidate is what the operator asked for and
 * whether its evidence covers the request (decision 015). They observe; they
 * never authorize, and an unfinished review is never a clean one.
 */

export type FindingSeverity = "high" | "medium" | "low";
/** `fixable`: a defect against the request the agent can fix. `operator`: needs the operator's judgment. */
export type FindingDisposition = "fixable" | "operator";

export interface Finding {
  readonly severity: FindingSeverity;
  readonly disposition: FindingDisposition;
  readonly path?: string;
  readonly line?: number;
  /** The problem, in one sentence. */
  readonly statement: string;
  /** What in the request, the code or the checks shows it. */
  readonly reason: string;
}

/** Everything a reviewer may see. The working agent's reasoning is deliberately absent. */
export interface ReviewInput {
  /** The candidate's checkout, for read-only investigation. */
  readonly checkout: string;
  readonly requests: readonly string[];
  readonly snapshot: WorkspaceSnapshot;
  readonly checks: readonly CheckResult[];
  readonly flags: readonly VerificationChange[];
}

export type ReviewReport =
  | Readonly<{ reviewer: string; tree: string; status: "completed"; summary: string; findings: readonly Finding[] }>
  | Readonly<{ reviewer: string; tree: string; status: "incomplete"; reason: string }>;

export interface Reviewer {
  readonly name: string;
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewReport>;
}
