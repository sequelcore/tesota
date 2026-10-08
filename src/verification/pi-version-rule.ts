/**
 * Whether an installed Pi meets the minimum version Tesota declares for it:
 * release numbers compared in order, major first.
 */
//@ requires major >= 0 && minor >= 0 && patch >= 0 && minMajor >= 0 && minMinor >= 0 && minPatch >= 0
//@ ensures \result <==> major > minMajor || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)))
export function versionAtLeast(major: number, minor: number, patch: number, minMajor: number, minMinor: number,
  minPatch: number): boolean {
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}
