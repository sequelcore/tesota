/**
 * Which sections of the system prompt a request sends again (#779): each
 * whose text differs from what the model already has, so an unchanged
 * section never moves the head a provider caches.
 */
//@ requires previous.length === current.length
//@ ensures \result.length === current.length
//@ ensures forall(i: nat, i < current.length ==> (\result[i] <==> previous[i] !== current[i]))
export function changedSections(previous: readonly string[], current: readonly string[]): boolean[] {
  const changed: boolean[] = [];
  let i = 0;
  while (i < current.length) {
    //@ invariant 0 <= i && i <= current.length && changed.length === i
    //@ invariant forall(k: nat, k < i ==> (changed[k] <==> previous[k] !== current[k]))
    changed.push(previous[i] !== current[i]);
    i = i + 1;
  }
  return changed;
}

/**
 * What a request adds to the transcript's system messages (#779): the
 * leading one while the model has none, a change once a section or a tool
 * changed, and nothing otherwise.
 */
//@ ensures !hasLeading ==> \result === "leading"
//@ ensures hasLeading && (sectionsChanged || toolsChanged) ==> \result === "change"
//@ ensures hasLeading && !sectionsChanged && !toolsChanged ==> \result === "none"
export function promptStep(hasLeading: boolean, sectionsChanged: boolean, toolsChanged: boolean): "leading" | "change" | "none" {
  if (!hasLeading) return "leading";
  if (sectionsChanged || toolsChanged) return "change";
  return "none";
}
