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
