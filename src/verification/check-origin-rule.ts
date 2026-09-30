export type CheckOutcome = "passed" | "failed" | "timed_out" | "cancelled" | "not_started" | "unconfirmed" | "changed_files";
export type CheckOrigin = "introduced" | "preexisting" | "unknown";
/**
 * A test's status in the reports a check names: `absent` when every report was
 * read and none has the test, `unread` when a report could not be read.
 */
export type TestStatus = "passed" | "failed" | "skipped" | "absent" | "unread";
/** A test's result in the base's reports, or `none` when no report read there names it. */
export type ReportedTest = "passed" | "failed" | "skipped" | "none";

/**
 * Decision 040's status of a test on the base: its result there when a base
 * report names it; `absent` when none does although the base run wrote and
 * Tesota read a report the candidate named it in (`covered`), so the test
 * truly has no result without the changes; `unread` otherwise, since a report
 * the base run did not write says nothing about the tests it would hold.
 */
//@ ensures reported === "passed" ==> \result === "passed"
//@ ensures reported === "failed" ==> \result === "failed"
//@ ensures reported === "skipped" ==> \result === "skipped"
//@ ensures reported === "none" && covered ==> \result === "absent"
//@ ensures reported === "none" && !covered ==> \result === "unread"
//@ ensures \result === "absent" ==> reported === "none" && covered
export function baseTestStatus(reported: ReportedTest, covered: boolean): TestStatus {
  if (reported === "passed") return "passed";
  if (reported === "failed") return "failed";
  if (reported === "skipped") return "skipped";
  return covered ? "absent" : "unread";
}

/**
 * Decision 040's origin of one test that a check's reports name: a test that
 * fails with the changes is introduced when it passes without them or has no
 * result there at all (`baseTestStatus`), already there when it fails there
 * too, and of unknown cause when it was skipped there or its report could not
 * be read.
 */
//@ ensures candidate !== "failed" ==> \result === "unknown"
//@ ensures candidate === "failed" && (base === "passed" || base === "absent") ==> \result === "introduced"
//@ ensures \result === "introduced" ==> candidate === "failed" && (base === "passed" || base === "absent")
//@ ensures candidate === "failed" && base === "failed" ==> \result === "preexisting"
//@ ensures \result === "preexisting" ==> candidate === "failed" && base === "failed"
export function testOrigin(candidate: TestStatus, base: TestStatus): CheckOrigin {
  if (candidate !== "failed") return "unknown";
  if (base === "passed" || base === "absent") return "introduced";
  if (base === "failed") return "preexisting";
  return "unknown";
}

/**
 * Decision 039's origin rule for a failing check command, with decision 040's
 * tests. A command is run again on the candidate's base, in the same
 * environment, only when it failed or timed out on the candidate: the
 * candidate introduced the failure when the base passes, or when the base
 * failed or timed out too and some test the command reports is introduced
 * (`testOrigin`); the failure was already there only when the base ends the
 * same way and no test is introduced. Anything else, such as a base run that
 * could not start, was stopped or changed files, leaves the cause unknown.
 * Tests can only make a failure introduced, never already there, since a
 * report does not cover the rest of what a command checks. Only an introduced
 * failure goes back to the working agent.
 */
//@ requires introducedTests >= 0
//@ ensures !(candidate === "failed" || candidate === "timed_out") ==> \result === "unknown"
//@ ensures (candidate === "failed" || candidate === "timed_out") && base === "passed" ==> \result === "introduced"
//@ ensures (candidate === "failed" || candidate === "timed_out") && introducedTests > 0 && (base === "failed" || base === "timed_out") ==> \result === "introduced"
//@ ensures (candidate === "failed" || candidate === "timed_out") && introducedTests === 0 && base === candidate ==> \result === "preexisting"
//@ ensures \result === "introduced" ==> base === "passed" || (introducedTests > 0 && (base === "failed" || base === "timed_out"))
//@ ensures \result === "preexisting" ==> base === candidate && candidate !== "passed" && introducedTests === 0
export function checkOrigin(candidate: CheckOutcome, base: CheckOutcome, introducedTests: number): CheckOrigin {
  if (candidate !== "failed" && candidate !== "timed_out") return "unknown";
  if (base === "passed") return "introduced";
  if (introducedTests > 0 && (base === "failed" || base === "timed_out")) return "introduced";
  if (base === candidate) return "preexisting";
  return "unknown";
}
