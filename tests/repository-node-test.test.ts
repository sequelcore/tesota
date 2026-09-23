import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { buildNodeTestContainerInvocation } from "../src/command-isolation.js";
import { prepareRepositoryNodeTest, runRepositoryNodeTest } from "../src/repository-node-test.js";
import type { RepositoryNodeTestExecutor } from "../src/repository-node-test-process.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error(result.stderr || "Git fixture failed");
}

async function fixture(): Promise<{
  root: string; source: string; candidate: Awaited<ReturnType<typeof createCandidateCheckout>>;
  runtime: { executable: string; executableSha256: string };
}> {
  const root = await mkdtemp(join(tmpdir(), "tesota-node-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "lib"), { recursive: true });
  await mkdir(join(source, "tests"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ type: "module", scripts: {
    test: "node --experimental-strip-types --test tests/*.test.ts",
  } }) + "\n");
  await writeFile(join(source, "lib", "value.ts"), "export const value = 1;\n");
  await writeFile(join(source, "tests", "value.test.ts"),
    "import test from 'node:test'; import { value } from '../lib/value.ts'; test('value', () => { if (value !== 1) throw Error(); });\n");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "--", "package.json", "lib", "tests"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  const executable = join(root, "trusted", process.platform === "win32" ? "docker.exe" : "docker");
  await mkdir(join(root, "trusted"), { recursive: true });
  await writeFile(executable, "docker fixture\n");
  return { root, source, candidate, runtime: { executable,
    executableSha256: createHash("sha256").update("docker fixture\n").digest("hex") } };
}

function report(counts: Record<string, number>, entries = ["/workspace/repository/tests/value.test.ts"]): string {
  return JSON.stringify({ format: "tesota-node-test-report", version: 1, summaries: 1,
    summary: { success: (counts["failed"] ?? 0) === 0, counts: { cancelled: 0, failed: 0, passed: 1,
      skipped: 0, suites: 0, tests: 1, todo: 0, topLevel: 1, ...counts } },
    observed: { passed: counts["passed"] ?? 1, failed: counts["failed"] ?? 0, entries } }) + "\n";
}

function executor(output: string, exitCode = 0): RepositoryNodeTestExecutor {
  return async () => ({ status: "closed", exitCode, signal: null, stdout: Buffer.from(output), stderr: Buffer.alloc(0),
    process: "exited", container: "absent" });
}

it("binds a selected existing Node test and invokes Docker with no host execution", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryNodeTest({ candidate: current.candidate.directory, source: current.source,
    selectedTest: "tests/value.test.ts", allowedWriteFiles: ["lib/value.ts", "tests/value.test.ts"],
    runtime: current.runtime });
  expect(profile.command).toEqual(["node", "--experimental-strip-types", "--test", "--test-concurrency=1",
    "--test-reporter=/tesota/reporter.mjs", "tests/value.test.ts"]);
  const invocation = buildNodeTestContainerInvocation({ candidate: profile.candidate.checkout,
    reporter: profile.verifier.reporter, selectedTest: profile.repository.selectedTest }, current.runtime.executable, "test");
  expect(invocation.args).toContain("--network=none");
  expect(invocation.args).toContain("--read-only");
  await expect(runRepositoryNodeTest(profile, executor(report({})))).resolves.toMatchObject({ status: "passed", reason: null,
    process: "exited", container: "absent" });
});

it.each([
  ["empty", report({ tests: 0, passed: 0, topLevel: 0 }, []), "no_tests"],
  ["skipped", report({ tests: 1, passed: 0, skipped: 1 }), "execution_failed"],
  ["wrong entry", report({}, ["/workspace/repository/tests/other.test.ts"]), "execution_failed"],
  ["malformed", "not JSON", "execution_failed"],
] as const)("does not pass a %s report", async (_name, output, expected) => {
  const current = await fixture();
  const profile = await prepareRepositoryNodeTest({ candidate: current.candidate.directory, source: current.source,
    selectedTest: "tests/value.test.ts", allowedWriteFiles: ["lib/value.ts", "tests/value.test.ts"],
    runtime: current.runtime });
  await expect(runRepositoryNodeTest(profile, executor(output))).resolves.toMatchObject({ status: expected });
});

it("invalidates the check after a selected test changes", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryNodeTest({ candidate: current.candidate.directory, source: current.source,
    selectedTest: "tests/value.test.ts", allowedWriteFiles: ["lib/value.ts", "tests/value.test.ts"],
    runtime: current.runtime });
  await writeFile(join(current.candidate.checkout, "tests", "value.test.ts"), "test changed\n");
  await expect(runRepositoryNodeTest(profile, executor(report({})))).resolves.toMatchObject({ status: "execution_failed",
    reason: "input_drift", process: "not_started" });
});
