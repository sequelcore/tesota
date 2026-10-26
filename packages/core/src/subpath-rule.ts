/** A trailing character Windows may discard from a segment. */
//@ requires 0 <= i && i < segment.length
//@ ensures \result <==> segment.slice(i, i + 1) === "." || segment.slice(i, i + 1) === " "
export function dotOrSpaceAt(segment: string, i: number): boolean {
  return segment.slice(i, i + 1) === "." || segment.slice(i, i + 1) === " ";
}

/**
 * Conservative Windows segment normalization for the floor: strip trailing
 * dots/spaces from names. An all-dot/space segment is empty, except a leading
 * `..` stays a parent step (including ambiguous `...` or `.. ` spellings).
 */
//@ ensures forall(i: nat, i < segment.length ==> dotOrSpaceAt(segment, i)) ==> \result === (segment.length >= 2 && segment.slice(0, 1) === "." && segment.slice(1, 2) === "." ? ".." : "")
//@ ensures exists(i: nat, i < segment.length && !dotOrSpaceAt(segment, i)) ==> 0 < \result.length && \result.length <= segment.length && \result === segment.slice(0, \result.length) && !dotOrSpaceAt(\result, \result.length - 1) && forall(j: nat, \result.length <= j && j < segment.length ==> dotOrSpaceAt(segment, j))
export function normalizeWindowsSegment(segment: string): string {
  let end = segment.length;
  while (end > 0 && dotOrSpaceAt(segment, end - 1)) {
    //@ invariant 0 <= end && end <= segment.length
    //@ invariant forall(j: nat, end <= j && j < segment.length ==> dotOrSpaceAt(segment, j))
    end = end - 1;
  }
  if (end === 0) return segment.length >= 2 && segment.slice(0, 1) === "." && segment.slice(1, 2) === "." ? ".." : "";
  return segment.slice(0, end);
}

/**
 * How far the first `k` segments of a subpath go below the folder it starts
 * from (#633): one down for a name, one up for `..`, none for `.` or an empty
 * segment, which a doubled or trailing separator leaves.
 */
//@ requires 0 <= k && k <= segments.length
//@ decreases k
export function reach(segments: readonly string[], k: number): number {
  if (k === 0) return 0;
  const segment = segments[k - 1] as string;
  return reach(segments, k - 1) + (segment === ".." ? -1 : segment === "." || segment === "" ? 0 : 1);
}

/** Whether some of the first `k` segments of a subpath climb above the folder it starts from. */
//@ requires 0 <= k && k <= segments.length
//@ decreases k
export function above(segments: readonly string[], k: number): boolean {
  return k > 0 && (reach(segments, k) < 0 || above(segments, k - 1));
}

/**
 * Whether a subpath of a folder the floor guards, such as home, names that
 * folder or one above it (#633): it is empty, it ends where it started
 * (`.`, `x/..`), or it climbs above the folder on the way (`../x`).
 */
//@ ensures \result <==> reach(segments, segments.length) <= 0 || above(segments, segments.length)
export function climbsBack(segments: readonly string[]): boolean {
  let depth = 0;
  let climbed = false;
  let k = 0;
  while (k < segments.length) {
    //@ invariant 0 <= k && k <= segments.length
    //@ invariant depth === reach(segments, k)
    //@ invariant climbed === above(segments, k)
    const segment = segments[k] as string;
    depth = depth + (segment === ".." ? -1 : segment === "." || segment === "" ? 0 : 1);
    climbed = depth < 0 || climbed;
    k = k + 1;
  }
  return depth <= 0 || climbed;
}
