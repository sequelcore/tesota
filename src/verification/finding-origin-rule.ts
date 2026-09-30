export type FindingOriginClaim = "introduced" | "preexisting" | "unknown";
/** What the candidate did to the finding's file: `none` when the finding names no file. */
export type FileChange = "none" | "untouched" | "created" | "deleted" | "modified";

/**
 * Decision 018's origin rule. Tesota keeps a reviewer's origin claim only
 * when the candidate's diff supports it, and never turns one claim into the
 * other: the diff shows where a change touched the code, not that anything
 * else is fine. `readable` is whether the diff shows the file's lines,
 * `located` whether the finding names a line, and `touched` and `added`
 * whether any of its lines is one the candidate added or sits beside lines it
 * only removed, or one it added.
 */
//@ ensures \result === claim || \result === "unknown"
//@ ensures claim === "unknown" ==> \result === "unknown"
//@ ensures claim === "introduced" && (file === "created" || file === "deleted") ==> \result === "introduced"
//@ ensures claim === "introduced" && file === "modified" && readable && located && touched ==> \result === "introduced"
//@ ensures claim === "introduced" && (file === "none" || file === "untouched") ==> \result === "unknown"
//@ ensures claim === "introduced" && file === "modified" && !(readable && located && touched) ==> \result === "unknown"
//@ ensures claim === "preexisting" && file === "created" ==> \result === "unknown"
//@ ensures claim === "preexisting" && file === "modified" && readable && located && added ==> \result === "unknown"
//@ ensures claim === "preexisting" && file !== "created" && !(file === "modified" && readable && located && added) ==> \result === "preexisting"
export function checkedOrigin(claim: FindingOriginClaim, file: FileChange, readable: boolean, located: boolean,
  touched: boolean, added: boolean): FindingOriginClaim {
  if (claim === "introduced") {
    if (file === "created" || file === "deleted") return "introduced";
    return file === "modified" && readable && located && touched ? "introduced" : "unknown";
  }
  if (claim === "preexisting") {
    if (file === "created") return "unknown";
    return file === "modified" && readable && located && added ? "unknown" : "preexisting";
  }
  return "unknown";
}
