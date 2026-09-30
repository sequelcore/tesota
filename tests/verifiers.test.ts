import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { annotations, runLemmaScriptVerifier } from "../src/verification/lemmascript-verifier.js";
import { introducedDiagnostics, oxlintVerdict, runOxlintVerifier } from "../src/verification/oxlint-verifier.js";
import type { LintDiagnostic, OxlintResult } from "../src/verification/oxlint-result.js";
import type { WorkspaceSnapshot } from "../src/workspace.js";

// Tesota runs Oxlint under its own Bun; the tests run under Node.
const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], { encoding: "utf8", windowsHide: true }).trim();

const unused = (line: number): LintDiagnostic => ({ rule: "eslint(no-unused-vars)", message: "'x' is declared but never used.", line, column: 7 });
const anyType: LintDiagnostic = { rule: "typescript-eslint(no-explicit-any)", message: "Unexpected any.", line: 4, column: 12 };
function linted(diagnostics: readonly LintDiagnostic[]): OxlintResult {
  return { status: diagnostics.length === 0 ? "passed" : "check_failed", file: "a.ts", profile: "oxlint-static/v3",
    diagnostics, process: "exited", binding: {} as never };
}
const suppressed: OxlintResult = { status: "execution_failed", reason: "inline_suppression", process: "not_started" };

it("counts only diagnostics the change introduced, even when earlier ones moved", () => {
  expect(introducedDiagnostics([unused(9), anyType, unused(12)], [unused(2)])).toEqual([anyType, unused(12)]);
  expect(oxlintVerdict(linted([unused(9)]), linted([unused(2)])))
    .toEqual({ outcome: "passed", output: "1 diagnostic existed before this change and do not count." });
  expect(oxlintVerdict(linted([anyType]), undefined))
    .toEqual({ outcome: "failed", output: "4:12 typescript-eslint(no-explicit-any): Unexpected any." });
});

it("fails a change that adds a lint suppression, and cannot judge a file that already had one", () => {
  expect(oxlintVerdict(suppressed, linted([]))).toMatchObject({ outcome: "failed" });
  expect(oxlintVerdict(suppressed, undefined)).toMatchObject({ outcome: "failed" });
  expect(oxlintVerdict(suppressed, suppressed)).toMatchObject({ outcome: "not_started" });
  expect(oxlintVerdict({ status: "execution_failed", reason: "unsupported_input", process: "not_started" }, undefined))
    .toEqual({ outcome: "not_started", output: "Oxlint did not run: unsupported_input" });
});

function snapshot(changes: WorkspaceSnapshot["changes"]): WorkspaceSnapshot {
  return { base: "b".repeat(40), tree: "t".repeat(40), changes, diff: "" };
}

it("lints the candidate's added and modified files from the frozen tree with the real profile", async () => {
  const files: Record<string, string> = {
    [`${"b".repeat(40)}:src/old.ts`]: "export function f(): number {\n  const x = 1;\n  return 2;\n}\n",
    [`${"t".repeat(40)}:src/old.ts`]: "export function f(): number {\n  const x = 1;\n  return 2;\n}\nexport const g = (v: any) => v;\n",
    [`${"t".repeat(40)}:src/new.js`]: "export const h = 1;\n",
    [`${"t".repeat(40)}:README.md`]: "# notes\n",
  };
  const results = await runOxlintVerifier(snapshot([{ status: "modified", path: "src/old.ts" },
    { status: "added", path: "src/new.js" }, { status: "modified", path: "README.md" }, { status: "deleted", path: "src/gone.ts" }]),
  (revision, path) => files[`${revision}:${path}`], bun);
  expect(results.map((result) => [result.command, result.outcome])).toEqual([
    ["oxlint src/old.ts", "failed"], ["oxlint src/new.js", "passed"]]);
  expect(results[0]?.output).toContain("no-explicit-any");
  expect(results[0]?.output).toContain("1 diagnostic existed before this change");
  expect(results[0]?.claim).toBe("Tesota's Oxlint profile (oxlint-static/v3) finds nothing in src/old.ts that its base version did not have");
}, 60_000);

it("reads the properties a LemmaScript file claims, and skips files without annotations", async () => {
  expect(annotations("//@ ensures \\result >= 0\nexport function f(): number {\n  //@ invariant i >= 0\n  return 1;\n}")).toEqual(
    ["//@ ensures \\result >= 0", "//@ invariant i >= 0"]);
  const results = await runLemmaScriptVerifier(snapshot([{ status: "modified", path: "src/plain.ts" }]),
    () => "export const x = 1;\n", new AbortController().signal);
  expect(results).toEqual([]);
});
