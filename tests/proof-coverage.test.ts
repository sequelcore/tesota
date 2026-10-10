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
    removed: [{ number: 13, base: 13, text: "  return 0;" }] };
  expect(uncoveredLines(change, source, source, [])).toEqual({ path: "src/rule.ts", lines: [[6, 7]] });
});

it("leaves out comment-only changed lines, added or removed, even inside a block comment, but lists //@ lines and code", () => {
  const changed = ["export function plain(n: number): number {", "  // plain adds one", "  //@ assert n >= n", "  /* a block",
    "     plain middle line", "  */", "  return n + 1; // and a note", "}", ""];
  const before = ["export function plain(n: number): number {", "  /**", "   * note */", "  /* old", "     middle", "  */",
    "  // an old note", "  return n;", "}", ""];
  const change = { path: "src/rule.ts", status: "modified" as const,
    added: [2, 3, 4, 5, 6, 7].map((number) => ({ number, text: changed[number - 1] ?? "" })),
    removed: [2, 3, 4, 5, 6, 7, 8].map((line) => ({ number: 7, base: line, text: before[line - 1] ?? "" })) };
  expect(uncoveredLines(change, changed.join("\n"), before.join("\n"), []).lines).toEqual([[3, 3], [7, 7]]);
});

it("covers a function whose contract a comment separates from it, but not one a code line separates", () => {
  const commented = "//@ ensures \\result > 0\n// reviewed\nexport function f(): number {\n  return 1;\n}\n";
  const change = { path: "src/rule.ts", status: "modified" as const, added: [{ number: 4, text: "  return 1;" }], removed: [] };
  expect(uncoveredLines(change, commented, commented, []).lines).toEqual([]);
  const detached = commented.replace("// reviewed", "const k = 1;");
  expect(uncoveredLines(change, detached, detached, []).lines).toEqual([[4, 4]]);
  const arrow = "//@ ensures \\result > 0\n/* reviewed\n   again\n*/\nexport const f = (): number =>\n  1;\n";
  const arrowChange = { ...change, added: [{ number: 6, text: "  1;" }] };
  expect(uncoveredLines(arrowChange, arrow, arrow, []).lines).toEqual([]);
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
  const change = { path: "src/rule.ts", status: "modified" as const, added: lines(3), removed: [{ number: 40, base: 40, text: "}" }] };
  const assumed: Weakening = { path: "src/rule.dfy", kind: "added_assume", annotation: "assume false;" };
  expect(uncoveredLines(change, source, source, [assumed]).lines).toEqual([[3, 3], [15, 15]]);
});
