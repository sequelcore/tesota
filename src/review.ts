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
/** Whether this candidate introduced the problem or it was already there (decision 016). */
export type FindingOrigin = "introduced" | "preexisting";
/** Whether the finding survived refutation; Tesota sets it, never the reviewer (decision 016). */
export type FindingStanding = "confirmed" | "refuted" | "unsettled";

export interface Finding {
  readonly severity: FindingSeverity;
  readonly disposition: FindingDisposition;
  readonly origin: FindingOrigin;
  readonly path?: string;
  readonly line?: number;
  /** The problem, in one sentence. */
  readonly statement: string;
  /** What in the request, the code or the checks shows it. */
  readonly reason: string;
  /** Absent until the refuter has tested the finding. */
  readonly standing?: FindingStanding;
  /** The refuter's evidence for its verdict. */
  readonly refutation?: string;
}

/** Everything a reviewer may see. The working agent's reasoning is deliberately absent. */
export interface ReviewInput {
  /** The candidate's checkout, for read-only investigation. */
  readonly checkout: string;
  readonly requests: readonly string[];
  readonly snapshot: WorkspaceSnapshot;
  readonly checks: readonly CheckResult[];
  readonly flags: readonly VerificationChange[];
  /**
   * Present when reviewing a correction round: `snapshot` then holds only the
   * correction's own diff, from the result sent back to this one, and these
   * findings, sent back to the agent, are checked by the fix validator.
   */
  readonly correction?: { readonly sentBack: readonly Finding[] };
}

export type ReviewReport =
  | Readonly<{ reviewer: string; tree: string; status: "completed"; summary: string; findings: readonly Finding[] }>
  | Readonly<{ reviewer: string; tree: string; status: "incomplete"; reason: string }>;

export interface Reviewer {
  readonly name: string;
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewReport>;
}
