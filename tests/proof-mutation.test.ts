import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { type Contract, contracts } from "../src/proof-guarantees.js";
import { equivalenceSource, mutateContract, mutants } from "../src/proof-mutation.js";
import { renderReceipt } from "../src/receipt.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import type { ProofOutcome } from "../src/verification/proof-outcome-rule.js";
import { emptyReceipt } from "./receipts.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

const body = "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
  "  if (value > high) return high;\n  return value;\n}\n";
const strong = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
  "//@ ensures low <= value && value <= high ==> \\result === value\n//@ ensures value > high ==> \\result === high\n" + body;
const weak = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" + body;
/** Its contract allows `return 1` in the base case, a survivor that is not equivalent. */
const recursive = "//@ requires n >= 0\n//@ ensures \\result >= 0\nexport function sum(n: number): number {\n" +
  "  if (n === 0) return 0;\n  return n + sum(n - 1);\n}\n";

/**
 * The weak-contract cases registered on 2026-10-03, before any run, as
 * `AGENT_STRENGTHEN_CASES` in `src/agent-evaluation.ts` at `d0c03f66`: each
 * base proves while its function does what the request rules out, because
 * its contract is too weak to forbid it.
 */
const registeredWeak: Readonly<Record<string, string>> = {
  "clamp.ts": "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
    "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return high;\n" +
    "  if (value > high) return high;\n  return value;\n}\n",
  "discount.ts": "//@ requires price >= 0\n//@ ensures \\result <= price\nexport function discounted(price: number): number {\n" +
    "  return price >= 100 ? price - 10 : price;\n}\n",
  "quantity.ts": "//@ requires items.length > 0\n//@ ensures \\result >= items[0]\n" +
    "export function maxQuantity(items: number[]): number {\n  return items[0];\n}\n",
};

/** The one contract in `source`, read as file `path`. */
function only(source: string, path = "src/rule.ts"): Contract {
  const [contract] = contracts(path, source);
  if (contract === undefined) throw new Error(`no contract in ${path}`);
  return contract;
}

/** Mutation of the one contract in `source`, proved as file `path`. */
function mutateOnly(path: string, source: string): ReturnType<typeof mutateContract> {
  return mutateContract(only(source, path), source, AbortSignal.timeout(500_000));
}

/** The offsets inside the outermost braces of a source with one function. */
const inside = (source: string): [number, number] => [source.indexOf("{") + 1, source.lastIndexOf("}")];

it("swaps a branch's result, flips comparisons, moves numbers and swaps + and -, but never touches contracts or strings", () => {
  const source = "//@ ensures \\result >= 0\nexport function f(a: number): number {\n  //@ invariant a < 10\n" +
    "  const s = \"a < b\"; // 1 < 2\n  if (a < 3) return a + 1;\n  return a - 2;\n}\n";
  const found = mutants(source, only(source).body, 20);
  expect(found.map((mutant) => [mutant.line, mutant.operator, mutant.before, mutant.after])).toEqual([
    [5, "result", "a + 1", "a - 2"], [5, "comparison", "<", "<="], [5, "constant", "3", "4"], [5, "arithmetic", "+", "-"],
    [6, "result", "a - 2", "a + 1"], [5, "constant", "1", "2"], [6, "arithmetic", "-", "+"], [6, "constant", "2", "3"]]);
  expect(found[0]?.source).toContain("  if (a < 3) return a - 2;\n");
  expect(found.every((mutant) => mutant.source.includes("//@ invariant a < 10") && mutant.source.includes("\"a < b\""))).toBe(true);
  expect(mutants(source, only(source).body, 3)).toHaveLength(3);
  // An escaped quote in a string keeps the columns after it in place.
  const escapedSource = "export function e(a: number): number {\n  const s = \"x\\\"y<\"; if (a < 3) return 0;\n  return 1;\n}\n";
  const escaped = mutants(escapedSource, inside(escapedSource)).find((mutant) => mutant.operator === "comparison");
  expect(escaped?.source).toContain("const s = \"x\\\"y<\"; if (a <= 3) return 0;");
  const arrowInside = "export function g(): void {\n  const f = (x: number) => x;\n}\n";
  expect(mutants(arrowInside, inside(arrowInside))).toEqual([]);
});

it("changes only the expression a one-line arrow function returns, never its signature", () => {
  const source = "//@ ensures \\result >= 0\nexport const g = (n: number, m = 2): number => n < 0 ? 0 : n;\n";
  expect(mutants(source, only(source).body).map((mutant) => [mutant.line, mutant.operator, mutant.before, mutant.after])).toEqual([
    [2, "comparison", "<", "<="], [2, "constant", "0", "1"], [2, "constant", "0", "1"]]);
  expect(mutants(source, only(source).body)[0]?.source).toContain("(n: number, m = 2): number => n <= 0 ? 0 : n;");
});

it("calls a contract with surviving mutants weak in the receipt, and only counts those proved to behave the same", () => {
  const show = (mutation: { rejected: number; survived: { line: number; operator: "result"; before: string; after: string }[];
    inconclusive: number; equivalent: number }): string =>
    renderReceipt({ ...emptyReceipt, contracts: [{ path: "src/clamp.ts", name: "clamp", lines: ["//@ ensures \\result >= 0"], mutation }] });
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

it("builds the equivalence file with a fresh name for the mutant, and builds none for a function that calls itself", () => {
  const mutated = strong.replace("(value > high)", "(value >= high)");
  // 5 is the declaration's line, 9 its closing brace; `clampMutant` is taken, so the copy is `clampMutant2`.
  const taken = `${strong}// clampMutant\n`;
  expect(equivalenceSource(taken, only(taken), `${mutated}// clampMutant\n`)).toBe("//@ requires low <= high\n" +
    "export function clampMutant2(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
    "  if (value >= high) return high;\n  return value;\n}\n\n//@ requires low <= high\n" +
    "//@ ensures \\result === clampMutant2(value, low, high)\n" + body + "// clampMutant\n");
  expect(equivalenceSource(recursive, only(recursive), recursive.replace("n - 1", "n + 1"))).toBeUndefined();
  const destructured = "//@ ensures true\nexport function d({ a }: { a: number }): number {\n  return a;\n}\n";
  expect(equivalenceSource(destructured, only(destructured), "")).toBeUndefined();
});

/** Its `requires` rules out the only input where `return 1` would differ, and a comment separates it from the function. */
const commentedRequires = "//@ pure\n//@ requires n > 0\n// reviewed\n//@ ensures \\result >= 0\nexport function f(n: number): number {\n" +
  "  if (n < 0) return 0;\n  return n;\n}\n";
/** The same contract inside a block-bodied arrow function, the only place LemmaScript reads it. */
const arrowRequires = "export const h = (n: number): number => {\n  //@ requires n > 0\n  //@ ensures \\result >= 0\n" +
  "  if (n < 0) return 0;\n  return n;\n};\n";
/** The same contract above an arrow function that returns an expression. */
const expressionRequires = "//@ requires n > 0\n//@ ensures \\result >= 0\nexport const g = (n: number): number => n < 0 ? 0 : n;\n";

it("keeps the contract but its ensures wherever it is, and places the equality where LemmaScript reads it", () => {
  expect(equivalenceSource(commentedRequires, only(commentedRequires), commentedRequires.replace("return 0;", "return 1;")))
    .toBe("//@ pure\n//@ requires n > 0\nexport function fMutant(n: number): number {\n  if (n < 0) return 1;\n  return n;\n}\n\n" +
      "//@ pure\n//@ requires n > 0\n//@ ensures \\result === fMutant(n)\nexport function f(n: number): number {\n  if (n < 0) return 0;\n" +
      "  return n;\n}\n");
  expect(equivalenceSource(arrowRequires, only(arrowRequires), arrowRequires.replace("return 0;", "return 1;")))
    .toBe(`export const hMutant = (n: number): number => {\n  //@ requires n > 0\n  ${" ".repeat(24)}\n` +
      "  if (n < 0) return 1;\n  return n;\n};\n\nexport const h = (n: number): number => {\n  //@ ensures \\result === hMutant(n)\n" +
      `  //@ requires n > 0\n  ${" ".repeat(24)}\n  if (n < 0) return 0;\n  return n;\n};\n`);
  expect(equivalenceSource(expressionRequires, only(expressionRequires), expressionRequires.replace("? 0", "? 1")))
    .toBe("//@ requires n > 0\nexport const gMutant = (n: number): number => n < 0 ? 1 : n;\n\n" +
      "//@ requires n > 0\n//@ ensures \\result === gMutant(n)\nexport const g = (n: number): number => n < 0 ? 0 : n;\n");
});

it.runIf(dafny)("proves a mutant equivalent under a pure contract a comment separates, and in arrow functions", async () => {
  for (const [path, source, mutated] of [["f.ts", commentedRequires, commentedRequires.replace("return 0;", "return 1;")],
    ["h.ts", arrowRequires, arrowRequires.replace("return 0;", "return 1;")],
    ["g.ts", expressionRequires, expressionRequires.replace("? 0", "? 1")]] as const) {
    expect(await proveSource(path, mutated, AbortSignal.timeout(120_000)), path).toBe("passed");
    expect(await proveSource(path, equivalenceSource(source, only(source, path), mutated) ?? "", AbortSignal.timeout(120_000)), path)
      .toBe("passed");
  }
}, 600_000);

it.runIf(dafny)("drops a planted mutant Dafny proves equivalent and keeps a planted one that is not", async () => {
  const proved = (mutated: string): Promise<ProofOutcome> =>
    proveSource("clamp.ts", equivalenceSource(weak, only(weak), mutated) ?? "", AbortSignal.timeout(300_000));
  // `>` to `>=` returns `high` either way at `value === high`; `low` to `high` changes the result below the range.
  expect(await proved(weak.replace("value > high", "value >= high"))).toBe("passed");
  expect(await proved(weak.replace("return low;", "return high;"))).toBe("failed");
  const result = await mutateOnly("weak.ts", weak);
  expect(result.equivalent).toBeGreaterThan(0);
  expect(result.survived.map((mutant) => [mutant.line, mutant.before, mutant.after])).toContainEqual([4, "low", "high"]);
  expect(result.survived.map((mutant) => [mutant.line, mutant.before, mutant.after])).not.toContainEqual([5, ">", ">="]);
}, 600_000);

it.runIf(dafny)("keeps a surviving mutant of a function that calls itself, which no equivalence proof covers yet", async () => {
  const result = await mutateOnly("sum.ts", recursive);
  expect(result.equivalent).toBe(0);
  expect(result.survived.length).toBeGreaterThan(0);
}, 600_000);

it.runIf(dafny)("counts a source alone that verified nothing as vacuous, never as proved", async () => {
  // Each has a `//@` line Tesota counts, but nothing LemmaScript translates: Dafny verifies 0 items and exits 0.
  for (const source of ["//@ ensures \\result >= 0\nexport const x = 1;\n",
    "/*\n//@ ensures \\result >= 0\n*/\nexport function f(): number {\n  return 0;\n}\n"]) {
    expect(await proveSource("f.ts", source, AbortSignal.timeout(120_000))).toBe("vacuous");
  }
  expect(await proveSource("clamp.ts", strong, AbortSignal.timeout(120_000))).toBe("passed");
}, 300_000);

it.runIf(dafny)("rejects more mutants under a stronger contract", async () => {
  const strongResult = await mutateOnly("strong.ts", strong);
  const weakResult = await mutateOnly("weak.ts", weak);
  expect(strongResult.rejected).toBe(2);
  expect(strongResult.survived.map((mutant) => [mutant.line, mutant.before, mutant.after])).toContainEqual([6, "low", "high"]);
  expect(weakResult.rejected).toBe(0);
  // `<` to `<=` and `>` to `>=` return the bound either way at the bound, so Dafny proves them equivalent under both contracts.
  expect(weakResult.survived.length).toBe(3);
  expect([weakResult.equivalent, strongResult.equivalent]).toEqual([2, 2]);
}, 600_000);

it.runIf(dafny)("flags the registered weak-contract cases whose bodies it can change as weak contracts", async () => {
  const flagged: string[] = [];
  for (const [path, source] of Object.entries(registeredWeak)) {
    expect(await proveSource(path, source, AbortSignal.timeout(120_000)), path).toBe("passed");
    const mutation = await mutateOnly(path, source);
    const [contract] = contracts(path, source);
    const receipt = renderReceipt({ ...emptyReceipt,
      contracts: [{ path, name: contract?.name ?? "", lines: [], mutation }] });
    if (receipt.includes(`  weak contract ${contract?.name} in ${path}`)) flagged.push(path);
  }
  // maxQuantity's one mutant reads items[1], which its contract rules out; that its contract allows the first item is left to ClaimCheck.
  expect(flagged).toEqual(["clamp.ts", "discount.ts"]);
}, 900_000);
