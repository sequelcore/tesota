import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { proofGuarantees } from "../src/proof-guarantees.js";
import type { Finding } from "../src/review.js";
import { PROOF_REVIEW_CASES, defectDispositions } from "../src/review-evaluation.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";
import type { CheckResult } from "../src/workspace-checks.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;
const finding = (line: number, disposition: Finding["disposition"]): Finding => ({ severity: "high", disposition,
  origin: "introduced", path: "src/clamp.ts", line, statement: "Values below low return high.", reason: "The request says low." });

it("registers a defect the contract allows, one outside the proof and a correct change, each passing its own tests", () => {
  expect(PROOF_REVIEW_CASES.map((entry) => entry.defects.length)).toEqual([1, 1, 0]);
  const root = mkdtempSync(join(tmpdir(), "tesota-proof-review-"));
  try {
    for (const testCase of PROOF_REVIEW_CASES) {
      const directory = join(root, testCase.name.replaceAll(" ", "-"));
      for (const [path, text] of Object.entries({ ...testCase.base, ...testCase.candidate, "package.json": "{\"type\":\"module\"}" })) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), text);
      }
      expect(spawnSync("node", ["--test", "src/**/*.test.ts"], { cwd: directory }).status, testCase.name).toBe(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const [allowed] = PROOF_REVIEW_CASES;
  if (allowed === undefined) throw new Error("no case");
  expect(defectDispositions(allowed, [{ reviewer: "r", tree: "t", status: "completed", summary: "",
    findings: [finding(4, "fixable"), { ...finding(4, "operator"), statement: "Unrelated wording." , reason: "" }] }]))
    .toEqual(["fixable"]);
});

it.runIf(dafny)("proves each candidate, and covers the contract-allowed defect's line but not the helper's", async () => {
  const coverage: Record<string, string> = {};
  for (const testCase of PROOF_REVIEW_CASES) {
    const files = { ...testCase.base, ...testCase.candidate };
    const path = Object.keys(testCase.candidate).find((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")) ?? "";
    const source = files[path] ?? "";
    const proof = await proveSource(path.split("/").pop() ?? path, source, undefined, AbortSignal.timeout(120_000));
    expect(proof.outcome, testCase.name).toBe("passed");
    const lines = source.split("\n").map((_line, index) => ` ${index + 1}`).join("");
    const added = source.split("\n").slice(0, -1).map((line) => `+${line}`);
    const snapshot: WorkspaceSnapshot = { base: "b", tree: "t", changes: [{ status: "added", path }],
      diff: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${added.length} @@\n${added.join("\n")}\n` };
    const check = { verifier: "lemmascript", command: `lemmascript ${path}`, outcome: "passed" } as CheckResult;
    const covered = proofGuarantees(snapshot, [check], [], (revision, name) => revision === "t" && name === path ? source : undefined)
      .covered ?? [];
    coverage[testCase.name] = `${covered.flatMap((entry) => entry.lines).join(",")} of${lines}`;
  }
  // From the declaration to the closing brace: clamp's lines 3 to 7, with its new contract's own `requires` narrowing
  // nothing; shippingCost's lines 4 to 6, and not the unannotated helper after it.
  expect(coverage["defect the contract allows"]).toMatch(/^3,4,5,6,7 of/u);
  expect(coverage["defect outside the proof"]).toMatch(/^4,5,6 of/u);
}, 400_000);
