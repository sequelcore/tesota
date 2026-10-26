import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { suggestChecks } from "../src/projects.js";
import { exerciseTests, runShell } from "../src/test-rung.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A command whose shell starts a Node process that records its id and runs until stopped. */
const lingering = "node -e \"require('fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)\"";

async function until(condition: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-shell-"));
  roots.push(root);
  return root;
}

/** A Git repository holding only `math.ts` and a `package.json` whose tests are Bun's, with no tests (#575); its commit. */
function noTests(): { root: string; base: string } {
  const root = folder();
  writeFileSync(join(root, "math.ts"), "export function sub(a: number, b: number): number { return a - b; }\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "math", private: true, scripts: { test: "bun test" } }));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base");
  writeFileSync(join(root, "math.ts"), "export function sub(a: number, b: number): number { return a - b; }\n" +
    "export function add(a: number, b: number): number { return a + b; }\n");
  return { root, base: git("rev-parse", "HEAD").trim() };
}

const addTest = "import { expect, test } from \"bun:test\";\nimport { add } from \"./math\";\n\n" +
  "test(\"adds\", () => { expect(add(1, 2)).toBe(3); });\n";

it("credits a test added to a project with no tests that fails on the base and passes with the change", async () => {
  const { root, base } = noTests();
  writeFileSync(join(root, "math.test.ts"), addTest);
  const [exercise] = await exerciseTests(root, base, ["math.test.ts"], ["math.ts", "math.test.ts"], suggestChecks(root),
    new AbortController().signal);
  expect(exercise).toMatchObject({ path: "math.test.ts", provenance: "added", sensitivity: "fails_then_passes" });
}, 60_000);

it("judges a test on the base by the project's runner on that file alone, never by its whole check (#603)", async () => {
  const { root } = noTests();
  const marker = join(root, "checked").replaceAll("\\", "/");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    check: `node -e "require('fs').appendFileSync('${marker}', 'x')" && bun run test`, test: "bun test",
  } }));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", "package.json");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "check script");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "math.test.ts"), addTest);
  const [exercise] = await exerciseTests(root, base, ["math.test.ts"], ["math.ts", "math.test.ts"], suggestChecks(root),
    new AbortController().signal);
  expect(exercise).toMatchObject({ sensitivity: "fails_then_passes" });
  expect(exercise?.reason).toMatch(/by `\w+ run test (-- )?--pass-with-no-tests .* 'math\.test\.ts'`$/u);
  expect(existsSync(marker)).toBe(false);
}, 60_000);

it("does not credit a test added to a project with no tests when the test itself cannot run", async () => {
  const { root, base } = noTests();
  writeFileSync(join(root, "math.test.ts"), `${addTest}test("broken", () => {\n`);
  const [exercise] = await exerciseTests(root, base, ["math.test.ts"], ["math.ts", "math.test.ts"], suggestChecks(root),
    new AbortController().signal);
  expect(exercise).toMatchObject({ path: "math.test.ts", sensitivity: "unknown" });
}, 60_000);

/** `test` added to `noTests()`'s project at `path`, with `others` committed to its base first; the sensitivity and reason it gets. */
async function judged(path: string, test: string, others: Record<string, string> = {}): Promise<{ sensitivity: string; reason: string } | undefined> {
  const { root } = noTests();
  for (const [other, content] of Object.entries(others)) {
    mkdirSync(dirname(join(root, other)), { recursive: true });
    writeFileSync(join(root, other), content);
  }
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  if (Object.keys(others).length > 0) git("add", ...Object.keys(others));
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "others");
  const base = git("rev-parse", "HEAD").trim();
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), test);
  const [exercise] = await exerciseTests(root, base, [path], ["math.ts", path], suggestChecks(root), new AbortController().signal);
  return exercise;
}

// A runner that selects nothing passes with no tests, so its exit alone shows no test ran (#615).
it.each([
  ["a file the runner does not select", "tests/math.check.ts", addTest, {}, /on the base it passed, but the runner wrote no test report/u],
  ["a file whose only test is skipped", "math.test.ts", addTest.replace("test(", "test.skip("), {}, /every test from math\.test\.ts was skipped/u],
  ["a file whose filter selects only another file's test", "x.test.ts", 'import { test } from "bun:test";\n',
    { "extra/x.test.ts": 'import { expect, test } from "bun:test";\ntest("other", () => expect(1).toBe(1));\n' },
    /the runner ran no test from x\.test\.ts/u],
])("never says %s passes on the base", async (_label, path, test, others, reason) => {
  expect(await judged(path, test, others)).toMatchObject({ sensitivity: "unknown", reason: expect.stringMatching(reason) });
}, 60_000);

it("never credits a test that fails on the base when none of its tests runs on the change (#615)", async () => {
  // On the base `add` is missing, so the test runs and fails; on the change it exists, so the only test is skipped.
  const test = 'import { expect, test } from "bun:test";\nimport * as math from "./math";\n\n' +
    'test.skipIf(typeof (math as Record<string, unknown>).add === "function")("adds", () => expect((math as any).add(1, 2)).toBe(3));\n';
  expect(await judged("math.test.ts", test)).toMatchObject({ sensitivity: "unknown",
    reason: expect.stringMatching(/^it fails on the base by .*, but with the change in the same worktree, without the checkout's ignored files, .* passed and every test from math\.test\.ts was skipped$/u) });
}, 60_000);

// The base worktree lacks files the repository ignores, so the change runs there too, not in the checkout (#618).
it.each([["the runner on it alone", "bun test"], ["the whole check", "bun test && echo whole"]])(
  "never credits a test, judged by %s, that fails on the base only for want of an ignored file", async (_label, script) => {
    const { root } = noTests();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "math", private: true, scripts: { test: script } }));
    writeFileSync(join(root, ".gitignore"), "vendor/\n");
    writeFileSync(join(root, "sub.test.ts"), 'import { expect, test } from "bun:test";\nimport { sub } from "./math";\n\n' +
      'test("subs", () => expect(sub(3, 1)).toBe(2));\n');
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("add", "package.json", ".gitignore", "sub.test.ts");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "ignored vendor");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor", "helper.cjs"), "module.exports = () => 1;\n");
    writeFileSync(join(root, "helper.test.ts"), 'import { expect, test } from "bun:test";\nimport helper from "./vendor/helper.cjs";\n\n' +
      'test("helps", () => expect(helper()).toBe(1));\n');
    const [exercise] = await exerciseTests(root, base, ["helper.test.ts"], ["helper.test.ts"], suggestChecks(root), new AbortController().signal);
    expect(exercise).toMatchObject({ sensitivity: "unknown",
      reason: expect.stringMatching(/but with the change in the same worktree, without the checkout's ignored files, .* failed$/u) });
  }, 60_000);

it("still credits a test of a real change beside one that needs an ignored file (#618)", async () => {
  const { root } = noTests();
  writeFileSync(join(root, ".gitignore"), "vendor/\n");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", ".gitignore");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "ignored vendor");
  const base = git("rev-parse", "HEAD").trim();
  mkdirSync(join(root, "vendor"));
  writeFileSync(join(root, "vendor", "helper.cjs"), "module.exports = () => 1;\n");
  writeFileSync(join(root, "helper.test.ts"), 'import { expect, test } from "bun:test";\nimport helper from "./vendor/helper.cjs";\n\n' +
    'test("helps", () => expect(helper()).toBe(1));\n');
  writeFileSync(join(root, "math.test.ts"), addTest);
  const exercises = await exerciseTests(root, base, ["helper.test.ts", "math.test.ts"], ["math.ts", "helper.test.ts", "math.test.ts"],
    suggestChecks(root), new AbortController().signal);
  expect(exercises.map((each) => each.sensitivity)).toEqual(["unknown", "fails_then_passes"]);
}, 60_000);

// A filter selects every path that ends the same way; what else it ran is said, never taken for the file (#620).
it.each(["bun test", "vitest run"])("says which other files %s ran when judging one test file", async (runner) => {
  const { root } = noTests();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: runner } }));
  const from = runner === "bun test" ? '"bun:test"' : '"vitest"';
  mkdirSync(join(root, "extra", "tests"), { recursive: true });
  writeFileSync(join(root, "extra", "tests", "x.test.ts"), `import { expect, test } from ${from};\ntest("extra", () => expect(1).toBe(2));\n`);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", "package.json", "extra");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "collision");
  const base = git("rev-parse", "HEAD").trim();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "x.test.ts"), `import { expect, test } from ${from};\ntest("x", () => expect(1).toBe(1));\n`);
  const [exercise] = await exerciseTests(root, base, ["tests/x.test.ts"], ["tests/x.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(exercise).toMatchObject({ sensitivity: "unknown", reason: expect.stringMatching(/, which also ran tests from extra\/tests\/x\.test\.ts$/u) });
}, 60_000);

it("gives Jest each test file as an exact path, which keeps the project's own selection (#620)", async () => {
  const { root } = noTests();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-am", "jest");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "math.test.ts"), addTest);
  const [exercise] = await exerciseTests(root, base, ["math.test.ts"], ["math.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(exercise?.reason).toMatch(/by `\w+ run test (-- )?--passWithNoTests --runInBand --runTestsByPath .* 'math\.test\.ts'`$/u);
}, 60_000);

it("credits a changed test from the runner's report when a composite check fails on the base for an unrelated reason", async () => {
  const { root } = noTests();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    check: 'bun run test && bun -e "process.exit(1)"', test: "bun test",
  } }));
  writeFileSync(join(root, "math.ts"), "export const add = (a: number, b: number) => a - b;\nexport const other = false;\n");
  writeFileSync(join(root, "other.test.ts"), 'import { expect, test } from "bun:test";\nimport { other } from "./math";\ntest("other", () => expect(other).toBe(true));\n');
  writeFileSync(join(root, "math.test.ts"), addTest.replace("toBe(3)", "toBe(-1)"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "broken base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "math.ts"), "export const add = (a: number, b: number) => a + b;\nexport const other = true;\n");
  writeFileSync(join(root, "math.test.ts"), addTest);
  const [exercise] = await exerciseTests(root, base, ["math.test.ts"], ["math.ts", "math.test.ts"], suggestChecks(root),
    new AbortController().signal);
  expect(exercise).toMatchObject({ path: "math.test.ts", provenance: "changed", sensitivity: "fails_then_passes" });
}, 60_000);

it.each(["bun test", "vitest run"])("credits %s tests in an empty project and runs the change only once per project", async (runner) => {
  const { root } = noTests();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: runner } }));
  writeFileSync(join(root, "bun.lock"), "");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", "package.json", "bun.lock");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "vitest base");
  const base = git("rev-parse", "HEAD").trim();
  for (const name of ["first.test.ts", "second.test.ts"]) {
    writeFileSync(join(root, name), addTest.replace('"bun:test"', runner === "bun test" ? '"bun:test"' : '"vitest"') +
      `\nimport { appendFileSync } from "node:fs";\nif (typeof add === "function") appendFileSync(${JSON.stringify(join(root, "runs"))}, "x");\n`);
  }
  const exercises = await exerciseTests(root, base, ["first.test.ts", "second.test.ts"],
    ["math.ts", "first.test.ts", "second.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(exercises.map((each) => each.sensitivity)).toEqual(["fails_then_passes", "fails_then_passes"]);
  // Only the change has `add`, in the base's worktree, so each file counts once per run with the change.
  expect(readFileSync(join(root, "runs"), "utf8")).toBe("xx");
}, 120_000);

it("stops every process a cancelled command started, not only its shell", async () => {
  const root = folder();
  const controller = new AbortController();
  const running = runShell(lingering, root, controller.signal);
  expect(await until(() => existsSync(join(root, "pid")) && readFileSync(join(root, "pid"), "utf8") !== "")).toBe(true);
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  controller.abort();
  expect((await running).outcome).toBe("cancelled");
  expect(await until(() => !alive(pid), 5_000)).toBe(true);
});

it("stops every process a command started when it runs past its time limit", async () => {
  const root = folder();
  const run = await runShell(lingering, root, new AbortController().signal, 3_000);
  expect(run.outcome).toBe("timed_out");
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  expect(await until(() => !alive(pid), 5_000)).toBe(true);
});
