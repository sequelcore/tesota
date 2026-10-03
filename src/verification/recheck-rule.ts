/**
 * How a finding sent back to the agent stands in the review after the
 * correction (#250): re-judged against the current content, it is resolved,
 * still present, or was not re-checked, and the review says which, so a
 * carried finding never reads as a new one and is never dropped unjudged.
 */
export type Recheck = "resolved" | "present" | "unchecked";

/** The fix validator's verdict on one finding; `none` when it gave none, as when it did not finish. */
export type RecheckVerdict = "resolved" | "unresolved" | "undetermined" | "none";

/**
 * A correction that changed nothing leaves every finding it was sent where it
 * was, whatever a validator says. Otherwise a finding is resolved or still
 * present only on the validator's verdict, and anything else was not
 * re-checked.
 */
//@ ensures !correctionChanged ==> \result === "present"
//@ ensures \result === "resolved" ==> correctionChanged && verdict === "resolved"
//@ ensures correctionChanged && verdict === "resolved" ==> \result === "resolved"
//@ ensures correctionChanged && verdict === "unresolved" ==> \result === "present"
//@ ensures correctionChanged && (verdict === "undetermined" || verdict === "none") ==> \result === "unchecked"
export function recheckOf(correctionChanged: boolean, verdict: RecheckVerdict): Recheck {
  if (!correctionChanged) return "present";
  if (verdict === "resolved") return "resolved";
  return verdict === "unresolved" ? "present" : "unchecked";
}
