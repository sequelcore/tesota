/** Missing tools are unavailable; a found tool whose smoke test does not pass is failed. */
//@ ensures !found ==> \result === "unavailable"
//@ ensures found && passed ==> \result === "available"
//@ ensures found && !passed ==> \result === "failed"
export function doctorStatus(found: boolean, passed: boolean): string {
  if (!found) return "unavailable";
  return passed ? "available" : "failed";
}

/** Any failure (including optional tools) takes precedence. Only missing core capabilities or providers trigger 2; missing optional tools do not. */
//@ ensures failed ==> \result === 1
//@ ensures !failed && coreUnavailable ==> \result === 2
//@ ensures !failed && !coreUnavailable ==> \result === 0
export function doctorExitCode(failed: boolean, coreUnavailable: boolean): number {
  if (failed) return 1;
  return coreUnavailable ? 2 : 0;
}
