import { expect, it } from "vitest";
import type { DiffLine } from "../src/diff-lines.js";
import { uncoveredLines } from "../src/proof-coverage.js";
import type { Weakening } from "../src/verification-changes.js";

const source = [
  "//@ ensures \\result >= 0",
  "export function covered(n: number): number {",
  "  return n * n;",
  "}",
  "",
  "export function plain(n: number): number {",
  "  return n + 1;",
  "}",
  "",
  "//@ requires n > 0",
  "//@ ensures \\result > 0",
  "export function narrowed(n: number): number {",
  "  return n;",
  "}",
  "",
].join("\n");

const lines = (...numbers: number[]): DiffLine[] => numbers.map((number) => ({ number, text: `line ${number}` }));

it("lists changed lines outside every proved contract, and blank ones not at all", () => {
  const change = { path: "src/rule.ts", status: "modified" as const, added: [...lines(3, 6, 7), { number: 9, text: "" }],
    removed: [{ number: 13, text: "  return 0;" }] };
  expect(uncoveredLines(change, source, source, [])).toEqual({ path: "src/rule.ts", lines: [[6, 7]] });
});

it("lists the lines of a function whose contract the change narrowed", () => {
  const change = { path: "src/rule.ts", status: "modified" as const, added: lines(3, 10, 13), removed: [] };
  const added: Weakening = { path: "src/rule.ts", kind: "added_requires", annotation: "//@ requires n > 0" };
  expect(uncoveredLines(change, source, source, [added]).lines).toEqual([[10, 10], [13, 13]]);
  const base = source.replace("//@ ensures \\result > 0", "//@ ensures \\result > n");
  const removed: Weakening = { path: "src/rule.ts", kind: "removed_contract", annotation: "//@ ensures \\result > n" };
  expect(uncoveredLines(change, source, base, [removed]).lines).toEqual([[10, 10], [13, 13]]);
  const elsewhere: Weakening = { path: "src/other.ts", kind: "added_requires", annotation: "//@ requires n > 0" };
  expect(uncoveredLines(change, source, source, [elsewhere]).lines).toEqual([]);
});

it("covers nothing in a file whose proof gained an assumption, and counts a removed last line at the file's end", () => {
  const change = { path: "src/rule.ts", status: "modified" as const, added: lines(3), removed: [{ number: 40, text: "}" }] };
  const assumed: Weakening = { path: "src/rule.dfy", kind: "added_assume", annotation: "assume false;" };
  expect(uncoveredLines(change, source, source, [assumed]).lines).toEqual([[3, 3], [15, 15]]);
});
