import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Evidence } from "../src/evidence.js";
import { changedFiles, headCommit, registerGate } from "../src/gate.js";
import type { Receipt } from "../src/receipt.js";
import { gateVerdict, keepsWorking } from "../src/verification/gate-rule.js";
import type { ProofOutcome } from "../src/verification/proof-outcome-rule.js";

/** The proofs the gate runs, scripted per file: the gate's decisions, not LemmaScript, are under test here. */
const scripted = new Map<string, { outcome: ProofOutcome; output: string }>();
vi.mock("../src/verification/lemmascript-verifier.js", async (original) => ({
  ...await original<typeof import("../src/verification/lemmascript-verifier.js")>(),
  proveFile: (_root: string, path: string): Promise<Evidence> => {
    const { outcome, output } = scripted.get(path) ?? { outcome: "passed", output: "1 verified, 0 errors" };
    return Promise.resolve({ verifier: "lemmascript", claim: `claim of ${path}`, limits: "", outcome, output, durationMs: 1,
      files: [path, path.replace(/\.ts$/u, ".dfy")], contentHash: `hash of ${path}` });
  },
}));

const roots: string[] = [];
beforeEach(() => { scripted.clear(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): void {
  expect(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status).toBe(0);
}

const contract = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
}

/** A repository with these files committed. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  write(root, files);
  git(root, "init", "-q");
  commit(root, "base");
  return root;
}

/** A repository with one committed contract file, `src/rule.ts`, and a committed plain file. */
function project(): string {
  return repository({ "src/rule.ts": contract, "notes.md": "# Notes\n" });
}

/**
 * A package whose `test` script runs Node's test runner, with a dependency
 * that only the checkout's ignored `node_modules` holds, as installed ones are.
 */
function testedProject(test = "node --test"): string {
  const root = repository({
    "package.json": JSON.stringify({ type: "module", scripts: { test } }), "bun.lock": "",
    ".gitignore": "node_modules\nreport.xml\n", "src/price.mjs": "export const total = (n) => n;\n",
    "test/price.test.mjs": "import assert from \"node:assert\";\nimport { test } from \"node:test\";\nimport { one } from \"dep\";\n" +
      "import { total } from \"../src/price.mjs\";\ntest(\"one\", () => { assert.equal(total(1), one); });\n",
  });
  write(root, { "node_modules/dep/package.json": JSON.stringify({ name: "dep", type: "module", main: "index.js" }),
    "node_modules/dep/index.js": "export const one = 1;\n" });
  return root;
}

/** A Node test file with one test, `name`, asserting `total(input) === expected`. */
function priceTest(input: number, expected: number, name = "total"): string {
  return "import assert from \"node:assert\";\nimport { test } from \"node:test\";\nimport { total } from \"../src/price.mjs\";\n" +
    `test(${JSON.stringify(name)}, () => { assert.equal(total(${input}), ${expected}); });\n`;
}

interface Settled { entries?: { customType: string; content: string; details?: unknown }[]; continue?: boolean }

/** The gate's handlers on a fake Pi, run as Pi runs them in `root`. */
function gate(root: string, active = ["read", "edit", "prove"]): {
  input: (source?: string, streamingBehavior?: string) => Promise<void>; agentStart: () => void; tool: (name: string) => void;
  settle: (outcome?: string) => Promise<Settled | undefined>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  registerGate({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    getActiveTools: () => active } as never);
  const ctx = { cwd: root, signal: undefined };
  return {
    input: async (source = "interactive", streamingBehavior) => {
      await handlers.get("input")?.({ type: "input", text: "fix it", source, streamingBehavior }, ctx);
    },
    agentStart: () => { handlers.get("agent_start")?.({ type: "agent_start" }, ctx); },
    tool: (toolName) => { handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolName }, ctx); },
    settle: async (outcome = "completed") =>
      await handlers.get("agent_before_settle")?.({ type: "agent_before_settle", outcome }, ctx) as Settled | undefined,
  };
}

/** The one entry a settle appended. */
function entry(settled: Settled | undefined): { customType: string; content: string; details?: unknown } {
  expect(settled?.entries).toHaveLength(1);
  return (settled?.entries ?? [])[0] ?? { customType: "", content: "" };
}

it("sends a failed or vacuous proof back, and lets the operator resolve one that could not run", () => {
  expect(gateVerdict("passed", "", [])).toBe("proved");
  expect(gateVerdict("failed", "A", [])).toBe("send_back");
  expect(gateVerdict("vacuous", "B", ["A"])).toBe("send_back");
  expect(gateVerdict("failed", "A", ["A", "B"])).toBe("no_progress");
  expect(gateVerdict("not_started", "A", [])).toBe("operator");
  expect(gateVerdict("timed_out", "A", ["A"])).toBe("operator");
  expect(keepsWorking(["proved", "operator", "no_progress"])).toBe(false);
  expect(keepsWorking(["proved", "send_back"])).toBe(true);
});

it("lists changed and untracked files, relative to the project, and nothing outside Git", async () => {
  const root = project();
  const base = await headCommit(root);
  expect(await changedFiles(root, base)).toEqual([]);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "src", "new.ts"), "export const a = 1;\n");
  rmSync(join(root, "notes.md"));
  expect(await changedFiles(root, base)).toEqual(["src/new.ts", "src/rule.ts"]);
  expect(await changedFiles(join(root, "src"), base)).toEqual(["new.ts", "rule.ts"]);
  const outside = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(outside);
  expect(await headCommit(outside)).toBeNull();
  expect(await changedFiles(outside, null)).toBeUndefined();
});

it("keeps the agent working while a changed contract fails, and settles with a receipt once it proves", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  expect(await run.settle()).toBeUndefined();
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  writeFileSync(join(root, "src", "rule.dfy.gen"), "// regenerated\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: src/rule.ts does not prove yet.");
  expect(entry(failed).content).toContain("This is not finished yet.");
  expect(entry(failed).content).toContain("and run prove again.");
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect((await run.settle())?.continue).toBe(true);
  scripted.delete("src/rule.ts");
  const proved = await run.settle();
  expect(proved?.continue).toBeUndefined();
  expect(entry(proved).customType).toBe("tesota-receipt");
  expect(entry(proved).content).toBe(["Tesota receipt", "  proved        src/rule.ts",
    "                content sha256 hash of src/rule.ts", "  not verified  notes.md: no verifier covers it"].join("\n"));
  const receipt = entry(proved).details as Receipt;
  expect(receipt.proofs.map(({ path, verdict, evidence }) => [path, verdict, evidence.contentHash]))
    .toEqual([["src/rule.ts", "proved", "hash of src/rule.ts"]]);
});

it("stops on any failure already sent back, alternating ones included, and forgets them on the operator's input only", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "A" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  scripted.set("src/rule.ts", { outcome: "failed", output: "B" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  scripted.set("src/rule.ts", { outcome: "failed", output: "A" });
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toContain(
    "NOT proved    src/rule.ts: an obligation fails, repeating a failure already sent back");
  expect((entry(stuck).details as Receipt).proofs.map(({ verdict }) => verdict)).toEqual(["no_progress"]);
  await run.input("extension");
  expect((await run.settle())?.continue).toBeUndefined();
  await run.input();
  expect((await run.settle())?.continue).toBe(true);
});

it("reports a proof that could not run to the operator instead of sending it back", async () => {
  const root = project();
  const run = gate(root);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "not_started", output: "Dafny is not installed, so nothing was proved." });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).content).toContain(
    "NOT proved    src/rule.ts: the proof could not run: Dafny is not installed, so nothing was proved.");
});

it("tells the agent to finish its turn instead of running prove when prove is not active", async () => {
  const root = project();
  const run = gate(root, ["read", "edit"]);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = entry(await run.settle()).content;
  expect(failed).toContain("and finish your turn, and Tesota will prove the file again.");
  expect(failed).not.toContain("prove again");
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect(entry(await run.settle()).content).toContain("Fix that and finish your turn, and Tesota will prove the file again.");
});

it("tells the operator outside Git that changes could not be verified, once a tool may have changed files", async () => {
  const outside = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(outside);
  const run = gate(outside);
  await run.input();
  run.tool("read");
  expect(await run.settle()).toBeUndefined();
  run.tool("edit");
  const settled = entry(await run.settle());
  expect(settled.customType).toBe("tesota-receipt");
  expect(settled.content).toBe("Tesota receipt\n  not verified  this request's changes: the project has no Git " +
    "repository, so Tesota cannot tell which files changed");
  expect((settled.details as Receipt).repository).toBe(false);
  await run.input();
  expect(await run.settle()).toBeUndefined();
});

it("proves a contract file whose .dfy alone changed, and leaves runs that did not complete alone", async () => {
  const root = project();
  const run = gate(root);
  writeFileSync(join(root, "src", "rule.dfy"), "// hand-written proof line\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  expect(await run.settle("aborted")).toBeUndefined();
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});

it("measures from the commit the request started at, so an agent's commit hides nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  commit(root, "agent");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
  scripted.delete("src/rule.ts");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
  expect(receipt.unverified).toEqual(["notes.md"]);
  await run.input();
  expect(await run.settle()).toBeUndefined();
});

it("keeps the running request's base through a steer or follow-up sent after the agent committed", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  commit(root, "agent");
  await run.input("interactive", "steer");
  await run.input("interactive", "followUp");
  expect((entry(await run.settle()).details as Receipt).proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
});

it("lists every file in a repository whose first commit the agent made", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  git(root, "init", "-q");
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  commit(root, "agent");
  expect((entry(await run.settle()).details as Receipt).unverified).toEqual(["notes.md"]);
});

it("puts each change that may weaken the evidence in the receipt, committed or not", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  const rule = ["//@ requires x >= 0", "//@ ensures \\result >= 0", "//@ ensures \\result >= x",
    "export function f(x: number): number { return x; }", "", "export function g(y: number): number { return y; }", ""];
  writeFileSync(join(root, "src", "rule.ts"), rule.join("\n"));
  writeFileSync(join(root, "src", "rule.dfy"), "method f(x: int) returns (r: int)\n{\n  r := x;\n}\n");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it('f', () => {});\n");
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "src", "rule.ts"), ["//@ requires x >= 1", "//@ ensures   \\result >= x", "//@ assume x < 10",
    "export function f(x: number): number { return x; }", "", "//@ requires y > 0",
    "export function g(y: number): number { return y; }", "", "//@ requires z > 0",
    "export function h(z: number): number { return z; }", ""].join("\n"));
  rmSync(join(root, "tests", "old.test.ts"));
  commit(root, "agent");
  writeFileSync(join(root, "src", "rule.dfy"), "method f(x: int) returns (r: int)\n{\n  assume false;\n  r := x;\n}\n" +
    "\nlemma Free()\n  ensures false\n");
  writeFileSync(join(root, "src", "extra.dfy"), "lemma {:axiom} Given()\n  ensures false\n");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it.skip('f', () => {});\n");
  writeFileSync(join(root, "src", "new.ts"), "//@ assume false\nexport const a = 1;\n");
  writeFileSync(join(root, "tests", "new.test.ts"), "it('new', () => {});\n");
  const settled = entry(await run.settle());
  expect(settled.content.split("\n").filter((line) => line.startsWith("  may weaken"))).toEqual([
    "  may weaken    src/extra.dfy: adds lemma {:axiom} Given()",
    "  may weaken    src/extra.dfy: adds lemma Given without a body",
    "  may weaken    src/new.ts: adds //@ assume false",
    "  may weaken    src/rule.dfy: adds assume false;",
    "  may weaken    src/rule.dfy: adds lemma Free without a body",
    "  may weaken    src/rule.ts: removes or changes //@ requires x >= 0",
    "  may weaken    src/rule.ts: removes or changes //@ ensures \\result >= 0",
    "  may weaken    src/rule.ts: adds //@ requires x >= 1 to a function the base had",
    "  may weaken    src/rule.ts: adds //@ assume x < 10",
    "  may weaken    src/rule.ts: adds //@ requires y > 0 to a function the base had",
    "  may weaken    tests/old.test.ts: deletes a test file",
    "  may weaken    tests/rule.test.ts: edits a test file",
  ]);
  expect((settled.details as Receipt).weakened).toContainEqual(
    { path: "tests/old.test.ts", kind: "deleted_test" });
});

it("settles with a receipt when the only change deletes a test", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  rmSync(join(root, "tests", "old.test.ts"));
  expect(entry(await run.settle()).content).toBe("Tesota receipt\n  may weaken    tests/old.test.ts: deletes a test file");
});

it("says a change too large to read was not checked for weakening, instead of listing nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "notes.md"), "x\n".repeat(9 * 1024 * 1024));
  const settled = entry(await run.settle());
  expect(settled.content).toBe(["Tesota receipt",
    "  not checked   weakened evidence: the change is too large to check for weakening",
    "  not verified  notes.md: no verifier covers it"].join("\n"));
  expect((settled.details as Receipt).weakened).toBe("too_large");
});
it("runs the project's tests, and runs each changed test on the request's base even after the agent commits", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n",
    "test/negative.test.mjs": priceTest(-1, 0), "test/positive.test.mjs": priceTest(2, 2),
    "test/__snapshots__/price.test.mjs.snap": "exports[`total 1`] = `1`;\n" });
  commit(root, "the agent's change");
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  const changed = ["src/price.mjs", "test/__snapshots__/price.test.mjs.snap", "test/negative.test.mjs", "test/positive.test.mjs"];
  // The snapshot is no test a runner runs alone, so it gets no line of its own on the base.
  expect(entry(settled).content).toBe([
    "Tesota receipt",
    "  passed        bun run test",
    "  exercises     test/negative.test.mjs: it fails without the change, and the base passes without it",
    "  vacuous test  test/positive.test.mjs: it passes without the change",
    ...changed.map((path) => `  not proved    ${path}: no proof covers it; the project's commands pass with it`),
  ].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect(receipt.tests.map(({ command, evidence }) => [command, evidence.verifier, evidence.files]))
    .toEqual([["bun run test", "command", changed]]);
  // The base ran in a worktree that is gone, and the checkout's dependencies it linked are not.
  expect(spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.match(/^worktree /gmu))
    .toHaveLength(1);
  expect(existsSync(join(root, "node_modules", "dep", "index.js"))).toBe(true);
}, 60_000);

it("sends failing tests back once when the project writes no test report, then settles with the failure", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  write(root, { "test/negative.test.mjs": priceTest(-1, 0) });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: `bun run test` fails with your changes.");
  run.agentStart();
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toBe(["Tesota receipt",
    "  NOT passed    bun run test: it still fails after its failure went back",
    "  not verified  test/negative.test.mjs: no verifier covers it"].join("\n"));
  await run.input();
  expect((await run.settle())?.continue).toBe(true);
}, 60_000);

it("sends failing tests back until the set that fails repeats one already sent, read from the test report", async () => {
  const root = testedProject("node --test --test-reporter=junit --test-reporter-destination=report.xml");
  const run = gate(root);
  await run.input();
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
  expect((entry(stuck).details as Receipt).tests.map(({ failingTests }) => failingTests)).toEqual([["test > a"]]);
}, 60_000);

it("gives no verdict on the base when the change touches what decides the dependencies", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" }, description: "changed" }),
    "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  expect(entry(await run.settle()).content).toContain("  exercise?     test/negative.test.mjs: the change touches " +
    "package.json, and the base runs with the checkout's dependencies, so a run there may not be faithful");
}, 60_000);

it("runs only the commands of the projects that own the changed files, there and on the base", async () => {
  const passing = "import { test } from \"node:test\";\ntest(\"ok\", () => {});\n";
  const root = repository({
    "a/package.json": JSON.stringify({ scripts: { test: "node --test" } }), "a/bun.lock": "", "a/test/x.test.mjs": passing,
    "b/package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }), "b/bun.lock": "",
  });
  const run = gate(root);
  await run.input();
  write(root, { "a/test/y.test.mjs": passing });
  expect(entry(await run.settle()).content).toBe(["Tesota receipt", "  passed        cd a && bun run test",
    "  vacuous test  a/test/y.test.mjs: it passes without the change",
    "  not proved    a/test/y.test.mjs: no proof covers it; the project's commands pass with it"].join("\n"));
}, 60_000);
