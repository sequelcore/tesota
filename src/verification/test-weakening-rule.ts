import type { ChangeStatus } from "../diff-lines.js";

/**
 * Whether a line a change removed from a test file removes or changes what
 * its tests check: any line but a blank or comment-only one, or an import
 * the change widened (`widenedImport`): one an added line replaces with an
 * import from the same module, in the same form, of every name it had and
 * more. A line that only moved still counts, and so does an assertion
 * commented out, since its original line is removed.
 */
//@ ensures \result <==> !blank && !comment && !widenedImport
export function removalCounts(blank: boolean, comment: boolean, widenedImport: boolean): boolean {
  return !blank && !comment && !widenedImport;
}

/**
 * Whether a change to a test file may weaken the tests it held, against the
 * request's base: deleting the file, or editing it so that it removes a line
 * that counts (`removalCounts`, `removes`) or adds one that changes how its
 * existing tests run (`changesRuns`): a focus or skip marker, a setup or
 * teardown hook, or a module mock. A new test file, or one that only gains
 * tests, weakens nothing.
 */
//@ ensures \result <==> status === "deleted" || (status === "modified" && (removes || changesRuns))
export function testWeakens(status: ChangeStatus, removes: boolean, changesRuns: boolean): boolean {
  if (status === "deleted") return true;
  return status === "modified" && (removes || changesRuns);
}
