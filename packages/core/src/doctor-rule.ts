/** Missing tools are unavailable; a found tool whose smoke test does not pass is failed. */
//@ ensures !found ==> \result === "unavailable"
//@ ensures found && passed ==> \result === "available"
//@ ensures found && !passed ==> \result === "failed"
export function doctorStatus(found: boolean, passed: boolean): string {
  if (!found) return "unavailable";
  return passed ? "available" : "failed";
}

/** Failures take precedence over missing tools; neither prevents using Tesota. */
//@ ensures failed ==> \result === 1
//@ ensures !failed && unavailable ==> \result === 2
//@ ensures !failed && !unavailable ==> \result === 0
export function doctorExitCode(failed: boolean, unavailable: boolean): number {
  if (failed) return 1;
  return unavailable ? 2 : 0;
}
