export type ApplicationAdmission = "apply" | "recover" | "stale_review" | "refresh";
/**
 * What a path holds, judged against one application's content for it:
 * `before` the source's content when the application was planned, `after`
 * the reviewed content, and `other` anything else, such as a later edit. A
 * path absent where the application expects none (an added file before, a
 * deleted one after) counts as that side.
 */
export type PathContent = "before" | "after" | "other";
export type CommitStep = "install" | "done" | "stop";
export type RestoreStep = "restore" | "done" | "stop";
export type ApplicationOutcome = "applied" | "not_applied" | "recovery_required";

/**
 * Decision 042's admission of an application. An application to the same
 * source that has not finished comes first, since a new one would build on a
 * source nobody knows the state of; then the review must still describe the
 * workspace's exact tree; then the whole source must still hold what the
 * workspace last took from it, so that what is applied is exactly what was
 * checked and reviewed, never that combined with edits nobody checked.
 */
//@ ensures \result === "apply" <==> (!unfinished && reviewCurrent && sourceUnchanged)
//@ ensures unfinished ==> \result === "recover"
//@ ensures !unfinished && !reviewCurrent ==> \result === "stale_review"
//@ ensures !unfinished && reviewCurrent && !sourceUnchanged ==> \result === "refresh"
export function applicationAdmission(unfinished: boolean, reviewCurrent: boolean,
  sourceUnchanged: boolean): ApplicationAdmission {
  if (unfinished) return "recover";
  if (!reviewCurrent) return "stale_review";
  return sourceUnchanged ? "apply" : "refresh";
}

/**
 * Decision 042's step toward the reviewed content for one path: Tesota
 * replaces only the content it planned from, treats the reviewed content as
 * already in place, and never replaces or removes anything else.
 */
//@ ensures \result === "install" <==> content === "before"
//@ ensures \result === "done" <==> content === "after"
//@ ensures \result === "stop" <==> content === "other"
export function commitStep(content: PathContent): CommitStep {
  if (content === "before") return "install";
  return content === "after" ? "done" : "stop";
}

/**
 * What an application's journal and the path itself prove about whether
 * Tesota wrote the path: `written`, `not_written`, or `unknown` when an
 * interruption left only an intention and nothing shows whose file is there.
 */
export type WriteEvidence = "written" | "not_written" | "unknown";
/** A path's last journal step, `none` when the application never reached it. */
export type JournalStep = "none" | "intended" | "done" | "untouched";

/**
 * Decision 042's evidence of a write. A step journaled `done` is Tesota's
 * write, and one never attempted or journaled `untouched` is not. An
 * `intended` step records only that a write was about to start: it counts as
 * one only when the file at the path is the very file Tesota installed (the
 * same file as the temporary it kept for that write), or when the step
 * removed the path, which undoing can only reverse by creating the original
 * where the name is free, so no one else's file is ever removed on it.
 * Otherwise whose file is there stays unknown, since equal content alone is
 * not Tesota's write.
 */
//@ ensures \result === "written" <==> (step === "done" || step === "intended" && (installed || removal))
//@ ensures \result === "not_written" <==> (step === "none" || step === "untouched")
//@ ensures \result === "unknown" <==> (step === "intended" && !installed && !removal)
export function writeEvidence(step: JournalStep, installed: boolean, removal: boolean): WriteEvidence {
  if (step === "done") return "written";
  if (step === "none" || step === "untouched") return "not_written";
  return installed || removal ? "written" : "unknown";
}

/**
 * Decision 042's step back to the original for one path, when an application
 * is undone: Tesota puts the original back only where the evidence shows its
 * own write and the path still holds exactly what it wrote. A path Tesota did
 * not write is left whatever it holds, and one whose writer is unknown is
 * left unless it holds its original, so the application stays unfinished
 * rather than removing a file that may be someone else's.
 */
//@ ensures \result === "restore" <==> (evidence === "written" && content === "after")
//@ ensures \result === "done" <==> (evidence === "not_written" || content === "before")
//@ ensures \result === "stop" <==> (evidence !== "not_written" && content !== "before" && !(evidence === "written" && content === "after"))
export function restoreStep(evidence: WriteEvidence, content: PathContent): RestoreStep {
  if (evidence === "not_written" || content === "before") return "done";
  return evidence === "written" && content === "after" ? "restore" : "stop";
}

/**
 * Decision 042's outcome of an application of `paths` changed paths, each read
 * back: `after` hold the reviewed content, and `unaffected` hold their
 * original or were never written by the application, whatever someone else
 * put there, even the reviewed content itself. Applied only when every path
 * holds the reviewed content, not applied only when otherwise no path keeps
 * an effect of the application, and anything between is a partial effect
 * that needs recovery, never reported as either.
 */
//@ requires paths > 0 && after >= 0 && unaffected >= 0 && after <= paths && unaffected <= paths
//@ ensures \result === "applied" <==> after === paths
//@ ensures \result === "not_applied" <==> (after < paths && unaffected === paths)
//@ ensures \result === "recovery_required" <==> (after < paths && unaffected < paths)
export function applicationOutcome(paths: number, after: number, unaffected: number): ApplicationOutcome {
  if (after === paths) return "applied";
  if (unaffected === paths) return "not_applied";
  return "recovery_required";
}
