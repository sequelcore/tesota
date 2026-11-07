import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { equivalenceSource } from "../src/proof-mutation.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import type { ProofOutcome } from "../src/verification/proof-outcome-rule.js";
import { arrowRequires, commentedRequires, expressionRequires, mutateOnly, only, recursive, weak } from "./proof-mutation-fixtures.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

it.runIf(dafny)("proves a mutant equivalent under a pure contract a comment separates, and in arrow functions", async () => {
  for (const [path, source, mutated] of [["f.ts", commentedRequires, commentedRequires.replace("return 0;", "return 1;")],
    ["h.ts", arrowRequires, arrowRequires.replace("return 0;", "return 1;")],
    ["g.ts", expressionRequires, expressionRequires.replace("? 0", "? 1")]] as const) {
    expect(await proveSource(path, mutated, AbortSignal.timeout(120_000)), path).toBe("passed");
    expect(await proveSource(path, equivalenceSource(source, (await only(source, path)), mutated) ?? "", AbortSignal.timeout(120_000)), path)
      .toBe("passed");
  }
}, 600_000);

it.runIf(dafny)("drops a planted mutant Dafny proves equivalent and keeps a planted one that is not", async () => {
  const proved = async (mutated: string): Promise<ProofOutcome> =>
    proveSource("clamp.ts", equivalenceSource(weak, (await only(weak)), mutated) ?? "", AbortSignal.timeout(300_000));
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
