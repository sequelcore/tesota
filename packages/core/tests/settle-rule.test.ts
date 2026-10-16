import { expect, test } from "bun:test";
import { afterExtensions, afterVerifier, continuationLimit } from "../src/settle-rule.ts";
import type { AfterExtensions, AfterVerifier } from "../src/settle-rule.ts";

test("a run allows 32 automatic continuations", () => {
  expect(continuationLimit).toBe(32);
});

const extensionCases: readonly [string, Parameters<typeof afterExtensions>, AfterExtensions][] = [
  ["a completed loop reaches verification", ["completed", false, false, false, 0, 32], "verify"],
  ["a handler continues below the limit", ["completed", false, false, true, 31, 32], "continue"],
  ["a continuation at the limit finalizes", ["completed", false, false, true, 32, 32], "finalize"],
  ["a continuation over the limit finalizes", ["completed", false, false, true, 33, 32], "finalize"],
  ["no continuation still verifies at a zero limit", ["completed", false, false, false, 0, 0], "verify"],
  ["a zero limit permits no automatic continuation", ["completed", false, false, true, 0, 0], "finalize"],
  ["cancellation with a throw finalizes", ["completed", true, true, true, 0, 32], "finalize"],
  ["cancellation alone finalizes", ["completed", true, false, false, 0, 32], "finalize"],
  ["a throw after a completed loop finalizes", ["completed", false, true, false, 0, 32], "finalize"],
  ["a throw prevents continuation", ["completed", false, true, true, 0, 32], "finalize"],
  ["an error run finalizes", ["error", false, false, false, 0, 32], "finalize"],
  ["an aborted run finalizes", ["aborted", false, false, false, 0, 32], "finalize"],
];

for (const [name, args, expected] of extensionCases) {
  test(name, () => {
    expect(afterExtensions(...args)).toBe(expected);
  });
}

const verifierCases: readonly [string, Parameters<typeof afterVerifier>, AfterVerifier][] = [
  ["normal verification completes", ["completed", true, false, false, true, false, false, 0, 32], "completed"],
  ["cancellation wins over a throw", ["completed", true, true, true, true, false, false, 0, 32], "aborted"],
  ["cancellation wins over a loop error", ["error", false, true, true, false, false, false, 0, 32], "aborted"],
  ["a throw after a completed loop is incomplete", ["completed", true, false, true, true, false, false, 0, 32], "incomplete"],
  ["no registered verifier is incomplete", ["completed", true, false, false, false, false, false, 0, 32], "incomplete"],
  ["no registered verifier may continue", ["completed", true, false, false, false, true, true, 0, 32], "incomplete"],
  ["a verifier that only finalized is incomplete", ["completed", false, false, false, true, true, true, 0, 32], "incomplete"],
  ["a verifier continues below the limit", ["completed", true, false, false, true, true, false, 31, 32], "continue"],
  ["a verifier continuation at the limit is incomplete", ["completed", true, false, false, true, true, false, 32, 32], "incomplete"],
  ["pending input does not rescue an exhausted automatic continuation", ["completed", true, false, false, true, true, true, 32, 32], "incomplete"],
  ["pending input continues without a verifier continuation", ["completed", true, false, false, true, false, true, 32, 32], "continue"],
  ["pending input continues at a zero limit", ["completed", true, false, false, true, false, true, 0, 0], "continue"],
  ["verification completes without a continuation budget", ["completed", true, false, false, true, false, false, 0, 0], "completed"],
  ["an error run stays error", ["error", false, false, false, false, true, true, 32, 32], "error"],
  ["an error run with a throw is incomplete", ["error", false, false, true, true, false, false, 0, 32], "incomplete"],
  ["an aborted run stays aborted", ["aborted", false, false, false, false, false, false, 0, 32], "aborted"],
  ["an aborted run with a throw stays aborted", ["aborted", true, false, true, true, true, true, 0, 32], "aborted"],
];

for (const [name, args, expected] of verifierCases) {
  test(name, () => {
    expect(afterVerifier(...args)).toBe(expected);
  });
}
