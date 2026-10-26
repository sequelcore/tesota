/** A LemmaScript `//@` line's kind, by its first word, or a Dafny `assume`; `other` for any other annotation. */
export type AnnotationKind = "requires" | "ensures" | "assume" | "skip" | "other";

/**
 * Whether one annotation line a change removed (`removed`) or added, against
 * the request's base, may weaken what its proof shows: a removed or changed
 * `requires` or `ensures` changes the contract the proof is about, an added
 * `requires` on a function the base already had (`existed`) narrows its
 * contract, an added `skip` on something the base already had leaves it out
 * of the proof, and an added `assume` lets the proof take something on
 * trust. A line the change also put back on the other side of the diff
 * (`matched`) only moved, which weakens nothing.
 */
//@ ensures \result <==> !matched && ((removed && (kind === "requires" || kind === "ensures")) || (!removed && (kind === "assume" || ((kind === "requires" || kind === "skip") && existed))))
export function weakens(kind: AnnotationKind, removed: boolean, matched: boolean, existed: boolean): boolean {
  if (matched) return false;
  if (removed) return kind === "requires" || kind === "ensures";
  return kind === "assume" || (kind === "requires" || kind === "skip") && existed;
}

/** A script selected at the request's base may weaken evidence when its command changes or it is no longer selected. */
//@ ensures \result <==> (wasSelected && (!isSelected || !sameCommand))
export function checkScriptWeakens(wasSelected: boolean, isSelected: boolean, sameCommand: boolean): boolean {
  return wasSelected && (!isSelected || !sameCommand);
}
