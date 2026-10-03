import type { ObligationStatus } from "./verification/obligation-outcome.js";
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
/**
 * Whether this candidate introduced the problem, it was already there
 * (decision 016), or that cannot be told (decision 018). Tesota checks the
 * reviewer's claim against the diff and makes an unsupported one `unknown`.
 */
export type FindingOrigin = "introduced" | "preexisting" | "unknown";
/** Whether the finding survived refutation; Tesota sets it, never the reviewer (decision 016). */
export type FindingStanding = "confirmed" | "refuted" | "unsettled";

export interface Finding {
  readonly severity: FindingSeverity;
  readonly disposition: FindingDisposition;
  readonly origin: FindingOrigin;
  readonly path?: string;
  readonly line?: number;
  /** The last line when the finding covers a range from `line`. */
  readonly endLine?: number;
  /** The problem, in one sentence. */
  readonly statement: string;
  /** What in the request, the code or the checks shows it. */
  readonly reason: string;
  /**
   * Set when the finding disputes a request's premise: the behavior it calls a
   * bug is intended, the code it names does not exist, or the defect is not this
   * repository's. Such a finding is always the operator's call: only the
   * operator can say the documented behavior should change after all.
   */
  readonly premise?: true;
  /** Why Tesota made the reviewer's origin claim `unknown`; absent when the claim stood. */
  readonly originNote?: string;
  /** Absent until the refuter has tested the finding. */
  readonly standing?: FindingStanding;
  /** The refuter's evidence for its verdict. */
  readonly refutation?: string;
  /**
   * Set when another reviewer's finding already reports the same problem: the
   * reviewer and statement of that finding. A duplicate is kept in the
   * journal but neither shown twice nor sent back twice.
   */
  readonly duplicateOf?: string;
}

/**
 * Something the result must hold (decision 034): a part of an operator
 * request, or a plan step the agent marked done, which is its claim. The main
 * reviewer judges each against the whole result; the refuter tests each gap.
 */
export interface Obligation {
  readonly source: "request" | "plan";
  /** The 1-based number of the request, or of the step in the agent's plan. */
  readonly index: number;
  /** What must hold, in one sentence. */
  readonly obligation: string;
  readonly status: ObligationStatus;
  /** What in the code, the checks or the request shows the status. */
  readonly evidence: string;
  /**
   * For a partial or unmet obligation, as for a finding: `fixable` when the agent can satisfy it within the request,
   * `operator` when it cannot, as when a check fails on the base for a reason outside the change. Absent counts as
   * `fixable`, as reviews recorded before obligations carried one.
   */
  readonly disposition?: FindingDisposition;
  /** Set on a partial or unmet obligation once the refuter tested it; absent otherwise. */
  readonly standing?: FindingStanding;
  readonly refutation?: string;
}

/**
 * A message the reviewer judged part of an earlier request rather than a
 * request of its own (#253), such as "continue" or "ask again": it has no
 * obligations, and whatever it adds is judged under the request it continues.
 */
export interface Continuation {
  /** The 1-based number of the message. */
  readonly index: number;
  /** The 1-based number of the earlier request it continues. */
  readonly continues: number;
}

/** A plan step the agent marked done, given to the reviewer as a claim to check. */
export interface ClaimedStep {
  readonly index: number;
  readonly step: string;
  readonly check?: string | undefined;
}

/**
 * What a web call returned that a reviewer may hold a sourced claim to (issue
 * #300), never the page itself: a search's sources, or the quotes of a page
 * reader's answer that Tesota found on the page it fetched. Both stay
 * untrusted content from the web.
 */
export type WebEvidence =
  | Readonly<{ kind: "search"; sources: readonly Readonly<{ url: string; title: string }>[] }>
  /** `unfound` counts the reader's quotes that were not on the page, or that the quote rule left out. */
  | Readonly<{ kind: "page"; url: string; quotes: readonly string[]; unfound: number }>;

/**
 * A tool call of the agent's as Tesota recorded it, not as the agent reports
 * it: evidence for what the agent read, ran or changed, and for a web call
 * what it returned.
 */
export interface ToolCallRecord {
  readonly tool: string;
  readonly subject: string;
  readonly outcome: "succeeded" | "failed" | "unfinished";
  readonly evidence?: WebEvidence;
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
  /**
   * The plan steps the agent marked done (decision 033), as claims for the
   * reviewer to check against the result; never as an account to trust.
   */
  readonly claimedSteps?: readonly ClaimedStep[];
  /**
   * The agent's final reply, when its turn changed no files (decision 034):
   * the reviewer checks the requests against the repository and this reply,
   * which is untrusted and can never show that requested code exists.
   */
  readonly response?: string;
  /**
   * With `response`, the agent's tool calls since the first of `requests`,
   * correction rounds included (issue #300), so a claim in the reply about
   * reading, running or changing something, or drawn from a search or a
   * page, is checked against what happened rather than the agent's account
   * of it.
   */
  readonly toolCalls?: readonly ToolCallRecord[];
}

export type ReviewReport =
  | Readonly<{ reviewer: string; tree: string; status: "completed"; summary: string; findings: readonly Finding[];
      /** The main reviewer's obligations; focused reviewers and ClaimCheck report none. */
      obligations?: readonly Obligation[];
      /** The main reviewer's messages that continue an earlier request, which count as no request of their own. */
      continuations?: readonly Continuation[];
      /** The model that wrote the report, and the refuter's when it tested the report's findings or obligations. */
      model?: string; refuter?: string }>
  | Readonly<{ reviewer: string; tree: string; status: "incomplete"; reason: string; model?: string }>;

export interface Reviewer {
  readonly name: string;
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewReport>;
}
