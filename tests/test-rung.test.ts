import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("does not credit a test added to a project with no tests when the test itself cannot run", async () => {
  const { root, base } = noTests();
  writeFileSync(join(root, "math.test.ts"), `${addTest}test("broken", () => {\n`);
  const [exercise] = await exerciseTests(root, base, ["math.test.ts"], ["math.ts", "math.test.ts"], suggestChecks(root),
    new AbortController().signal);
  expect(exercise).toMatchObject({ path: "math.test.ts", sensitivity: "unknown" });
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
      '\nimport { appendFileSync } from "node:fs";\nappendFileSync("runs", "x");\n');
  }
  const exercises = await exerciseTests(root, base, ["first.test.ts", "second.test.ts"],
    ["math.ts", "first.test.ts", "second.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(exercises.map((each) => each.sensitivity)).toEqual(["fails_then_passes", "fails_then_passes"]);
  expect(readFileSync(join(root, "runs"), "utf8")).toBe("xx");
}, 120_000);

it.each([false, true])("credits Jest's native report (composite check: %s)", async (composite) => {
  const { root } = noTests();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    test: "jest", ...(composite ? { check: 'npm run test -- --runInBand && node -e "process.exit(1)"' } : {}),
  } }));
  writeFileSync(join(root, "math.cjs"), "exports.add = (a, b) => a - b;\nexports.other = false;\n");
  if (composite) writeFileSync(join(root, "other.test.cjs"), 'const { other } = require("./math.cjs");\ntest("other", () => expect(other).toBe(true));\n');
  const test = 'const { add } = require("./math.cjs");\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
  if (composite) writeFileSync(join(root, "math.test.cjs"), test.replace("toBe(3)", "toBe(-1)"));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", "package.json", "math.cjs", ...(composite ? ["math.test.cjs", "other.test.cjs"] : []));
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "jest base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "math.cjs"), "exports.add = (a, b) => a + b;\nexports.other = true;\n");
  writeFileSync(join(root, "math.test.cjs"), test);
  const [exercise] = await exerciseTests(root, base, ["math.test.cjs"], ["math.cjs", "math.test.cjs"], suggestChecks(root),
    new AbortController().signal);
  expect(exercise).toMatchObject({ path: "math.test.cjs", sensitivity: "fails_then_passes" });
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
