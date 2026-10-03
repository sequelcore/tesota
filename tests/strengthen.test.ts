import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { AGENT_STRENGTHEN_CASES, withBuggyBody } from "../src/agent-evaluation.js";
import { correctionPrompt } from "../src/correction.js";
import type { Finding } from "../src/review.js";
import { proveSource } from "../src/verification/lemmascript-verifier.js";

const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;
const finding = (line: number): Finding => ({ severity: "high", disposition: "fixable", origin: "introduced", path: "src/clamp.ts",
  line, statement: "Values below low return high instead of low.", reason: "The request says they become low." });

it("asks to strengthen the contract only for a finding on a proved line, showing that contract", () => {
  const proved = [{ path: "src/clamp.ts", lines: [3, 4, 5], contracts: ["//@ ensures low <= \\result\nexport function clamp("] }];
  const round = { failedChecks: [], obligations: [], findings: [finding(4), finding(9)] };
  const prompt = correctionPrompt(["Add clamp"], round, proved);
  expect(prompt).toContain("- [high] src/clamp.ts:4: Values below low return high instead of low.\n" +
    "  Why: The request says they become low.\n  This line is proved, so its contract allowed this behavior:\n" +
    "    //@ ensures low <= \\result\n    export function clamp(\n  Fix the code, and strengthen that contract so its proof " +
    "rules this behavior out; keep it provable. Do not loosen anything else in it.\n- [high] src/clamp.ts:9:");
  expect(prompt.match(/This line is proved/gu)).toHaveLength(1);
  expect(correctionPrompt(["Add clamp"], round)).not.toContain("This line is proved");
});

it("puts the base's buggy body under the contract a turn left, and registers three bugs a proved contract allowed", () => {
  const base = "//@ ensures \\result >= 0\nexport function f(a: number): number {\n  return 1;\n}\n";
  const after = "//@ ensures \\result >= 0\n//@ ensures \\result === 0\nexport function f(a: number): number {\n  return 0;\n}\n";
  expect(withBuggyBody(base, after, "src/f.ts", "f"))
    .toBe("//@ ensures \\result >= 0\n//@ ensures \\result === 0\nexport function f(a: number): number {\n  return 1;\n}\n");
  expect(withBuggyBody(base, "export const x = 1;\n", "src/f.ts", "f")).toBeUndefined();
  expect(AGENT_STRENGTHEN_CASES.map((entry) => entry.name))
    .toEqual(["clamp below the minimum", "discount at exactly 100", "maximum returns the first item"]);
  const root = mkdtempSync(join(tmpdir(), "tesota-strengthen-"));
  try {
    for (const testCase of AGENT_STRENGTHEN_CASES) {
      const directory = join(root, testCase.name.replaceAll(" ", "-"));
      for (const [path, text] of Object.entries({ ...testCase.base, ".hidden/check.test.ts": testCase.hiddenTest,
        "package.json": "{\"type\":\"module\"}" })) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), text);
      }
      expect(spawnSync("node", ["--test", "src/**/*.test.ts"], { cwd: directory }).status, `${testCase.name} base tests`).toBe(0);
      expect(spawnSync("node", ["--test", ".hidden/check.test.ts"], { cwd: directory }).status, `${testCase.name} hidden`).toBe(1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(dafny)("proves each buggy base, since its contract allows the bug", async () => {
  for (const testCase of AGENT_STRENGTHEN_CASES) {
    const source = testCase.base[testCase.path] ?? "";
    const run = await proveSource(testCase.path.split("/").pop() ?? testCase.path, source, undefined, AbortSignal.timeout(120_000));
    expect(run.outcome, testCase.name).toBe("passed");
  }
}, 400_000);
