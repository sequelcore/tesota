import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as realTimeout } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { owningProjects, suggestChecks } from "../src/projects.js";
import { exerciseTests, exerciseSourcePaths, runCommands, runShell } from "../src/test-rung.js";
import { noOperations } from "../src/operations.js";

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
  try { process.kill(pid, 0); } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
  // Linux retains a terminated child's PID until it is reaped; existence alone does not mean it can execute.
  if (process.platform !== "linux") return true;
  try {
    const status = readFileSync(`/proc/${pid}/stat`, "utf8");
    return status.slice(status.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-shell-"));
  roots.push(root);
  return root;
}

/** A Git repository holding only `math.ts` and a `package.json` whose tests are Bun's, with no tests; its commit. */
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

it("records only the changed source path each assertion notices (#669)", async () => {
  const { root } = noTests();
  writeFileSync(join(root, "math.ts"), "export const add = (a: number, b: number): number => a - b;\n");
  execFileSync("git", ["add", "math.ts"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "wrong addition"], { cwd: root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(root, "math.ts"), "export const add = (a: number, b: number): number => a + b;\n");
  writeFileSync(join(root, "math.test.ts"), addTest);
  writeFileSync(join(root, "other.ts"), "export const unused = 1;\n");
  const changed = ["math.ts", "math.test.ts", "other.ts"];
  const measured = await exerciseSourcePaths(root, base, ["math.test.ts"], changed, suggestChecks(root), new AbortController().signal);
  expect(measured.get("math.test.ts")?.sources).toEqual(["math.ts"]);
  expect(readFileSync(join(root, "math.ts"), "utf8")).toContain("a + b");
});

it("does not treat an unreadable oversized base source as an absent file (#669)", async () => {
  const { root } = noTests();
  const baseSource = `export const value = 0;\n/*${"x".repeat(17 * 1024 * 1024)}*/\n`;
  writeFileSync(join(root, "large.ts"), baseSource);
  execFileSync("git", ["add", "large.ts"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "large base"], { cwd: root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(root, "large.ts"), baseSource.replace("value = 0", "value = 1"));
  writeFileSync(join(root, "large.test.ts"), "import {test,expect} from 'bun:test'; import {existsSync} from 'node:fs'; test('exists',()=>expect(existsSync('large.ts')).toBe(true));\n");
  const result = await exerciseSourcePaths(root, base, ["large.test.ts"], ["large.ts", "large.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(result.get("large.test.ts")?.sources).toEqual([]);
  expect(result.get("large.test.ts")?.sourceGaps).toEqual([{ path: "large.ts", reason: expect.any(String) }]);
});

it("does not credit source sensitivity after omitting an ignored local input (#669)", async () => {
  const { root } = noTests();
  writeFileSync(join(root, ".gitignore"), ".env\n");
  writeFileSync(join(root, "a.ts"), "export const a = 0;\n");
  execFileSync("git", ["add", ".gitignore", "a.ts"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "local input"], { cwd: root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(root, ".env"), "LOCAL=1\n");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "a.test.ts"), "import {test,expect} from 'bun:test'; import {existsSync} from 'node:fs'; import {a} from './a'; test('either',()=>expect(a===1||existsSync('.env')).toBe(true));\n");
  const result = await exerciseSourcePaths(root, base, ["a.test.ts"], ["a.ts", "a.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(result.get("a.test.ts")?.sources).toEqual([]);
  expect(result.get("a.test.ts")?.sourceGaps).toEqual([{ path: "a.ts", reason: expect.stringContaining("ignored local inputs") }]);
});

it("does not credit a source reversion that breaks setup before an assertion (#669)", async () => {
  const { root } = noTests();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", packageManager: "bun@1.4.2", scripts: { test: "vitest run" } }));
  writeFileSync(join(root, "state.ts"), "export const state: { ready: boolean } | null = null;\n");
  execFileSync("git", ["add", "state.ts", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "base state"], { cwd: root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(root, "state.ts"), "export const state = { ready: true };\n");
  writeFileSync(join(root, "state.test.ts"), 'import { beforeEach, expect, test } from "vitest";\nimport { state } from "./state";\nbeforeEach(() => { if (!state.ready) throw new Error("not ready"); });\ntest("unrelated arithmetic", () => expect(1 + 1).toBe(2));\n');
  const measured = await exerciseSourcePaths(root, base, ["state.test.ts"], ["state.ts", "state.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(measured.get("state.test.ts")?.sources).toEqual([]);
  expect(measured.get("state.test.ts")?.sourceGaps).toEqual([expect.objectContaining({ path: "state.ts" })]);
});

it("leaves every source uncredited when the shared source budget is exhausted (#669)", async () => {
  const { root, base } = noTests();
  const measured = await exerciseSourcePaths(root, base, ["math.test.ts"], ["math.ts", "math.test.ts"], suggestChecks(root),
    new AbortController().signal, undefined, undefined, performance.now() - 1);
  expect(measured.get("math.test.ts")).toMatchObject({ sources: [], sourceGaps: [{ path: "math.ts", reason: expect.stringContaining("budget") }] });
});

it("attributes a plain Bun script's unchanged failure to the base without project-authored reports (#728)", async () => {
  const { root } = noTests();
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "bun test" } }));
  writeFileSync(join(root, "math.test.ts"), 'import { expect, test } from "bun:test";\ntest("legacy", () => expect(1).toBe(2));\n');
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", "math.test.ts", "package.json");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "legacy failure");
  const base = git("rev-parse", "HEAD").trim();
  const [run] = await runCommands(root, suggestChecks(root), ["math.ts"], new AbortController().signal,
    undefined, undefined, { base });
  expect(run).toMatchObject({ command: "bun run test", evidence: { outcome: "failed" }, origin: { cause: "preexisting" } });
  expect(run?.failingTests).toEqual(["math.test.ts > legacy"]);
});

function failingRunner(runner: "bun test" | "vitest run"): { root: string; base: string; from: string } {
  const { root } = noTests();
  const from = runner === "bun test" ? "bun:test" : "vitest";
  if (runner === "vitest run") symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", packageManager: "bun@1.4.2", scripts: { test: runner } }));
  writeFileSync(join(root, "math.test.ts"), `import { expect, test } from "${from}";\ntest("legacy", () => expect(1).toBe(2));\n`);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", "math.test.ts", "package.json");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "legacy failure");
  return { root, base: git("rev-parse", "HEAD").trim(), from };
}

it("records a fixed admitted check only after observing its failing baseline (#727)", async () => {
  const { root, base } = failingRunner("bun test");
  writeFileSync(join(root, "math.test.ts"), 'import { expect, test } from "bun:test";\ntest("legacy", () => expect(1).toBe(1));\n');
  const [run] = await runCommands(root, suggestChecks(root), ["math.test.ts"], new AbortController().signal, undefined, undefined, { base });
  expect(run).toMatchObject({ evidence: { outcome: "passed" }, origin: { cause: "fixed" }, baseline: { outcome: "failed" } });
});

it("does not execute a stored package invocation outside its repository (#727)", async () => {
  const parent = folder();
  const root = join(parent, "repo");
  mkdirSync(root);
  const script = "node -e \"require('fs').writeFileSync('escaped', 'executed')\"";
  writeFileSync(join(parent, "package.json"), JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: script } }));
  const [run] = await runCommands(root, [{ folder: "..", commands: [{ folder: "..", command: "bun run test", script }] }],
    ["math.ts"], new AbortController().signal);
  expect(run?.evidence.outcome).toBe("not_started");
  expect(existsSync(join(parent, "escaped"))).toBe(false);
});

it("does not execute an invented command from a stored check plan (#727)", async () => {
  const { root } = noTests();
  const [run] = await runCommands(root, [{ folder: "", commands: [{ folder: "",
    command: "node -e \"require('fs').writeFileSync('invented', 'executed')\"" }] }], ["math.ts"], new AbortController().signal);
  expect(run?.evidence.outcome).toBe("not_started");
  expect(existsSync(join(root, "invented"))).toBe(false);
});

it.each(["bun test", "vitest run"] as const)("keeps new %s assertion failures attributable over an already failing base (#728)", async (runner) => {
  const { root, base, from } = failingRunner(runner);
  writeFileSync(join(root, "new.test.ts"), `import { expect, test } from "${from}";\ntest("new failure", () => expect(3).toBe(4));\n`);
  const [run] = await runCommands(root, suggestChecks(root), ["new.test.ts"], new AbortController().signal,
    undefined, undefined, { base });
  expect(run?.origin?.cause).toBe("introduced");
  expect(run?.failingTests?.some((name) => name.endsWith("new failure"))).toBe(true);
}, 60_000);

it.each(["bun test", "vitest run"] as const)("never hides a new %s import error behind an old assertion failure (#728)", async (runner) => {
  const { root, base } = failingRunner(runner);
  writeFileSync(join(root, "broken.test.ts"), 'import "./missing-module";\n');
  const [run] = await runCommands(root, suggestChecks(root), ["broken.test.ts"], new AbortController().signal,
    undefined, undefined, { base });
  expect(run?.evidence.outcome).toBe("failed");
  expect(run?.origin?.cause).not.toBe("preexisting");
}, 60_000);

it("attributes a plain Vitest script's unchanged failure and removes private reports (#728)", async () => {
  const { root, base } = failingRunner("vitest run");
  const [run] = await runCommands(root, suggestChecks(root), ["math.ts"], new AbortController().signal,
    undefined, undefined, { base });
  expect(run?.origin?.cause).toBe("preexisting");
  expect(existsSync(join(root, run?.evidence.output.match(/--outputFile=([^\s]+)/u)?.[1] ?? "missing"))).toBe(false);
}, 60_000);

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

it.each([
  ["npm", { workspaces: ["packages/*"] }, {}],
  ["Bun", { workspaces: { packages: ["packages/*"] } }, {}],
  ["pnpm", {}, { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n" }],
])("exercises a %s workspace test with its member's runner, not the root's (#674)", async (_name, declaration, extra) => {
  const { root } = noTests();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "package.json"), JSON.stringify({ ...declaration, type: "module", packageManager: "bun@1.4.2",
    scripts: { test: "vitest run" } }));
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { include: ["tests/**/*.test.ts"] } };\n');
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/math.test.ts"), 'import { expect, test } from "vitest";\ntest("root", () => expect(1).toBe(1));\n');
  mkdirSync(join(root, "packages/web"), { recursive: true });
  writeFileSync(join(root, "packages/web/package.json"), JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "bun test" } }));
  writeFileSync(join(root, "packages/web/math.ts"), "export const add = (a: number, b: number) => a - b;\n");
  writeFileSync(join(root, "packages/web/math.test.ts"), addTest.replace("toBe(3)", "toBe(-1)"));
  for (const [path, content] of Object.entries(extra)) writeFileSync(join(root, path), content);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "workspace base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "packages/web/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  writeFileSync(join(root, "packages/web/math.test.ts"), addTest);
  const [exercise] = await exerciseTests(root, base, ["packages/web/math.test.ts"],
    ["packages/web/math.ts", "packages/web/math.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(exercise, exercise?.reason).toMatchObject({ provenance: "changed", sensitivity: "fails_then_passes" });
  expect(exercise?.reason).toMatch(/by `cd packages\/web && bun run test .* 'math\.test\.ts'`$/u);
}, 60_000);

it.each([
  ["", true, true], ["frontend", true, true], ["frontend", false, true], ["frontend", false, false],
])("uses workspace root %s test fallback (root test: %s, member lint: %s)", async (workspace, hasTest, hasLint) => {
  const { root } = noTests();
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  const member = workspace === "" ? "packages/web" : `${workspace}/web`;
  mkdirSync(join(root, member), { recursive: true });
  writeFileSync(join(root, workspace, "package.json"), JSON.stringify({ type: "module", packageManager: "bun@1.4.2",
    workspaces: [workspace === "" ? "packages/*" : "web"], scripts: hasTest ? { test: "vitest run" } : { lint: "eslint ." } }));
  writeFileSync(join(root, member, "package.json"), JSON.stringify({ scripts: hasLint ? { lint: "eslint ." } : {} }));
  writeFileSync(join(root, member, "math.ts"), "export const add = (a: number, b: number) => a - b;\n");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "lint-only member");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, member, "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  const path = `${member}/math.test.ts`;
  writeFileSync(join(root, path), addTest.replace('"bun:test"', '"vitest"'));
  const changed = [`${member}/math.ts`, path];
  // The gate passes only the changed files' owning checks, not every discovered project.
  const selected = owningProjects(suggestChecks(root), changed);
  const [exercise] = await exerciseTests(root, base, [path], changed, selected, new AbortController().signal);
  if (hasTest) {
    expect(exercise, exercise?.reason).toMatchObject({ sensitivity: "fails_then_passes" });
    expect(exercise?.reason).toContain(`${workspace === "" ? "" : `cd ${workspace} && `}bun run test --run`);
    expect(exercise?.reason).toContain(`no test script in ${member}/package.json`);
    expect(exercise?.reason).not.toContain("run lint");
  } else {
    expect(exercise).toMatchObject({ sensitivity: "unknown" });
    expect(exercise?.reason).toContain("test was not run");
    expect(exercise?.reason).toContain(`no test script in ${member}/package.json or workspace root ${workspace}/package.json`);
  }
}, 60_000);

it.each(["", "packages"])("names the wrapped member fallback under workspace root %s (#674)", async (workspace) => {
  const { root } = noTests();
  mkdirSync(join(root, "packages/web"), { recursive: true });
  writeFileSync(join(root, workspace, "package.json"), JSON.stringify({ workspaces: [workspace === "" ? "packages/*" : "web"], scripts: { test: "vitest run" } }));
  writeFileSync(join(root, "packages/web/package.json"), JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "bun test && echo wrapped" } }));
  writeFileSync(join(root, "packages/web/control.test.ts"), 'import { expect, test } from "bun:test";\ntest("control", () => expect(1).toBe(1));\n');
  writeFileSync(join(root, "packages/web/math.ts"), "export const add = (a: number, b: number) => a - b;\n");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "member fallback");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "packages/web/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  writeFileSync(join(root, "packages/web/math.test.ts"), addTest);
  const [exercise] = await exerciseTests(root, base, ["packages/web/math.test.ts"],
    ["packages/web/math.ts", "packages/web/math.test.ts"], suggestChecks(root), new AbortController().signal);
  expect(exercise).toMatchObject({ sensitivity: "fails_then_passes" });
  expect(exercise?.reason).toContain("test script `bun test && echo wrapped` cannot be probed per file");
  expect(exercise?.reason).toMatch(/by the whole check, `cd packages\/web && bun run (check|test)`/u);
}, 60_000);

it("names the real packages/core wrapper instead of probing its tests with root Vitest (#638)", async () => {
  const root = process.cwd();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const path = "packages/core/tests/extension.test.ts";
  // Stop before launching the engine's full check; this covers real discovery and fallback reporting.
  const [exercise] = await exerciseTests(root, base, [path], [path], suggestChecks(root), AbortSignal.abort());
  expect(exercise).toMatchObject({ sensitivity: "unknown" });
  expect(exercise?.reason).toContain("by the whole check, `cd packages/core &&");
  expect(exercise?.reason).toContain("test script `bun scripts/isolated.ts bun scripts/tests.ts` cannot be probed per file");
});

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

// A runner that selects nothing passes with no tests, so its exit alone shows no test ran.
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

// The base worktree lacks files the repository ignores, so the change runs there too, not in the checkout.
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

// A filter selects every path that ends the same way; what else it ran is said, never taken for the file.
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

it("reports a check that prints results and hangs after one timeout, without running it on the base (#784)", async () => {
  const { root } = noTests();
  const command = "node -e \"console.log('146 passing (3s)'); const fs = require('fs'); fs.writeFileSync('pid', ''); " +
    "setTimeout(() => fs.writeFileSync('pid', String(process.pid)), 100); setInterval(() => {}, 1000)\"";
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.2", scripts: { check: command } }));
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "hanging check"], { cwd: root });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const controller = new AbortController();
  const operations: string[] = [];
  const ops = { ...noOperations, run: async <T>(spec: Parameters<typeof noOperations.run>[0], work: () => Promise<T>) => {
    operations.push(spec.method);
    // Bound the regression's second run too, without waiting a second fifteen minutes.
    if (spec.method === "base_command") controller.abort();
    return work();
  } };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const running = runCommands(root, suggestChecks(root), ["math.ts"], controller.signal, ops, undefined, { base });
  try {
    // Creation precedes the write: do not advance the timeout until the child has published its actual PID.
    for (let n = 0; n < 500 && (!existsSync(join(root, "pid")) || readFileSync(join(root, "pid"), "utf8") === ""); n++) await realTimeout(10);
    expect(existsSync(join(root, "pid"))).toBe(true);
    const pid = Number(readFileSync(join(root, "pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const [run] = await running;
    expect(run?.evidence).toMatchObject({ outcome: "timed_out", output: expect.stringContaining("146 passing") });
    expect(operations).toEqual(["command"]);
    expect(run?.origin).toEqual({ cause: "unknown", reason: expect.stringContaining("did not finish") });
    const active = alive(pid);
    let status = "";
    if (active && process.platform === "linux") {
      try { status = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { status = "the PID became unavailable after the liveness check"; }
    }
    expect(active, `the timed-out child ${pid} still executes: ${status}`).toBe(false);
  } finally {
    controller.abort();
    vi.useRealTimers();
    await running;
  }
});
