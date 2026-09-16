import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { REPOSITORY_VITEST_PROFILE, isIssuedRepositoryVitestResult, prepareRepositoryVitest,
  runRepositoryVitest, type RepositoryVitestProfile } from "../src/repository-vitest.js";
import type { RepositoryVitestExecutor } from "../src/repository-vitest-process.js";

const roots: string[] = [];
const fastConfiguration = `import { defineConfig, type ViteUserConfig } from "vitest/config";

const configuration: ViteUserConfig = defineConfig({
  test: {
    include: [
      "tests/sample.test.ts",
    ],
    maxWorkers: 4,
    testTimeout: 10_000,
  },
});

export default configuration;
`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error(result.stderr || "Git fixture failed");
}

async function fixture(configuration = fastConfiguration, script = "vitest run --config tests/vitest.fast.config.ts"): Promise<{
  readonly root: string; readonly source: string; readonly linuxX64NodeModules: string;
  readonly candidate: Awaited<ReturnType<typeof createCandidateCheckout>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "tesota-vitest-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "tests"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { "test:fast": script },
    devDependencies: { vitest: "4.1.11" } }, null, 2) + "\n");
  await writeFile(join(source, "tests", "vitest.fast.config.ts"), configuration);
  await writeFile(join(source, "bun.lock"), "lockfile fixture\n");
  await writeFile(join(source, ".gitignore"), "node_modules/\n");
  await writeFile(join(source, "src", "value.ts"), "export const value: string = 'ok';\n");
  await writeFile(join(source, "tests", "sample.test.ts"), "import { expect, it } from 'vitest'; it('sample', () => expect(1).toBe(1));\n");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "--", ".gitignore", "package.json", "tests", "bun.lock", "src"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  await mkdir(join(source, "node_modules", "vitest"), { recursive: true });
  await mkdir(join(source, "node_modules", "vite"), { recursive: true });
  await writeFile(join(source, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "4.1.11" }) + "\n");
  await writeFile(join(source, "node_modules", "vitest", "vitest.mjs"), "runner fixture\n");
  await writeFile(join(source, "node_modules", "vite", "package.json"), JSON.stringify({ name: "vite", version: "7.2.0" }) + "\n");
  const linuxX64NodeModules = join(root, "linux-x64-node_modules");
  await mkdir(join(linuxX64NodeModules, "vitest"), { recursive: true });
  await mkdir(join(linuxX64NodeModules, "vite"), { recursive: true });
  await mkdir(join(linuxX64NodeModules, "rolldown"), { recursive: true });
  await mkdir(join(linuxX64NodeModules, "esbuild"), { recursive: true });
  await mkdir(join(linuxX64NodeModules, "@rolldown", "binding-linux-x64-gnu"), { recursive: true });
  await mkdir(join(linuxX64NodeModules, "@esbuild", "linux-x64", "bin"), { recursive: true });
  await writeFile(join(linuxX64NodeModules, "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "4.1.11" }) + "\n");
  await writeFile(join(linuxX64NodeModules, "vitest", "vitest.mjs"), "linux runner fixture\n");
  await writeFile(join(linuxX64NodeModules, "vite", "package.json"), JSON.stringify({ name: "vite", version: "7.2.0" }) + "\n");
  await writeFile(join(linuxX64NodeModules, "rolldown", "package.json"), JSON.stringify({ name: "rolldown", version: "1.2.7" }) + "\n");
  await writeFile(join(linuxX64NodeModules, "esbuild", "package.json"), JSON.stringify({ name: "esbuild", version: "0.28.1" }) + "\n");
  await writeFile(join(linuxX64NodeModules, "@rolldown", "binding-linux-x64-gnu", "package.json"), JSON.stringify({
    name: "@rolldown/binding-linux-x64-gnu", version: "1.2.7", os: ["linux"], cpu: ["x64"] }) + "\n");
  await writeFile(join(linuxX64NodeModules, "@rolldown", "binding-linux-x64-gnu", "rolldown-binding.linux-x64-gnu.node"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await writeFile(join(linuxX64NodeModules, "@esbuild", "linux-x64", "package.json"), JSON.stringify({
    name: "@esbuild/linux-x64", version: "0.28.1", os: ["linux"], cpu: ["x64"] }) + "\n");
  await writeFile(join(linuxX64NodeModules, "@esbuild", "linux-x64", "bin", "esbuild"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  return { root, source, linuxX64NodeModules, candidate };
}

async function runtime(root: string): Promise<{ readonly executable: string; readonly executableSha256: string }> {
  const executable = join(root, "trusted", process.platform === "win32" ? "docker.exe" : "docker");
  await mkdir(join(root, "trusted"), { recursive: true });
  await writeFile(executable, "docker fixture\n");
  return { executable, executableSha256: createHash("sha256").update("docker fixture\n").digest("hex") };
}

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    snapshot: { added: 0, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0,
      filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0, didUpdate: false },
    startTime: 1, success: true,
    testResults: [{ assertionResults: [{ ancestorTitles: [], fullName: "sample", status: "passed", title: "sample",
      duration: 1, failureMessages: [], meta: {}, tags: [] }], startTime: 1, endTime: 2, status: "passed", message: "",
    name: "/workspace/repository/tests/sample.test.ts" }],
    ...overrides,
  });
}

const passed: RepositoryVitestExecutor = async () => ({ status: "closed", exitCode: 0, signal: null,
  stdout: Buffer.from(report()), stderr: Buffer.alloc(0), process: "exited", container: "absent" });

async function preparedProfile(current: Awaited<ReturnType<typeof fixture>>): Promise<RepositoryVitestProfile> {
  const preparation = await prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root), linuxX64NodeModules: current.linuxX64NodeModules });
  if (preparation.state === "unavailable") throw new Error(preparation.reason);
  return preparation.profile;
}

it("admits the exact fast Vitest declaration, selected test and contained runner", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);

  expect(profile).toMatchObject({ profile: REPOSITORY_VITEST_PROFILE, repository: { script: "vitest run --config tests/vitest.fast.config.ts" },
    configuration: { path: "tests/vitest.fast.config.ts", setupFiles: "absent", globalSetup: "absent", projects: "absent",
      plugins: "absent", selectedTests: [{ path: "tests/sample.test.ts" }] },
    verifier: { vitestVersion: "4.1.11", viteVersion: "7.2.0", dependencyProvenance: "operator_provisioned_unqualified" },
    isolation: { linuxX64NodeModules: current.linuxX64NodeModules },
    authority: "local_operator_approval_required" });
  await expect(runRepositoryVitest(profile, passed)).resolves.toMatchObject({ status: "passed", reason: null,
    diagnostics: [], process: "exited", container: "absent", authority: "none", provenance: "issued" });
});

it("rejects a selection whose Vitest positional filter would collect another configured file", async () => {
  const ambiguousConfiguration = fastConfiguration.replace(
    '      "tests/sample.test.ts",',
    '      "tests/sample.test.ts",\n      "tests/nested/tests/sample.test.ts",',
  );
  const current = await fixture(ambiguousConfiguration);

  await expect(prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root),
    linuxX64NodeModules: current.linuxX64NodeModules })).rejects.toThrow("selection is ambiguous");
});

it.each([
  ["test script", fastConfiguration, "vitest run"],
  ["setup files", fastConfiguration.replace("maxWorkers: 4", "setupFiles: []"), undefined],
  ["global setup", fastConfiguration.replace("maxWorkers: 4", "globalSetup: './setup.ts'"), undefined],
  ["projects", fastConfiguration.replace("maxWorkers: 4", "projects: []"), undefined],
  ["plugins", fastConfiguration.replace("testTimeout: 10_000", "plugins: []"), undefined],
] as const)("rejects unsupported %s", async (_name, configuration, script) => {
  const current = await fixture(configuration, script);
  await expect(prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root),
    linuxX64NodeModules: current.linuxX64NodeModules })).rejects.toThrow();
});

it("rejects an unsupported Vitest identity", async () => {
  const current = await fixture();
  await writeFile(join(current.linuxX64NodeModules, "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "4.0.0" }));
  await expect(prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root), linuxX64NodeModules: current.linuxX64NodeModules }))
    .resolves.toMatchObject({ state: "unavailable", reason: "linux_x64_dependency_closure_unavailable" });
});

it("rejects a malformed Vite identity", async () => {
  const malformedRunner = await fixture();
  await writeFile(join(malformedRunner.linuxX64NodeModules, "vite", "package.json"), JSON.stringify({ name: "other", version: "7.2.0" }));
  await expect(prepareRepositoryVitest({ candidate: malformedRunner.candidate.directory, source: malformedRunner.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(malformedRunner.root),
    linuxX64NodeModules: malformedRunner.linuxX64NodeModules })).resolves.toMatchObject({ state: "unavailable" });
});

it("rejects a test outside the configured selection", async () => {
  const unsupportedSelection = await fixture();
  await expect(prepareRepositoryVitest({ candidate: unsupportedSelection.candidate.directory, source: unsupportedSelection.source,
    selectedTests: ["tests/not-configured.test.ts"], runtime: await runtime(unsupportedSelection.root),
    linuxX64NodeModules: unsupportedSelection.linuxX64NodeModules })).rejects.toThrow();
});

it("rejects a protected oracle change", async () => {
  const protectedInput = await fixture();
  await writeFile(join(protectedInput.candidate.checkout, "tests", "sample.test.ts"), "changed\n");
  await expect(prepareRepositoryVitest({ candidate: protectedInput.candidate.directory, source: protectedInput.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(protectedInput.root),
    linuxX64NodeModules: protectedInput.linuxX64NodeModules })).rejects.toThrow("candidate shape unsupported");
});

it("does not issue a profile without the required Linux/x64 dependency closure", async () => {
  const current = await fixture();
  await expect(prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root) })).resolves.toEqual({
    state: "unavailable", reason: "linux_x64_dependency_closure_unavailable",
    diagnostic: "A provisioned Linux/x64 Vitest dependency closure is required.",
  });
  await expect(prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root),
    linuxX64NodeModules: join(current.source, "node_modules") })).resolves.toMatchObject({
    state: "unavailable", reason: "linux_x64_dependency_closure_unavailable",
  });
});

it("does not require legacy esbuild packages from a Rolldown-backed Vitest closure", async () => {
  const current = await fixture();
  await rm(join(current.linuxX64NodeModules, "esbuild"), { recursive: true, force: true });
  await rm(join(current.linuxX64NodeModules, "@esbuild"), { recursive: true, force: true });

  await expect(prepareRepositoryVitest({ candidate: current.candidate.directory, source: current.source,
    selectedTests: ["tests/sample.test.ts"], runtime: await runtime(current.root),
    linuxX64NodeModules: current.linuxX64NodeModules })).resolves.toMatchObject({ state: "prepared" });
});

it("maps coherent Vitest test failures to check_failed", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const failed = report({ numPassedTestSuites: 0, numFailedTestSuites: 1, numPassedTests: 0, numFailedTests: 1, success: false,
    testResults: [{ assertionResults: [{ ancestorTitles: [], fullName: "sample", status: "failed", title: "sample", duration: 1,
      failureMessages: ["Expected 1 to be 2"], meta: {}, tags: [] }], startTime: 1, endTime: 2, status: "failed",
    message: "Expected 1 to be 2", name: "/workspace/repository/tests/sample.test.ts" }] });
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 1, signal: null,
    stdout: Buffer.from(failed), stderr: Buffer.alloc(0), process: "exited", container: "absent" }))).resolves.toMatchObject({
    status: "check_failed", diagnostics: [expect.stringContaining("sample"), expect.stringContaining("Expected 1 to be 2")] });
});

it("maps an empty Vitest report to no_tests", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 1, signal: null,
    stdout: Buffer.from(report({ numTotalTestSuites: 0, numPassedTestSuites: 0, numTotalTests: 0, numPassedTests: 0,
      success: false, testResults: [] })), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "no_tests", reason: "no_tests" });
});

it("rejects empty Vitest output", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed" });
});

it("rejects non-JSON Vitest output", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from("not json"), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed" });
});

it("rejects Vitest JSON outside the reporter schema", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(report({ version: 3 })), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed" });
});

it("rejects an incoherent Vitest exit status", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 1, signal: null,
    stdout: Buffer.from(report()), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_vitest_result" });
});

it("fails closed for cancellation, timeout, uncertain cleanup, oversized output and input drift", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(runRepositoryVitest(profile, passed, cancellation.signal)).resolves.toMatchObject({ status: "cancelled", process: "not_started" });
  await expect(runRepositoryVitest(profile, async () => ({ status: "failed", reason: "cancelled", process: "unconfirmed",
    container: "absent" }))).resolves.toMatchObject({ status: "cancelled", process: "unconfirmed" });
  for (const [reason, expected] of [["timeout", "timed_out"], ["cleanup_unconfirmed", "execution_failed"],
    ["output_limit", "execution_failed"]] as const) {
    await expect(runRepositoryVitest(profile, async () => ({ status: "failed", reason, process: "unconfirmed", container: "unconfirmed" })))
      .resolves.toMatchObject({ status: expected, reason });
  }
  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.alloc(profile.limits.maxOutputBytes + 1), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "output_limit" });
  const duringExecution = vi.fn<RepositoryVitestExecutor>(async () => {
    await writeFile(join(current.candidate.checkout, "src", "value.ts"), "export const value = 'changed';\n");
    return { status: "closed", exitCode: 0, signal: null, stdout: Buffer.from(report()), stderr: Buffer.alloc(0),
      process: "exited", container: "absent" };
  });
  await expect(runRepositoryVitest(profile, duringExecution)).resolves.toMatchObject({ status: "execution_failed", reason: "input_drift" });
  expect(duringExecution).toHaveBeenCalledOnce();
});

it("does not dispatch a stale profile while retaining post-execution drift detection", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  await writeFile(join(current.linuxX64NodeModules, "vitest", "vitest.mjs"), "changed Linux runner fixture\n");
  const executor = vi.fn<RepositoryVitestExecutor>(passed);

  await expect(runRepositoryVitest(profile, executor)).resolves.toMatchObject({ status: "execution_failed", reason: "input_drift",
    process: "not_started", container: "absent" });
  expect(executor).not.toHaveBeenCalled();
});

it("accepts selected files when a nested suite raises the reporter suite count", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const nestedSuite = report({ numTotalTestSuites: 2, numPassedTestSuites: 2, numTotalTests: 2, numPassedTests: 2,
    testResults: [{ assertionResults: [
      { ancestorTitles: ["nested suite"], fullName: "nested suite passes first", status: "passed", title: "passes first",
        duration: 1, failureMessages: [], meta: {}, tags: [] },
      { ancestorTitles: ["nested suite"], fullName: "nested suite passes second", status: "passed", title: "passes second",
        duration: 1, failureMessages: [], meta: {}, tags: [] },
    ], startTime: 1, endTime: 2, status: "passed", message: "", name: "/workspace/repository/tests/sample.test.ts" }],
  });

  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(nestedSuite), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "passed", reason: null });
});

it("rejects a positive report with a failed suite", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const contradictory = report({ numTotalTestSuites: 2, numPassedTestSuites: 1, numFailedTestSuites: 1 });

  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(contradictory), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_vitest_result" });
});

it("rejects a positive report with a pending suite", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const contradictory = report({ numTotalTestSuites: 2, numPassedTestSuites: 1, numPendingTestSuites: 1 });

  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(contradictory), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_vitest_result" });
});

it("rejects a positive report with a failed snapshot", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const contradictory = report({ snapshot: { added: 0, failure: true, filesAdded: 0, filesRemoved: 0, filesRemovedList: [],
    filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0,
    updated: 0, didUpdate: false } });

  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(contradictory), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_vitest_result" });
});

it("treats a selected file with no assertions as no_tests", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const noAssertions = report({ numTotalTests: 0, numPassedTests: 0,
    testResults: [{ assertionResults: [], startTime: 1, endTime: 2, status: "passed", message: "",
      name: "/workspace/repository/tests/sample.test.ts" }] });

  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(noAssertions), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "no_tests", reason: "no_tests" });
});

it("rejects a positive report whose file status contradicts its assertions", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const contradictory = report({ testResults: [{ assertionResults: [{ ancestorTitles: [], fullName: "sample", status: "passed",
    title: "sample", duration: 1, failureMessages: [], meta: {}, tags: [] }], startTime: 1, endTime: 2, status: "failed",
  message: "", name: "/workspace/repository/tests/sample.test.ts" }] });

  await expect(runRepositoryVitest(profile, async () => ({ status: "closed", exitCode: 0, signal: null,
    stdout: Buffer.from(contradictory), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_vitest_result" });
});

it("does not accept reconstructed profile or result objects as issued evidence", async () => {
  const current = await fixture();
  const profile = await preparedProfile(current);
  const result = await runRepositoryVitest(profile, passed);
  expect(isIssuedRepositoryVitestResult(result)).toBe(true);
  expect(isIssuedRepositoryVitestResult(structuredClone(result))).toBe(false);
  await expect(runRepositoryVitest(structuredClone(profile), passed)).rejects.toThrow("was not issued");
});
