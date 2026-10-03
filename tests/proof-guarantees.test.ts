import { expect, it } from "vitest";
import { bodyEnd, guaranteesDetail, lineRanges, proofGuarantees } from "../src/proof-guarantees.js";
import type { ReviewReport } from "../src/review.js";
import { proofCovered } from "../src/verification/proof-cover-rule.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";
import type { CheckResult } from "../src/workspace-checks.js";

const before = [
  "//@ ensures \\result >= 0",
  "export function clamp(value: number): number {",
  "  if (value < 0) return 1;",
  "  return value;",
  "}",
  "",
  "export function helper(value: number): number {",
  "  return value;",
  "}",
  "",
  "//@ ensures \\result >= 0",
  "export function total(amount: number): number {",
  "  return amount < 0 ? 1 : amount;",
  "}",
  "",
].join("\n");
// The candidate fixes clamp (line 3), changes the unannotated helper (line 8), and fixes total while adding a precondition.
const after = before.replace("return 1;", "return 0;").replace("  return value;\n}\n\n//@", "  return value + 0;\n}\n\n//@")
  .replace("//@ ensures \\result >= 0\nexport function total", "//@ requires amount >= 0\n//@ ensures \\result >= 0\nexport function total")
  .replace("? 1 : amount", "? 0 : amount");
const diff = ["diff --git a/src/rules.ts b/src/rules.ts", "--- a/src/rules.ts", "+++ b/src/rules.ts",
  "@@ -1,15 +1,16 @@", " //@ ensures \\result >= 0", " export function clamp(value: number): number {",
  "-  if (value < 0) return 1;", "+  if (value < 0) return 0;", "   return value;", " }", " ",
  " export function helper(value: number): number {", "-  return value;", "+  return value + 0;", " }", " ",
  "+//@ requires amount >= 0", " //@ ensures \\result >= 0", " export function total(amount: number): number {",
  "-  return amount < 0 ? 1 : amount;", "+  return amount < 0 ? 0 : amount;", " }", " "].join("\n");
const snapshot: WorkspaceSnapshot = { base: "base", tree: "tree", diff, changes: [{ status: "modified", path: "src/rules.ts" }] };
const read = (revision: string, path: string): string | undefined =>
  path === "src/rules.ts" ? revision === "tree" ? after : before : undefined;
const check = (outcome: CheckResult["outcome"]): CheckResult => ({ verifier: "lemmascript", command: "lemmascript src/rules.ts",
  claim: "", limits: "", tree: "tree", environment: "host", guarantees: { filesystem: "host", network: "host" } as never, outcome,
  exitCode: outcome === "passed" ? 0 : 1, durationMs: 1, output: "" });

it("covers a line only inside a proved function whose contract gained no assumption", () => {
  expect(proofCovered(3, [2, 7], [5, 9], [true, true], [false, false])).toBe(true);
  expect(proofCovered(6, [2, 7], [5, 9], [true, true], [false, false])).toBe(false);
  expect(proofCovered(3, [2], [5], [false], [false])).toBe(false);
  expect(proofCovered(3, [2], [5], [true], [true])).toBe(false);
  expect(proofCovered(3, [], [], [], [])).toBe(false);
});

it("finds where a function's body closes, past braces inside strings and comments", () => {
  const source = "export function f(a: string): number {\n  const s = \"}\"; // }\n  if (a) {\n    return 1;\n  }\n  return 0;\n}\nconst x = 1;\n";
  expect(bodyEnd(source, 1)).toBe(7);
  expect(bodyEnd("export function g(): void;\n", 1)).toBe(1);
  expect(lineRanges([3, 5, 6, 7, 12])).toBe("3, 5-7, 12");
  expect(lineRanges([])).toBe("");
});

it("leaves to review the changed lines no proof covers: unannotated code, and a contract the change narrowed", () => {
  const guarantees = proofGuarantees(snapshot, [check("passed")], [], read);
  expect(guarantees.contracts.map((entry) => [entry.name, entry.outcome, entry.narrowed])).toEqual([
    ["clamp", "proved", []], ["total", "proved", ["//@ requires amount >= 0"]]]);
  expect(guarantees.contracts[1]?.assumes).toEqual(["//@ requires amount >= 0"]);
  // Line 3 is in proved clamp; line 8 is in helper, which has no contract; lines 11 and 14 belong to the narrowed total.
  expect(guarantees.uncovered).toEqual([{ path: "src/rules.ts", lines: [8, 11, 14] }]);
  const failed = proofGuarantees(snapshot, [check("failed")], [], read);
  expect(failed.contracts.every((entry) => entry.outcome === "not proved")).toBe(true);
  expect(failed.uncovered).toEqual([{ path: "src/rules.ts", lines: [3, 8, 11, 14] }]);
  expect(proofGuarantees(snapshot, [], [], read).contracts.every((entry) => entry.outcome === "not run")).toBe(true);
});

it("shows each contract as written, what it takes as given, ClaimCheck's view of it and what no proof covers", () => {
  const claimcheck: ReviewReport = { reviewer: "ClaimCheck method", tree: "tree", status: "completed", summary: "",
    findings: [{ severity: "high", disposition: "operator", origin: "introduced", path: "src/rules.ts", line: 11,
      statement: "The proved contract of total says less than was asked.", reason: "It excludes negative amounts." }] };
  const detail = guaranteesDetail(proofGuarantees(snapshot, [check("passed")], [claimcheck], read)) ?? "";
  expect(detail).toContain("Guarantees\n  ✓ proved clamp in src/rules.ts\n    //@ ensures \\result >= 0\n" +
    "    ClaimCheck found it expresses what was asked (a model's comparison, not a proof)");
  expect(detail).toContain("    Takes as given: requires amount >= 0\n" +
    "    ! This change added: //@ requires amount >= 0, which narrows what was proved\n" +
    "    ! ClaimCheck: The proved contract of total says less than was asked. It excludes negative amounts.");
  expect(detail).toContain("  Not covered by a proof, so left to review:\n  src/rules.ts: lines 8, 11, 14");
  expect(guaranteesDetail(proofGuarantees(snapshot, [check("passed")], [], read))).toContain("ClaimCheck did not compare it");
  expect(guaranteesDetail({ contracts: [], uncovered: [] })).toBeUndefined();
});
