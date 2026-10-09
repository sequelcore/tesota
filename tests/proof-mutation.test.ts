import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { bodyEnd, contracts } from "../src/proof-guarantees.js";
import { mutateContract, mutants } from "../src/proof-mutation.js";
import { renderReceipt } from "../src/receipt.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import { emptyReceipt } from "./receipts.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

const body = "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
  "  if (value > high) return high;\n  return value;\n}\n";
const strong = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
  "//@ ensures low <= value && value <= high ==> \\result === value\n//@ ensures value > high ==> \\result === high\n" + body;
const weak = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" + body;

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

/** Mutation of the one contract in `source`, proved as file `path`. */
async function mutateOnly(path: string, source: string): ReturnType<typeof mutateContract> {
  const [contract] = contracts(path, source);
  if (contract === undefined) throw new Error(`no contract in ${path}`);
  return mutateContract(path, source, contract.endLine, bodyEnd(source, contract.endLine), AbortSignal.timeout(500_000));
}

it("swaps a branch's result, flips comparisons, moves numbers and swaps + and -, but never touches contracts or strings", () => {
  const source = "//@ ensures \\result >= 0\nexport function f(a: number): number {\n  //@ invariant a < 10\n" +
    "  const s = \"a < b\"; // 1 < 2\n  if (a < 3) return a + 1;\n  return a - 2;\n}\n";
  const found = mutants(source, 2, 7, 20);
  expect(found.map((mutant) => [mutant.line, mutant.operator, mutant.before, mutant.after])).toEqual([
    [5, "result", "a + 1", "a - 2"], [5, "comparison", "<", "<="], [5, "constant", "3", "4"], [5, "arithmetic", "+", "-"],
    [6, "result", "a - 2", "a + 1"], [5, "constant", "1", "2"], [6, "arithmetic", "-", "+"], [6, "constant", "2", "3"]]);
  expect(found[0]?.source).toContain("  if (a < 3) return a - 2;\n");
  expect(found.every((mutant) => mutant.source.includes("//@ invariant a < 10") && mutant.source.includes("\"a < b\""))).toBe(true);
  expect(mutants(source, 2, 7, 3)).toHaveLength(3);
  // An escaped quote in a string keeps the columns after it in place.
  const escaped = mutants("export function e(a: number): number {\n  const s = \"x\\\"y<\"; if (a < 3) return 0;\n  return 1;\n}\n", 1, 4)
    .find((mutant) => mutant.operator === "comparison");
  expect(escaped?.source).toContain("const s = \"x\\\"y<\"; if (a <= 3) return 0;");
  expect(mutants("export function g(): void {\n  const f = (x: number) => x;\n}\n", 1, 3)).toEqual([]);
});

it("calls a contract with surviving mutants weak in the receipt, and says a survivor may behave the same as the original", () => {
  const show = (mutation: { rejected: number; survived: { line: number; operator: "result"; before: string; after: string }[];
    inconclusive: number }): string => renderReceipt({ ...emptyReceipt, contracts: [{ path: "src/clamp.ts", name: "clamp", lines: ["//@ ensures \\result >= 0"], mutation }] });
  expect(show({ rejected: 3, survived: [], inconclusive: 0 }))
    .toContain("  contract      clamp in src/clamp.ts: all 3 decided changes to its code fail the proof");
  expect(show({ rejected: 2, survived: [{ line: 6, operator: "result", before: "low", after: "high" }], inconclusive: 1 }))
    .toContain("  weak contract clamp in src/clamp.ts: 1 of 4 changes to its code still prove, so the contract does not rule " +
      "them out (one may behave the same as the original); 1 could not be decided\n                line 6: low became high");
  expect(show({ rejected: 0, survived: [], inconclusive: 0 }))
    .toContain("  contract      clamp in src/clamp.ts: mutation found no change to try in its body");
});

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
  expect(weakResult.survived.length).toBe(5);
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
