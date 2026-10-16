/**
 * Whether a list of edits may be applied to a file, all at once: there is at
 * least one edit, each edit's text occurs exactly once in the original file
 * (`matches[i]`), each changes something (`changes[i]`), and no two of the
 * stretches they replace overlap. Edit `i` replaces `starts[i]` up to
 * `ends[i]`, both measured in the original file. When this is false the
 * edit tool writes nothing.
 */
//@ requires matches.length === starts.length && starts.length === ends.length && ends.length === changes.length
//@ requires forall(i: nat, i < starts.length ==> starts[i] <= ends[i])
//@ ensures \result <==> (matches.length > 0 && forall(i: nat, i < matches.length ==> matches[i] === 1 && changes[i]) && forall(i: nat, forall(j: nat, i < j && j < starts.length ==> ends[i] <= starts[j] || ends[j] <= starts[i])))
export function editsApply(matches: readonly number[], starts: readonly number[], ends: readonly number[],
  changes: readonly boolean[]): boolean {
  if (matches.length === 0) return false;
  let i = 0;
  while (i < matches.length) {
    //@ invariant 0 <= i && i <= matches.length
    //@ invariant forall(k: nat, k < i ==> matches[k] === 1 && changes[k])
    //@ invariant forall(a: nat, forall(b: nat, a < b && b < starts.length && a < i ==> ends[a] <= starts[b] || ends[b] <= starts[a]))
    if (matches[i] !== 1 || !changes[i]) return false;
    let j = i + 1;
    while (j < starts.length) {
      //@ invariant i + 1 <= j && j <= starts.length
      //@ invariant forall(b: nat, i < b && b < j ==> ends[i] <= starts[b] || ends[b] <= starts[i])
      if (!((ends[i] as number) <= (starts[j] as number) || (ends[j] as number) <= (starts[i] as number))) return false;
      j = j + 1;
    }
    i = i + 1;
  }
  return true;
}
