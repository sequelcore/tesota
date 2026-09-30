import { triageAnswer, type TriageDecision } from "./integrations/answer-triage.js";
import { jevTriage, typesafeKey } from "./integrations/jev-triage.js";
import { type ModelAccess, openModelTarget } from "./integrations/model-session.js";
import { applyRefutation, hasClaimsToTest, refuteFindings } from "./integrations/pi-refuter.js";
import { createPiReviewer } from "./integrations/pi-reviewer.js";
import { isDecisionModel, ROLE_OFF } from "./model-roles.js";
import type { ReviewInput, ReviewReport } from "./review.js";
import { obligationOutcome } from "./verification/obligation-outcome.js";

/**
 * The answer check of a turn that changed no files (decision 034), shared by
 * the shell and the answer evaluation so both run the same pipeline: a first
 * pass that may skip the turn, then the main reviewer, then the refuter on
 * any gap.
 */

/**
 * The first pass on the triage role's `choice`, a model session or a typed
 * decision model (decisions 034 and 035). Off, or failing in any way, it
 * decides nothing, and the full check runs.
 */
export async function firstPass(choice: string, requests: readonly string[], reply: string,
  signal: AbortSignal): Promise<TriageDecision> {
  const undecided = (reason: string): TriageDecision => ({ decided: false, checkable: true, reason });
  try {
    if (choice === ROLE_OFF) return undecided("the first pass is off");
    if (!isDecisionModel(choice)) return await triageAnswer({ target: await openModelTarget(choice, signal) }, requests, reply, signal);
    const key = await typesafeKey();
    return key === undefined ? undecided("no TypeSafe key") : await jevTriage(key, choice, requests, reply, signal);
  } catch { return undecided("the first pass failed"); }
}

/** The full check: the main reviewer, then the refuter on any gap; never throws, and an error leaves it incomplete. */
export async function reviewAnswer(open: (role: "reviewer" | "refuter") => Promise<ModelAccess>, input: ReviewInput,
  signal: AbortSignal, onPhase: (activity: string) => void = () => undefined): Promise<ReviewReport[]> {
  onPhase("Checking the answer against your requests");
  try {
    const reports = [await createPiReviewer(await open("reviewer")).review(input, signal)];
    if (signal.aborted || !hasClaimsToTest(reports)) return reports;
    onPhase("Testing each gap");
    return await refuteFindings(await open("refuter"), input, reports, signal)
      .catch(() => applyRefutation(reports, undefined));
  } catch (error) {
    return [{ reviewer: "Tesota reviewer", tree: input.snapshot.tree, status: "incomplete",
      reason: error instanceof Error ? error.message : "the reviewer could not start" }];
  }
}

/** Whether every request held: the main review finished and each obligation held after refutation. */
export function answerHeld(reports: readonly ReviewReport[]): boolean {
  const main = reports.find((report) => report.status === "completed");
  return main?.status === "completed" && (main.obligations ?? []).every((item) =>
    obligationOutcome(item.status, item.standing ?? "untested") === "held");
}
