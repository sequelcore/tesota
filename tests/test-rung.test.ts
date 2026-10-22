import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
