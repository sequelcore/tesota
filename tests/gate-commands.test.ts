import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { receiptFindings, type Receipt } from "../src/receipt.js";
import { changeOverFailingBase, commit, contract, entry, expectStaleReceipt, facts, gate, junit, newTestOverFailingBase, priceTest, repository, shape, testedProject, useGateHarness, write } from "./gate-harness.js";

vi.mock("../src/verification/lemmascript-verifier.js", async (original) =>
  (await import("./gate-harness.js")).lemmaScriptMock(original));
vi.mock("../src/model-check.js", async (original) =>
  (await import("./gate-harness.js")).modelCheckMock(original));

useGateHarness();

it("keeps the admitted test check when the change adds a check script (#727)", async () => {
  const root = repository({
    "package.json": JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "node verify.cjs" } }),
    "value.js": "1\n",
    "verify.cjs": "require('node:assert/strict').equal(require('node:fs').readFileSync('value.js', 'utf8').trim(), '2');\n",
  });
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(root, {
    "value.js": "3\n",
    "package.json": JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "node verify.cjs", check: "node -e \"process.exit(0)\"" } }),
  });
  const result = await run.settle();
  expect(result?.continue).toBe(true);
  expect(result?.entries?.some((item) => item.type === "custom_message" && item.content.includes("bun run test"))).toBe(true);
});

it.each([
  ["checked value 2 → 999", "writeFileSync('value.js', '999\\n');", "not_started"],
  ["second relevant input", "writeFileSync('input.json', '999\\n');", "not_started"],
  ["formatting-only edit", "writeFileSync('value.js', ' 2\\n');", "not_started"],
  ["generated output", "writeFileSync('generated.txt', 'output');", "passed"],
  ["unchanged content", "", "passed"],
])("binds the settled command evidence to content: %s (#617)", async (_name, mutation, outcome) => {
  const root = repository({
    "package.json": JSON.stringify({ packageManager: "bun@1.3.11", scripts: { check: "node check.cjs" } }),
    "value.js": "1\n", "input.json": "1\n", ".gitignore": "generated.txt\n",
    "check.cjs": "const {readFileSync, writeFileSync} = require('node:fs');\n" +
      "require('node:assert/strict').equal(Number(readFileSync('value.js', 'utf8')), 2);\n" +
      "require('node:assert/strict').equal(Number(readFileSync('input.json', 'utf8')), 2);\n" + mutation + "\nconsole.log('checked');\n",
  });
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(root, { "value.js": "2\n", "input.json": "2\n" });
  const settled = await run.settle();
  expect(settled?.continue).not.toBe(true);
  const receipt = entry(settled).details as Receipt;
  expect(receipt.codeEvidence.tests).toMatchObject([{ command: "bun run check", verdict: outcome === "passed" ? "proved" : "operator",
    evidence: { outcome, files: ["input.json", "value.js"] } }]);
  if (outcome === "not_started") {
    expect(receipt.codeEvidence.tests[0]?.evidence.output).toContain("stale");
    expectStaleReceipt(receipt, "tests", "Tests stale", "bun run check");
    expect(entry(settled).content).not.toContain("  passed        bun run check");
    expect(entry(settled).content).toContain("Evidence is stale: checked content changed before the receipt settled; current content was not checked.");
  }
  expect(run.progress.operations.operations().filter(({ method }) => method === "command")).toHaveLength(1);
});

it("does not credit source sensitivity when the candidate depends on inherited dirt (#669)", async () => {
  const root = repository({ "package.json": JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "bun test" } }),
    "a.ts": "export const a = 0;\n", "b.ts": "export const b = 0;\n" });
  write(root, { "b.ts": "export const b = 1;\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "a.ts": "export const a = 1;\n", "rule.test.ts":
    "import {expect,test} from 'bun:test'; import {a} from './a'; import {b} from './b'; test('either',()=>expect(a===1||b===1).toBe(true));\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.inherited).toEqual(["b.ts"]);
  expect(receipt.codeEvidence.exercises[0]?.sources).toEqual([]);
  expect(receipt.codeEvidence.exercises[0]?.sourceGaps).toEqual([{ path: "a.ts", reason: expect.stringContaining("started with changes") }]);
});

it("runs the project's checks with the session's environment, such as a writing subagent's branch guard (#619)", async () => {
  const root = repository({ "src/rule.ts": contract, "bun.lock": "", "package.json": JSON.stringify({ scripts: {
    check: "node -e \"require('node:fs').writeFileSync('.git/env-seen', process.env.TESOTA_GUARD_BRANCH ?? 'none')\"" } }) });
  const run = gate(root, undefined, { env: { TESOTA_GUARD_BRANCH: "refs/heads/tesota/child" } });
  await run.input();
  await run.tool("write");
  write(root, { "src/rule.ts": `${contract}// changed\n` });
  await run.settle();
  expect(readFileSync(join(root, ".git", "env-seen"), "utf8")).toBe("refs/heads/tesota/child");
});

it("discloses a check script narrowed after its failing test went back, even when the remaining tests pass", async () => {
  const root = repository({
    "package.json": JSON.stringify({ type: "module", scripts: { check: "node --test test/positive.test.mjs test/negative.test.mjs" } }),
    "bun.lock": "", "src/price.mjs": "export const total = (n) => n;\n",
    "test/positive.test.mjs": priceTest(1, 1, "positive"), "test/negative.test.mjs": priceTest(-1, -1, "negative"),
  });
  const run = gate(root);
  await run.input("interactive", undefined, "Keep totals unchanged, including negative values.");
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(0, n);\n" });
  expect((await run.settle())?.continue).toBe(true);
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { check: "node --test test/positive.test.mjs" } }) });
  const settled = entry(await run.settle());
  expect(settled.customType).toBe("tesota-receipt");
  expect((settled.details as Receipt).codeEvidence.tests).toMatchObject([{ evidence: { outcome: "not_started",
    output: expect.stringContaining("admitted package script") } }]);
  expect((settled.details as Receipt).specificationEvidence.weakened).toEqual([
    { path: "package.json", kind: "changed_check_script", script: "check" },
  ]);
  expect(settled.content).toContain("changes the command or selection of check script check");
  expect(receiptFindings(settled.details as Receipt)).toContainEqual({
    standing: "decide", check: "weakening", label: "May weaken the evidence", subject: "package.json",
    detail: "changes the command or selection of check script check", more: [],
    group: { title: "Review check script changes · %", noun: ["heuristic flag", "heuristic flags"],
      note: "May weaken evidence; not confirmed weakening.", item: "package.json: changes the command or selection of check script check" },
  });
  const excluded = spawnSync(process.execPath, ["--test", "test/negative.test.mjs"], { cwd: root, encoding: "utf8" });
  expect(excluded.status, excluded.stderr).toBe(1);
  expect(excluded.stdout).toContain("ERR_ASSERTION");
});

it("runs the project's tests and keeps exercise after the agent commits",  async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n",
    "test/negative.test.mjs": priceTest(-1, 0), "test/positive.test.mjs": priceTest(2, 2),
    "test/__snapshots__/price.test.mjs.snap": "exports[`total 1`] = `1`;\n", "test/fixtures/prices.json": "[1, 2]\n" });
  commit(root, "the agent's change");
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  const changed = ["src/price.mjs", "test/__snapshots__/price.test.mjs.snap", "test/fixtures/prices.json", "test/negative.test.mjs",
    "test/positive.test.mjs"];
  // The snapshot and the fixture are no tests a runner runs alone, so they get no line of their own on the base.
  expect(facts(entry(settled).content)).toBe([
    "  passed        bun run test",
    "  notices change test/negative.test.mjs: fails on the base, passes with the change; by the whole check, `bun run test`; added in this request",
    "  passes on base test/positive.test.mjs: it passes without the change too; by the whole check, `bun run test`; added in this request",
    "  not proved    src/price.mjs: no proof covers it; the project's commands pass with it",
    "  changed lines implementation +1 -1 · tests +10 -0"].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect(receipt.codeEvidence.tests.map(({ command, evidence }) => [command, evidence.verifier, evidence.files]))
    .toEqual([["bun run test", "command", changed]]);
  expect(receipt.codeEvidence.exercises.map(({ path, sensitivity }) => [path, sensitivity])).toEqual([
    ["test/negative.test.mjs", "fails_then_passes"], ["test/positive.test.mjs", "passes_on_base"]]);
  // No exercise worktree remains; checkout dependencies are untouched.
  expect(spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.match(/^worktree /gmu))
    .toHaveLength(1);
  expect(existsSync(join(root, "node_modules", "dep", "index.js"))).toBe(true);
}, 60_000);

it("neither flags nor lists as not proved a test file that only gains a test", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  const base = readFileSync(join(root, "test", "price.test.mjs"), "utf8");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n",
    "test/price.test.mjs": `${base}test("negative", () => { assert.equal(total(-1), 0); });\n` });
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe([
    "  passed        bun run test",
    "  notices change test/price.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; changed in this request",
    "  not proved    src/price.mjs: no proof covers it; the project's commands pass with it",
    "  changed lines implementation +1 -1 · tests +1 -0"].join("\n"));
  const receipt = settled.details as Receipt;
  expect(receipt.specificationEvidence.weakened).toEqual([]);
  expect(receipt.codeEvidence.unverified).toEqual(["src/price.mjs"]);
}, 60_000);

it("sends failing tests back once when the project writes no test report, then settles with the failure", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/negative.test.mjs": priceTest(-1, 0) });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: `bun run test` fails with your changes.");
  expect(entry(failed).details).toMatchObject({ round: "tests", commands: [{ command: "bun run test", evidence: { outcome: "failed" } }] });
  run.agentStart();
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(facts(entry(stuck).content)).toBe([
    "  NOT passed    bun run test: it still fails after its failure went back",
    "  changed lines tests +4 -0"].join("\n"));
  await run.input();
  await run.tool("write");
  write(root, { "test/negative.test.mjs": priceTest(-2, 0) });
  expect((await run.settle())?.continue).toBe(true);
}, 60_000);

it("sends failing tests back until the set that fails repeats one already sent, read from the test report", async () => {
  const root = testedProject("node --test --test-reporter=junit --test-reporter-destination=report.xml");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/a.test.mjs": priceTest(-1, 0, "a") });
  const first = await run.settle();
  expect(first?.continue).toBe(true);
  expect(entry(first).content).toContain("These tests fail:\n  test > a\n");
  run.agentStart();
  write(root, { "test/b.test.mjs": priceTest(-2, 0, "b") });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  rmSync(join(root, "test", "b.test.mjs"));
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toContain(
    "  NOT passed    bun run test: these tests fail, as they did when they went back: test > a");
  expect((entry(stuck).details as Receipt).codeEvidence.tests.map(({ failingTests }) => failingTests)).toEqual([["test > a"]]);
}, 60_000);

it("counts a new test as exercising the change when its tests newly fail on a base that fails anyway", async () => {
  const settled = await newTestOverFailingBase("node --test --test-reporter=junit --test-reporter-destination=report.xml");
  expect(facts(entry(settled).content)).toContain("  notices change test/discount.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; added in this request");
}, 60_000);

it("says a test report would tell, when the base fails with and without a new test and writes none", async () => {
  const settled = await newTestOverFailingBase("node --test");
  expect(facts(entry(settled).content)).toContain("  not checked   test/discount.test.mjs: on the base it failed, but so does the " +
    "base without it, and no test report says which tests fail; by the whole check, `bun run test`; " +
    "added in this request");
}, 60_000);

it("keeps a failure the base already had from the agent, when the test reports show the same tests failing there", async () => {
  const { settled } = await changeOverFailingBase(junit, { "test/two.test.mjs": priceTest(2, 2, "two") });
  expect(settled?.continue).toBeUndefined();
  expect(facts(entry(settled).content)).toContain("  failed before bun run test: these tests fail on the base too: test > legacy");
  const [run] = (entry(settled).details as Receipt).codeEvidence.tests;
  expect(run).toMatchObject({ verdict: "operator", origin: { cause: "preexisting" } });
}, 60_000);

it("sends back a failure the change adds to a base that fails anyway", async () => {
  const { settled } = await changeOverFailingBase(junit, { "test/two.test.mjs": priceTest(-2, 0, "two") });
  expect(settled?.continue).toBe(true);
  expect(entry(settled).content).toContain("These tests fail:\n  test > legacy\n  test > two\n");
  expect(entry(settled).details).toMatchObject({ round: "tests",
    commands: [{ origin: { cause: "introduced", reason: "these tests fail only with the change: test > two" } }] });
}, 60_000);

it("never counts a failure as the base's when no test report shows which tests fail, and says why", async () => {
  const { run, settled } = await changeOverFailingBase("node --test", { "test/two.test.mjs": priceTest(2, 2, "two") });
  expect(settled?.continue).toBe(true);
  expect(entry(settled).content).toContain("Tesota can't tell whether your changes cause it: " +
    "it fails on the base too, and no test report says which tests fail.");
  run.agentStart();
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(facts(entry(stuck).content)).toContain("  NOT passed    bun run test: it still fails after its failure went back; " +
    "it fails on the base too, and no test report says which tests fail");
  expect((entry(stuck).details as Receipt).codeEvidence.tests[0]?.origin?.cause).toBe("unknown");
}, 60_000);

it("gives no verdict on the base when the change touches what decides the dependencies", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" }, description: "changed" }),
    "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  expect(facts(entry(await run.settle()).content)).toContain("  not checked   test/negative.test.mjs: the change touches " +
    "package.json, and the base runs with the checkout's dependencies, so a run there may not be faithful; added in this request");
}, 60_000);

it("publishes the test rung's commands, each test on the base and its base control, with the exact command (#590)", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  await run.settle();
  expect(shape(run)).toEqual([["command", "bun run test", "ended", "passed"], ["base_command", "bun run test", "ended", "passed"], ["exercise", "bun run test", "ended", "failed"],
    ["base_control", "bun run test", "ended", "passed"], ["command", "bun run test", "ended", "passed"], ["receipt", "receipt", "ended", "done"]]);
  const [, , exercise, control] = run.progress.operations.operations();
  expect(control?.parent).toBe(exercise?.id);
  for (const { startedAt, endedAt, durationMs } of run.progress.operations.operations()) {
    expect(endedAt).toBeGreaterThanOrEqual(startedAt ?? Infinity);
    expect(durationMs).toBe((endedAt ?? 0) - (startedAt ?? 0));
  }
}, 60_000);
it("shows a command that prints nothing with its exact command and growing time, and a stop marks the rest as not started (#590)", async () => {
  const root = repository({ "package.json": JSON.stringify({ scripts: { typecheck: "node -e \"setTimeout(function(){}, 60000)\"",
    lint: "node -e 0", test: "node -e 0" } }), "bun.lock": "", "src/a.mjs": "export const a = 1;\n" });
  const controller = new AbortController();
  const run = gate(root, undefined, { signal: controller.signal });
  await run.input();
  await run.tool("write");
  write(root, { "src/a.mjs": "export const a = 2;\n" });
  const settling = run.settle();
  const ops = run.progress.operations;
  await vi.waitFor(() => expect(ops.line(performance.now())).toMatch(/^Running project check · bun run typecheck · 0:01$/u),
    { timeout: 20_000, interval: 50 });
  expect(ops.line(performance.now())).not.toMatch(/%|remaining|estimat/iu);
  expect(ops.operations().filter(({ state }) => state === "planned").map(({ target }) => target)).toEqual(["bun run lint", "bun run test"]);
  controller.abort();
  expect(entry(await settling).details).toMatchObject({ stopped: "the operator stopped the run while Tesota verified it; "
    + "interrupted: project check bun run typecheck; not started: project check bun run lint, project check bun run test; "
    + "no later check ran", changed: [{ path: "src/a.mjs", blob: expect.any(String) }] });
  expect(shape(run)).toEqual([["command", "bun run typecheck", "ended", "cancelled"], ["command", "bun run lint", "ended", "not_started"],
    ["command", "bun run test", "ended", "not_started"]]);
  expect(ops.operations().slice(1).map(({ startedAt }) => startedAt)).toEqual([undefined, undefined]);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "stopped" }]);
  expect(ops.line(performance.now())).toBeUndefined();
}, 60_000);
