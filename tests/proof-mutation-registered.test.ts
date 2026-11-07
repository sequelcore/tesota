import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { contracts } from "../src/proof-guarantees.js";
import { renderReceipt } from "../src/receipt.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import { mutateOnly, registeredWeak, strong } from "./proof-mutation-fixtures.js";
import { emptyReceipt } from "./receipts.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

it.runIf(dafny)("counts a source alone that verified nothing as vacuous, never as proved", async () => {
  // Each has a `//@` line Tesota counts, but nothing LemmaScript translates: Dafny verifies 0 items and exits 0.
  for (const source of ["//@ ensures \\result >= 0\nexport const x = 1;\n",
    "/*\n//@ ensures \\result >= 0\n*/\nexport function f(): number {\n  return 0;\n}\n"]) {
    expect(await proveSource("f.ts", source, AbortSignal.timeout(120_000))).toBe("vacuous");
  }
  expect(await proveSource("clamp.ts", strong, AbortSignal.timeout(120_000))).toBe("passed");
}, 300_000);

it.runIf(dafny)("flags the registered weak-contract cases whose bodies it can change as weak contracts", async () => {
  const flagged: string[] = [];
  for (const [path, source] of Object.entries(registeredWeak)) {
    expect(await proveSource(path, source, AbortSignal.timeout(120_000)), path).toBe("passed");
    const mutation = await mutateOnly(path, source);
    const [contract] = (await contracts(path, source));
    const receipt = renderReceipt({ ...emptyReceipt,
        specificationEvidence: { ...emptyReceipt.specificationEvidence, contracts: [{ path, name: contract?.name ?? "", lines: [], mutation }] }
    });
    if (receipt.includes(`  weak contract ${contract?.name} in ${path}`)) flagged.push(path);
  }
  // maxQuantity's one mutant reads items[1], which its contract rules out; that its contract allows the first item is left to ClaimCheck.
  expect(flagged).toEqual(["clamp.ts", "discount.ts"]);
}, 900_000);
