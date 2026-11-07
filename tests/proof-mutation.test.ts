import { expect, it } from "vitest";
import { equivalenceSource, mutants } from "../src/proof-mutation.js";
import { renderReceipt } from "../src/receipt.js";
import { arrowRequires, body, commentedRequires, expressionRequires, inside, moneyStrong, only, recursive, strong } from "./proof-mutation-fixtures.js";
import { emptyReceipt } from "./receipts.js";

it("swaps a branch's result, flips comparisons, moves numbers and swaps + and -, but never touches contracts or strings", async () => {
  const source = "//@ ensures \\result >= 0\nexport function f(a: number): number {\n  //@ invariant a < 10\n" +
    "  const s = \"a < b\"; // 1 < 2\n  if (a < 3) return a + 1;\n  return a - 2;\n}\n";
  const found = mutants(source, (await only(source)).body, 20);
  expect(found.map((mutant) => [mutant.line, mutant.operator, mutant.before, mutant.after])).toEqual([
    [5, "result", "a + 1", "a - 2"], [5, "comparison", "<", "<="], [5, "constant", "3", "4"], [5, "arithmetic", "+", "-"],
    [6, "result", "a - 2", "a + 1"], [5, "constant", "1", "2"], [6, "arithmetic", "-", "+"], [6, "constant", "2", "3"]]);
  expect(found[0]?.source).toContain("  if (a < 3) return a - 2;\n");
  expect(found.every((mutant) => mutant.source.includes("//@ invariant a < 10") && mutant.source.includes("\"a < b\""))).toBe(true);
  expect(mutants(source, (await only(source)).body, 3)).toHaveLength(3);
  // An escaped quote in a string keeps the columns after it in place.
  const escapedSource = "export function e(a: number): number {\n  const s = \"x\\\"y<\"; if (a < 3) return 0;\n  return 1;\n}\n";
  const escaped = mutants(escapedSource, inside(escapedSource)).find((mutant) => mutant.operator === "comparison");
  expect(escaped?.source).toContain("const s = \"x\\\"y<\"; if (a <= 3) return 0;");
  const arrowInside = "export function g(): void {\n  const f = (x: number) => x;\n}\n";
  expect(mutants(arrowInside, inside(arrowInside))).toEqual([]);
});

it("tries each logical change in mayMoveMoney without changing its contract", async () => {
  const found = mutants(moneyStrong, (await only(moneyStrong)).body);
  expect(found.map(({ operator, source }) => [operator, source])).toEqual([
    ["logical", moneyStrong.replace("return hasKey &&", "return hasKey ||")],
    ["logical", moneyStrong.replace("return hasKey &&", "return !hasKey &&")],
    ["logical", moneyStrong.replace("return hasKey && !alreadyCharged", "return hasKey && alreadyCharged")],
  ]);
});

it("keeps logical mutations in the capped mix alongside every existing operator", async () => {
  const source = "//@ ensures true\nexport function f(a: number, b: boolean): number {\n" +
    "  if (a < 1 && b) return a + 2 + 3 + 4 + 5 + 6 + 7 + 8;\n  return 0;\n}\n";
  const found = mutants(source, (await only(source)).body);
  expect(found).toHaveLength(8);
  expect(found.map(({ operator }) => operator)).toEqual([
    "result", "comparison", "constant", "arithmetic", "logical", "result", "constant", "arithmetic",
  ]);
});

it("swaps || and negates whole operands across lines, ignoring comments, strings and non-null assertions", async () => {
  const source = "//@ ensures true\nexport function f(a: number, b: boolean): boolean {\n" +
    "  /* a && !b */\n  const s = 'a || !b';\n  return (a < 1) ||\n    !b; // && !a\n}\n";
  const found = mutants(source, (await only(source)).body, 30).filter(({ operator }) => operator === "logical");
  expect(found.map(({ before, after }) => [before, after])).toEqual([
    ["||", "&&"], ["(a < 1)", "!((a < 1))"], ["!b", "b"],
  ]);
  expect(found.every(({ source }) => source.includes("/* a && !b */") && source.includes("'a || !b'"))).toBe(true);
  const unary = "//@ ensures true\nexport const f = (a: boolean): boolean => !a;\n";
  expect(mutants(unary, (await only(unary)).body).map(({ before, after }) => [before, after])).toEqual([["!a", "a"]]);
  const nonNull = "//@ ensures true\nexport const f = (a: boolean): boolean => a!;\n";
  expect(mutants(nonNull, (await only(nonNull)).body)).toEqual([]);
});

it("changes only the expression a one-line arrow function returns, never its signature", async () => {
  const source = "//@ ensures \\result >= 0\nexport const g = (n: number, m = 2): number => n < 0 ? 0 : n;\n";
  expect(mutants(source, (await only(source)).body).map((mutant) => [mutant.line, mutant.operator, mutant.before, mutant.after])).toEqual([
    [2, "comparison", "<", "<="], [2, "constant", "0", "1"], [2, "constant", "0", "1"]]);
  expect(mutants(source, (await only(source)).body)[0]?.source).toContain("(n: number, m = 2): number => n <= 0 ? 0 : n;");
});

it("calls a contract with surviving mutants weak in the receipt, and only counts those proved to behave the same", () => {
  const show = (mutation: { rejected: number; survived: { line: number; operator: "result"; before: string; after: string }[];
    inconclusive: number; equivalent: number }): string =>
    renderReceipt({ ...emptyReceipt,
        specificationEvidence: { ...emptyReceipt.specificationEvidence, contracts: [{ path: "src/clamp.ts", name: "clamp", lines: ["//@ ensures \\result >= 0"], mutation }] }
    });
  const strong = show({ rejected: 3, survived: [], inconclusive: 0, equivalent: 0 });
  expect(strong).toContain("  contract      clamp in src/clamp.ts: all 3 decided changes to its code fail the proof");
  expect(strong).not.toContain("behave the same");
  expect(show({ rejected: 3, survived: [], inconclusive: 0, equivalent: 2 }))
    .toContain("  contract      clamp in src/clamp.ts: all 3 decided changes to its code fail the proof; 2 proved to behave " +
      "the same as the code");
  expect(show({ rejected: 2, survived: [{ line: 6, operator: "result", before: "low", after: "high" }], inconclusive: 1, equivalent: 1 }))
    .toContain("  weak contract clamp in src/clamp.ts: 1 of 5 changes to its code still prove, so the contract does not rule " +
      "them out (one may behave the same as the original); 1 proved to behave the same as the code; 1 could not be decided\n" +
      "                line 6: low became high");
  expect(show({ rejected: 0, survived: [], inconclusive: 0, equivalent: 0 }))
    .toContain("  contract      clamp in src/clamp.ts: mutation found no change to try in its body");
});

it("builds the equivalence file with a fresh name for the mutant, and builds none for a function that calls itself", async () => {
  const mutated = strong.replace("(value > high)", "(value >= high)");
  // 5 is the declaration's line, 9 its closing brace; `clampMutant` is taken, so the copy is `clampMutant2`.
  const taken = `${strong}// clampMutant\n`;
  expect(equivalenceSource(taken, (await only(taken)), `${mutated}// clampMutant\n`)).toBe("//@ requires low <= high\n" +
    "export function clampMutant2(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
    "  if (value >= high) return high;\n  return value;\n}\n\n//@ requires low <= high\n" +
    "//@ ensures \\result === clampMutant2(value, low, high)\n" + body + "// clampMutant\n");
  expect(equivalenceSource(recursive, (await only(recursive)), recursive.replace("n - 1", "n + 1"))).toBeUndefined();
  const destructured = "//@ ensures true\nexport function d({ a }: { a: number }): number {\n  return a;\n}\n";
  expect(equivalenceSource(destructured, (await only(destructured)), "")).toBeUndefined();
});

it("keeps the contract but its ensures wherever it is, and places the equality where LemmaScript reads it", async () => {
  expect(equivalenceSource(commentedRequires, (await only(commentedRequires)), commentedRequires.replace("return 0;", "return 1;")))
    .toBe("//@ pure\n//@ requires n > 0\nexport function fMutant(n: number): number {\n  if (n < 0) return 1;\n  return n;\n}\n\n" +
      "//@ pure\n//@ requires n > 0\n//@ ensures \\result === fMutant(n)\nexport function f(n: number): number {\n  if (n < 0) return 0;\n" +
      "  return n;\n}\n");
  expect(equivalenceSource(arrowRequires, (await only(arrowRequires)), arrowRequires.replace("return 0;", "return 1;")))
    .toBe(`export const hMutant = (n: number): number => {\n  //@ requires n > 0\n  ${" ".repeat(24)}\n` +
      "  if (n < 0) return 1;\n  return n;\n};\n\nexport const h = (n: number): number => {\n  //@ ensures \\result === hMutant(n)\n" +
      `  //@ requires n > 0\n  ${" ".repeat(24)}\n  if (n < 0) return 0;\n  return n;\n};\n`);
  expect(equivalenceSource(expressionRequires, (await only(expressionRequires)), expressionRequires.replace("? 0", "? 1")))
    .toBe("//@ requires n > 0\nexport const gMutant = (n: number): number => n < 0 ? 1 : n;\n\n" +
      "//@ requires n > 0\n//@ ensures \\result === gMutant(n)\nexport const g = (n: number): number => n < 0 ? 0 : n;\n");
});
