/**
 * Where a changed file's lines count in the receipt's summary of the change
 * (#527): tests by the gate's test-path rule first; then a generated file, or
 * one in no programming language (documentation, configuration, a manifest
 * or lockfile, an asset), is other; the rest is implementation. A category
 * says where the lines are, never how risky they are.
 */
export type ChangeCategory = "implementation" | "tests" | "other";

//@ ensures test ==> \result === "tests"
//@ ensures !test && (generated || !source) ==> \result === "other"
//@ ensures !test && !generated && source ==> \result === "implementation"
export function changeCategory(test: boolean, generated: boolean, source: boolean): ChangeCategory {
  if (test) return "tests";
  return source && !generated ? "implementation" : "other";
}
