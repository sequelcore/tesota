import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { guaranteesDetail } from "../src/proof-guarantees.js";
import { mutants, mutateContracts } from "../src/proof-mutation.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";
import type { CheckResult } from "../src/workspace-checks.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

const body = "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
  "  if (value > high) return high;\n  return value;\n}\n";
const strong = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
  "//@ ensures low <= value && value <= high ==> \\result === value\n//@ ensures value > high ==> \\result === high\n" + body;
const weak = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" + body;

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

it("says what mutation found, and that a survivor may behave the same as the original", () => {
  const contract = { path: "src/clamp.ts", name: "clamp", lines: ["//@ ensures \\result >= 0"], outcome: "proved" as const,
    assumes: [], narrowed: [], compared: false };
  const show = (mutation: { rejected: number; survived: { line: number; operator: "result"; before: string; after: string }[];
    inconclusive: number }): string => guaranteesDetail({ contracts: [{ ...contract, mutation }], uncovered: [] }) ?? "";
  expect(show({ rejected: 3, survived: [], inconclusive: 0 })).toContain("    Mutation: all 3 decided changes to its code made the proof fail");
  expect(show({ rejected: 2, survived: [{ line: 6, operator: "result", before: "low", after: "high" }], inconclusive: 1 }))
    .toContain("    ! Mutation: 1 of 4 changes to its code still proved, so the contract does not rule them out " +
      "(one may behave the same as the original); 1 could not be decided:\n      line 6: low became high");
  expect(show({ rejected: 0, survived: [], inconclusive: 0 })).toContain("    Mutation: no change to try in its body");
});

it.runIf(dafny)("counts a run that verified nothing as not started, never as proved", async () => {
  // Each has a `//@` line Tesota counts, but nothing LemmaScript translates: Dafny verifies 0 items and exits 0.
  for (const source of ["//@ ensures \\result >= 0\nexport const x = 1;\n",
    "/*\n//@ ensures \\result >= 0\n*/\nexport function f(): number {\n  return 0;\n}\n"]) {
    const run = await proveSource("f.ts", source, undefined, AbortSignal.timeout(120_000));
    expect(run.outcome).toBe("not_started");
    expect(run.output).toContain("LemmaScript verified nothing in this file, so nothing was proved.");
  }
}, 300_000);

it.runIf(dafny)("rejects more mutants under a stronger contract, and tries only contracts the change touched and proved", async () => {
  const proved = (path: string): CheckResult => ({ verifier: "lemmascript", command: `lemmascript ${path}`, claim: "", limits: "",
    tree: "tree", environment: "host", guarantees: {} as never, outcome: "passed", exitCode: 0, durationMs: 1, output: "" });
  const files: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    base: { "src/strong.ts": body, "src/weak.ts": body, "src/same.ts": strong },
    tree: { "src/strong.ts": strong, "src/weak.ts": weak, "src/same.ts": strong },
  };
  const snapshot: WorkspaceSnapshot = { base: "base", tree: "tree", diff: "", changes: ["src/strong.ts", "src/weak.ts", "src/same.ts"]
    .map((path) => ({ status: "modified" as const, path })) };
  const results = await mutateContracts(snapshot, ["src/strong.ts", "src/weak.ts", "src/same.ts"].map(proved),
    (revision, path) => files[revision]?.[path], AbortSignal.timeout(500_000));
  const strongResult = results.get("src/strong.ts:clamp");
  const weakResult = results.get("src/weak.ts:clamp");
  expect(strongResult?.rejected).toBe(2);
  expect(strongResult?.survived.map((mutant) => [mutant.line, mutant.before, mutant.after])).toContainEqual([6, "low", "high"]);
  expect(weakResult?.rejected).toBe(0);
  expect(weakResult?.survived.length).toBe(5);
  expect(results.has("src/same.ts:clamp")).toBe(false);
}, 600_000);
