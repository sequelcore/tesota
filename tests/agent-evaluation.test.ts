import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { AGENT_FIX_CASES, AGENT_QUESTIONS, QUESTION_REPOSITORY, allowedCommand, factsStated, productionChanges, quantile,
  wordCount } from "../src/agent-evaluation.js";

it("registers one already fixed, one partly fixed and one unfixed request, and fifteen questions", () => {
  expect(AGENT_FIX_CASES.map((entry) => entry.kind)).toEqual(["already fixed", "partly fixed", "unfixed"]);
  expect(AGENT_QUESTIONS).toHaveLength(15);
  expect(AGENT_QUESTIONS.every((entry) => entry.facts.length > 0)).toBe(true);
});

it("counts words, stated facts and production changes, and takes quantiles by nearest rank", () => {
  expect(wordCount("  It returns\n0 for   negatives. ")).toBe(5);
  expect(factsStated([["10%", "0.9"], ["100"]], "A 10% discount above $100.")).toBe(2);
  expect(factsStated([["orders.js"]], "In src/format.js")).toBe(0);
  expect(productionChanges(["src/leap.js", "src/leap.test.js", "README.md", "src/util.mjs"])).toEqual(["src/leap.js", "src/util.mjs"]);
  expect(quantile([30, 10, 20, 40], 0.5)).toBe(20);
  expect(quantile([30, 10, 20, 40], 0.9)).toBe(40);
  expect(quantile([], 0.5)).toBeUndefined();
});

it("lets the agent run only Node's test runner", () => {
  expect(allowedCommand("node --test")).toBe(true);
  expect(allowedCommand("node --test src/leap.test.js")).toBe(true);
  expect(allowedCommand("node --test \"src/**/*.test.js\"")).toBe(true);
  expect(allowedCommand("node --test src/a.test.js; rm -rf /")).toBe(false);
  expect(allowedCommand("node -e \"process.exit(0)\"")).toBe(false);
  expect(allowedCommand("npm test")).toBe(false);
  expect(allowedCommand("node --test $(whoami)")).toBe(false);
});

function run(directory: string, args: string[]): number | null {
  return spawnSync("node", args, { cwd: directory, encoding: "utf8" }).status;
}

function write(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries({ ...files, "package.json": JSON.stringify({ type: "module" }) })) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
}

// The hidden test must separate the outcomes: it passes on an already fixed base and fails where work remains.
it("keeps each base passing its own tests, and its hidden test passing only where nothing remains to do", () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-agent-cases-"));
  try {
    for (const testCase of AGENT_FIX_CASES) {
      const directory = join(root, testCase.name.replaceAll(" ", "-"));
      write(directory, { ...testCase.base, ".hidden/check.test.js": testCase.hiddenTest });
      expect(run(directory, ["--test", "src/**/*.test.js"]), `${testCase.name} base tests`).toBe(0);
      expect(run(directory, ["--test", ".hidden/check.test.js"]), `${testCase.name} hidden test`)
        .toBe(testCase.kind === "already fixed" ? 0 : 1);
    }
    const shop = join(root, "shop");
    write(shop, QUESTION_REPOSITORY);
    expect(run(shop, ["--test", "src/**/*.test.js"])).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
