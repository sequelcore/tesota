import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { renderReceipt } from "../src/receipt.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import { moneyStrong, moneyWeak, mutateOnly, strong, weak } from "./proof-mutation-fixtures.js";
import { emptyReceipt } from "./receipts.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

it.runIf(dafny)("measures mayMoveMoney as strong only when its contract rules out all three logical changes", async () => {
  for (const source of [moneyStrong, moneyWeak]) {
    expect(await proveSource("charge-policy.ts", source, AbortSignal.timeout(120_000))).toBe("passed");
  }
  const strong = await mutateOnly("charge-policy.ts", moneyStrong);
  expect(strong).toEqual({ rejected: 3, survived: [], inconclusive: 0, equivalent: 0 });
  const weak = await mutateOnly("charge-policy.ts", moneyWeak);
  expect(weak.rejected).toBe(2);
  expect(weak.inconclusive).toBe(0);
  expect(weak.equivalent).toBe(0);
  expect(weak.survived).toEqual([{ line: 3, operator: "logical", before: "!alreadyCharged", after: "alreadyCharged" }]);
  const receipt = (mutation: typeof strong): string => renderReceipt({ ...emptyReceipt,
      specificationEvidence: { ...emptyReceipt.specificationEvidence, contracts: [{ path: "charge-policy.ts", name: "mayMoveMoney", lines: [], mutation }] }
});
  expect(receipt(strong)).toContain("all 3 decided changes to its code fail the proof");
  expect(receipt(weak)).toContain("weak contract mayMoveMoney in charge-policy.ts");
}, 600_000);

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
