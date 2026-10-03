import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { reviewMessage } from "../src/integrations/pi-reviewer.js";
import { proofGuarantees, routeProvedFindings } from "../src/proof-guarantees.js";
import type { Finding, ReviewInput, ReviewReport } from "../src/review.js";
import { PROOF_REVIEW_CASES, defectDispositions } from "../src/review-evaluation.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";
import type { CheckResult } from "../src/workspace-checks.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;
const finding = (line: number, disposition: Finding["disposition"]): Finding => ({ severity: "high", disposition,
  origin: "introduced", path: "src/clamp.ts", line, statement: "Values below low return high.", reason: "The request says low." });

it("sends a fixable finding on a proved line to the operator as a contract question, and leaves every other finding", () => {
  const report: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "",
    findings: [finding(4, "fixable"), finding(9, "fixable"), finding(5, "operator")] };
  const [routed] = routeProvedFindings([report], [{ path: "src/clamp.ts", lines: [4, 5], contracts: ["//@ ensures \\result >= 0"] }]);
  const findings = routed?.status === "completed" ? routed.findings : [];
  expect(findings.map((entry) => entry.disposition)).toEqual(["operator", "fixable", "operator"]);
  expect(findings[0]?.statement).toBe("The proved contract allows this: Values below low return high.");
  expect(findings[0]?.reason).toContain("which is yours to decide");
  expect(findings[2]?.statement).toBe("Values below low return high.");
  const incomplete: ReviewReport = { reviewer: "Tesota reviewer", tree: "t", status: "incomplete", reason: "stopped" };
  expect(routeProvedFindings([incomplete], [])).toEqual([incomplete]);
});

it("tells the reviewer which lines a proof covers only when the step is on", () => {
  const snapshot: WorkspaceSnapshot = { base: "b", tree: "t", diff: "", changes: [{ status: "added", path: "src/clamp.ts" }] };
  const input: ReviewInput = { checkout: ".", requests: ["Add clamp"], snapshot, checks: [], flags: [] };
  expect(reviewMessage(input)).not.toContain("proved by LemmaScript");
  const message = reviewMessage({ ...input,
    proofCoverage: [{ path: "src/clamp.ts", lines: [4, 5], contracts: ["//@ ensures \\result >= 0\nexport function clamp("] }] });
  expect(message).toContain("Changed lines proved by LemmaScript with Dafny against these contracts, for every input they admit:\n" +
    "- src/clamp.ts, lines 4, 5:\n    //@ ensures \\result >= 0\n    export function clamp(");
  expect(message).toContain("Do not check whether these lines meet these contracts: the proof did.");
});

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
