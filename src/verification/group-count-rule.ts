/** Total multiplicity, including zero weights (nonviolating members). */
//@ ensures values.length === 0 ==> \result === 0
//@ ensures values.length > 0 ==> \result === values[0] + weightTotal(values.slice(1))
export function weightTotal(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return (values[0] as number) + weightTotal(values.slice(1));
}

//@ requires selected.length === weights.length
//@ ensures weights.length === 0 ==> \result === 0
//@ ensures weights.length > 0 ==> \result === (selected[0] ? weights[0] : 0) + selectedTotal(selected.slice(1), weights.slice(1))
export function selectedTotal(selected: readonly boolean[], weights: readonly number[]): number {
  if (weights.length === 0) return 0;
  return (selected[0] ? weights[0] as number : 0) + selectedTotal(selected.slice(1), weights.slice(1));
}

/** Split a stream into one selected group and its complement. Any ordered
 * projection is a repeated partition: no member, violation or edge weight is lost. */
//@ requires selected.length === weights.length
//@ ensures \result.inside + \result.outside === weightTotal(weights)
//@ ensures \result.inside === selectedTotal(selected, weights)
//@ ensures forall(i: nat, i < selected.length ==> selected[i]) ==> \result.outside === 0
//@ ensures forall(i: nat, i < selected.length ==> !selected[i]) ==> \result.inside === 0
export function partitionWeights(selected: readonly boolean[], weights: readonly number[]): { inside: number; outside: number } {
  let inside = 0;
  let outside = 0;
  let k = weights.length;
  while (k > 0) {
    //@ invariant 0 <= k && k <= weights.length
    //@ invariant inside + outside === weightTotal(weights.slice(k))
    //@ invariant inside === selectedTotal(selected.slice(k), weights.slice(k))
    //@ invariant forall(i: nat, k <= i && i < selected.length ==> selected[i]) ==> outside === 0
    //@ invariant forall(i: nat, k <= i && i < selected.length ==> !selected[i]) ==> inside === 0
    k = k - 1;
    const weight = weights[k] as number;
    if (selected[k]) inside = inside + weight;
    else outside = outside + weight;
  }
  return { inside, outside };
}

/** Iterative runtime sum; the recursive definition above is its specification. */
//@ ensures \result === weightTotal(weights)
export function sumWeights(weights: readonly number[]): number {
  let total = 0;
  let k = weights.length;
  while (k > 0) {
    //@ invariant 0 <= k && k <= weights.length
    //@ invariant total === weightTotal(weights.slice(k))
    k = k - 1;
    total = total + (weights[k] as number);
  }
  return total;
}

/** A regrouping is accepted exactly when all three totals are conserved. */
//@ ensures \result <==> (weightTotal(members) === weightTotal(groupedMembers) && weightTotal(violations) === weightTotal(groupedViolations) && weightTotal(edges) === weightTotal(groupedEdges))
export function conservesCounts(members: readonly number[], violations: readonly number[], edges: readonly number[],
  groupedMembers: readonly number[], groupedViolations: readonly number[], groupedEdges: readonly number[]): boolean {
  return sumWeights(members) === sumWeights(groupedMembers) && sumWeights(violations) === sumWeights(groupedViolations)
    && sumWeights(edges) === sumWeights(groupedEdges);
}
