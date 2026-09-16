import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import * as z from "zod";
import { bindCandidateCheckoutContent, inspectPromotionSource } from "./candidate-checkout.js";
import { CONTAINER_IMAGE, VITEST_SEMANTIC_ARGUMENTS, buildVitestContainerInvocation, containerRuntimeIsOutside,
  resolveContainerRuntime, type ContainerRuntimeIdentity, vitestContainerPolicySha256 } from "./command-isolation.js";
import { dependencyInstallationSha256, parseRepositoryJson, readRepositoryInput, repositoryInputDirectory,
  sha256 } from "./repository-check-input.js";
import { REPOSITORY_VITEST_LIMITS, executeRepositoryVitestContainer, type RepositoryVitestExecutor,
  type RepositoryVitestProcessObservation } from "./repository-vitest-process.js";

export const REPOSITORY_VITEST_PROFILE = "vitest-targeted/v1" as const;
const REPOSITORY_VITEST_SCRIPT = "vitest run --config tests/vitest.fast.config.ts" as const;
const CONFIGURATION_PATH = "tests/vitest.fast.config.ts" as const;
const digestPattern = /^[a-f0-9]{64}$/u;
const testPathPattern = /^tests\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.test\.ts$/u;
const protectedCandidateFiles = new Set(["package.json", "bun.lock", "tsconfig.json", "tsconfig.build.json"]);

const packageSchema = z.object({
  scripts: z.object({ "test:fast": z.literal(REPOSITORY_VITEST_SCRIPT) }),
  devDependencies: z.object({ vitest: z.string().regex(/^\d+\.\d+\.\d+$/u) }),
});
const packageIdentitySchema = z.object({ name: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/u) });
const linuxX64PackageSchema = z.object({ name: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  os: z.array(z.literal("linux")).min(1), cpu: z.array(z.literal("x64")).min(1) });
const snapshotSchema = z.strictObject({
  added: z.number().int().nonnegative(), failure: z.boolean(), filesAdded: z.number().int().nonnegative(),
  filesRemoved: z.number().int().nonnegative(), filesRemovedList: z.array(z.string()), filesUnmatched: z.number().int().nonnegative(),
  filesUpdated: z.number().int().nonnegative(), matched: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  unchecked: z.number().int().nonnegative(), uncheckedKeysByFile: z.array(z.string()), unmatched: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(), didUpdate: z.boolean(),
});
const assertionSchema = z.strictObject({
  ancestorTitles: z.array(z.string()), fullName: z.string(), status: z.enum(["passed", "failed", "pending", "skipped", "todo"]),
  title: z.string(), duration: z.number().finite().nonnegative(), failureMessages: z.array(z.string()), meta: z.strictObject({}),
  tags: z.array(z.string()),
});
const fileResultSchema = z.strictObject({
  assertionResults: z.array(assertionSchema), startTime: z.number().finite(), endTime: z.number().finite(),
  status: z.enum(["passed", "failed", "pending", "skipped"]), message: z.string(), name: z.string(),
});
const reportSchema = z.strictObject({
  numTotalTestSuites: z.number().int().nonnegative(), numPassedTestSuites: z.number().int().nonnegative(),
  numFailedTestSuites: z.number().int().nonnegative(), numPendingTestSuites: z.number().int().nonnegative(),
  numTotalTests: z.number().int().nonnegative(), numPassedTests: z.number().int().nonnegative(),
  numFailedTests: z.number().int().nonnegative(), numPendingTests: z.number().int().nonnegative(),
  numTodoTests: z.number().int().nonnegative(), snapshot: snapshotSchema, startTime: z.number().finite(), success: z.boolean(),
  testResults: z.array(fileResultSchema),
});
type VitestReport = z.infer<typeof reportSchema>;

export interface RepositoryVitestProfile {
  readonly profile: typeof REPOSITORY_VITEST_PROFILE;
  readonly candidate: { readonly directory: string; readonly checkout: string; readonly baseline: string; readonly contentSha256: string };
  readonly repository: { readonly script: typeof REPOSITORY_VITEST_SCRIPT; readonly packageJsonSha256: string; readonly lockfileSha256: string };
  readonly configuration: { readonly path: typeof CONFIGURATION_PATH; readonly sha256: string;
    readonly setupFiles: "absent"; readonly globalSetup: "absent"; readonly projects: "absent"; readonly plugins: "absent";
    readonly selectedTests: readonly { readonly path: string; readonly sha256: string }[] };
  readonly verifier: { readonly vitestVersion: string; readonly viteVersion: string; readonly entrySha256: string;
    readonly installationSha256: string; readonly dependencyProvenance: "operator_provisioned_unqualified" };
  readonly isolation: { readonly image: typeof CONTAINER_IMAGE; readonly policySha256: string; readonly executable: string;
    readonly executableSha256: string; readonly linuxX64NodeModules: string };
  readonly command: readonly string[];
  readonly limits: typeof REPOSITORY_VITEST_LIMITS;
  readonly authority: "local_operator_approval_required";
}

export type RepositoryVitestResult = Readonly<{
  profile: typeof REPOSITORY_VITEST_PROFILE;
  status: "passed" | "check_failed" | "no_tests" | "unavailable" | "execution_failed" | "timed_out" | "cancelled";
  reason: string | null;
  diagnostics: readonly string[];
  process: "not_started" | "exited" | "unconfirmed";
  container: "absent" | "unconfirmed";
  binding: Omit<RepositoryVitestProfile, "authority">;
  authority: "none";
  provenance: "issued";
}>;

interface PrepareOptions {
  readonly candidate: string;
  readonly source: string;
  readonly selectedTests: readonly string[];
  readonly runtime?: ContainerRuntimeIdentity;
  readonly linuxX64NodeModules?: string;
}

export type RepositoryVitestPreparation =
  | Readonly<{ readonly state: "prepared"; readonly profile: RepositoryVitestProfile }>
  | Readonly<{ readonly state: "unavailable"; readonly reason: "linux_x64_dependency_closure_unavailable";
    readonly diagnostic: "A provisioned Linux/x64 Vitest dependency closure is required." }>;

interface LinuxX64DependencyBinding {
  readonly nodeModules: string;
  readonly vitestVersion: string;
  readonly viteVersion: string;
  readonly entrySha256: string;
  readonly installationSha256: string;
}

const issuedProfiles = new WeakSet<object>();
const issuedResults = new WeakSet<object>();

function isProtectedCandidatePath(path: string): boolean {
  return protectedCandidateFiles.has(path) || path.startsWith("tests/") || path.endsWith(".snap") ||
    path.includes("/__snapshots__/") || /^(?:vite|vitest)\.[A-Za-z0-9_.-]+$/u.test(path);
}

function isOutside(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return !(difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
}

function removeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").trim();
}

function configuredTests(bytes: Buffer): readonly string[] {
  const source = removeComments(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const match = /^import \{ defineConfig, type ViteUserConfig \} from "vitest\/config";\s*const configuration: ViteUserConfig = defineConfig\(\{\s*test: \{\s*include: \[\s*((?:"tests\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.test\.ts",?\s*)+)\],\s*maxWorkers: 4,\s*testTimeout: 10_000,\s*\},\s*\}\);\s*export default configuration;$/u.exec(source);
  if (match?.[1] === undefined) throw new Error("Repository Vitest configuration unsupported");
  const selected = [...match[1].matchAll(/"(tests\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.test\.ts)"/gu)].map((entry) => entry[1]);
  if (selected.length === 0 || selected.some((path) => path === undefined) || new Set(selected).size !== selected.length) {
    throw new Error("Repository Vitest configuration unsupported");
  }
  return selected as string[];
}

async function selectedTestBindings(checkout: string, selectedTests: readonly string[], allowedTests: readonly string[]): Promise<
  readonly { readonly path: string; readonly sha256: string }[]> {
  if (selectedTests.length === 0 || new Set(selectedTests).size !== selectedTests.length || selectedTests.some((path) =>
    !testPathPattern.test(path) || !allowedTests.includes(path))) throw new Error("Repository Vitest selected tests unsupported");
  const normalizedFilters = selectedTests.map((path) => path.toLowerCase());
  const collectedTests = allowedTests.filter((path) => normalizedFilters.some((filter) => path.toLowerCase().includes(filter)));
  if (collectedTests.length !== selectedTests.length || collectedTests.some((path) => !selectedTests.includes(path))) {
    throw new Error("Repository Vitest selection is ambiguous");
  }
  return Object.freeze(await Promise.all(selectedTests.map(async (path) => Object.freeze({ path,
    sha256: sha256(await readRepositoryInput(join(checkout, path), 1024 * 1024)) }))));
}

async function linuxX64NativeDependency(nodeModules: string, packageName: string, executable: string): Promise<void> {
  const directory = await repositoryInputDirectory(join(nodeModules, ...packageName.split("/")));
  const identity = linuxX64PackageSchema.parse(parseRepositoryJson(await readRepositoryInput(join(directory, "package.json"), 128 * 1024)));
  if (identity.name !== packageName) throw new Error("Linux/x64 Vitest dependency closure unavailable");
  const entry = await readRepositoryInput(join(directory, executable), 128 * 1024 * 1024);
  if (entry.subarray(0, 4).compare(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) !== 0) {
    throw new Error("Linux/x64 Vitest dependency closure unavailable");
  }
}

async function linuxX64DependencyBinding(path: string, expectedVitestVersion: string): Promise<LinuxX64DependencyBinding> {
  const nodeModules = await repositoryInputDirectory(path);
  const vitest = await repositoryInputDirectory(join(nodeModules, "vitest"));
  const vite = await repositoryInputDirectory(join(nodeModules, "vite"));
  const installedVitest = packageIdentitySchema.parse(parseRepositoryJson(await readRepositoryInput(join(vitest, "package.json"), 128 * 1024)));
  const installedVite = packageIdentitySchema.parse(parseRepositoryJson(await readRepositoryInput(join(vite, "package.json"), 128 * 1024)));
  if (installedVitest.name !== "vitest" || installedVitest.version !== expectedVitestVersion || installedVite.name !== "vite") {
    throw new Error("Linux/x64 Vitest dependency closure unavailable");
  }
  const rolldown = await repositoryInputDirectory(join(nodeModules, "rolldown"));
  const installedRolldown = packageIdentitySchema.parse(parseRepositoryJson(await readRepositoryInput(join(rolldown, "package.json"), 128 * 1024)));
  if (installedRolldown.name !== "rolldown") {
    throw new Error("Linux/x64 Vitest dependency closure unavailable");
  }
  await linuxX64NativeDependency(nodeModules, "@rolldown/binding-linux-x64-gnu", "rolldown-binding.linux-x64-gnu.node");
  return Object.freeze({ nodeModules, vitestVersion: installedVitest.version, viteVersion: installedVite.version,
    entrySha256: sha256(await readRepositoryInput(join(vitest, "vitest.mjs"), 128 * 1024 * 1024)),
    installationSha256: await dependencyInstallationSha256(nodeModules) });
}

function withoutAuthority(profile: RepositoryVitestProfile): Omit<RepositoryVitestProfile, "authority"> {
  const { authority: _authority, ...binding } = profile;
  return Object.freeze(binding);
}

function issueResult(profile: RepositoryVitestProfile, status: RepositoryVitestResult["status"], reason: string | null,
  diagnostics: readonly string[], process: RepositoryVitestResult["process"],
  container: RepositoryVitestResult["container"]): RepositoryVitestResult {
  const result: RepositoryVitestResult = Object.freeze({ profile: REPOSITORY_VITEST_PROFILE, status, reason,
    diagnostics: Object.freeze([...diagnostics]), process, container, binding: withoutAuthority(profile), authority: "none", provenance: "issued" });
  issuedResults.add(result);
  return result;
}

function failedResult(profile: RepositoryVitestProfile, status: RepositoryVitestResult["status"], reason: string,
  process: RepositoryVitestResult["process"], container: RepositoryVitestResult["container"]): RepositoryVitestResult {
  return issueResult(profile, status, reason, [], process, container);
}

function parseReport(observed: Extract<RepositoryVitestProcessObservation, { readonly status: "closed" }>): VitestReport {
  if (observed.stdout.length + observed.stderr.length > REPOSITORY_VITEST_LIMITS.maxOutputBytes) throw new Error("output_limit");
  if (observed.stdout.length === 0 || observed.stderr.length !== 0) throw new Error("invalid_output");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.stdout));
  return reportSchema.parse(value);
}

function observedTestsMatch(report: VitestReport, selectedTests: readonly { readonly path: string }[]): boolean {
  const expected = new Set(selectedTests.map((test) => test.path));
  const observed = report.testResults.map((result) => normalizedTestPath(result.name));
  return observed.length === expected.size && observed.every((path) => path !== null && expected.has(path)) &&
    new Set(observed).size === expected.size;
}

function normalizedTestPath(name: string): string | null {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized.startsWith("/workspace/repository/")) return null;
  const path = normalized.slice("/workspace/repository/".length);
  if (!testPathPattern.test(path) || path.includes("//") || path.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return path;
}

function summaryMatches(report: VitestReport): boolean {
  const assertions = report.testResults.flatMap((result) => result.assertionResults);
  const counted = (status: string): number => assertions.filter((assertion) => assertion.status === status).length;
  return report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites === report.numTotalTestSuites &&
    report.numPassedTests + report.numFailedTests + report.numPendingTests + report.numTodoTests === report.numTotalTests &&
    assertions.length === report.numTotalTests && counted("passed") === report.numPassedTests &&
    counted("failed") === report.numFailedTests && counted("pending") + counted("skipped") === report.numPendingTests &&
    counted("todo") === report.numTodoTests;
}

function noTests(report: VitestReport, selectedTests: readonly { readonly path: string }[]): boolean {
  return report.numTotalTests === 0 && report.numPassedTests === 0 && report.numFailedTests === 0 &&
    report.numPendingTests === 0 && report.numTodoTests === 0 && report.numFailedTestSuites === 0 &&
    report.numPendingTestSuites === 0 && report.testResults.every((result) => result.assertionResults.length === 0) &&
    (report.testResults.length === 0 || observedTestsMatch(report, selectedTests));
}

function cleanSnapshot(report: VitestReport): boolean {
  const snapshot = report.snapshot;
  return !snapshot.failure && snapshot.added === 0 && snapshot.filesAdded === 0 && snapshot.filesRemoved === 0 &&
    snapshot.filesRemovedList.length === 0 && snapshot.filesUnmatched === 0 && snapshot.filesUpdated === 0 &&
    snapshot.unchecked === 0 && snapshot.uncheckedKeysByFile.length === 0 && snapshot.unmatched === 0 &&
    snapshot.updated === 0 && !snapshot.didUpdate && snapshot.matched === snapshot.total;
}

function cleanPass(report: VitestReport): boolean {
  return report.success && report.numTotalTestSuites > 0 && report.numPassedTestSuites === report.numTotalTestSuites &&
    report.numFailedTestSuites === 0 && report.numPendingTestSuites === 0 && report.numTotalTests > 0 &&
    report.numPassedTests === report.numTotalTests && report.numFailedTests === 0 && report.numPendingTests === 0 &&
    report.numTodoTests === 0 && cleanSnapshot(report) && report.testResults.every((result) => result.status === "passed" &&
      result.assertionResults.length > 0 && result.assertionResults.every((assertion) => assertion.status === "passed"));
}

function testDiagnostics(report: VitestReport): readonly string[] {
  const diagnostics: string[] = [];
  for (const file of report.testResults) for (const assertion of file.assertionResults) {
    if (assertion.status !== "failed") continue;
    diagnostics.push(`${file.name}: ${assertion.fullName}`.slice(0, 2_000));
    for (const message of assertion.failureMessages) diagnostics.push(message.slice(0, 2_000));
  }
  return diagnostics.slice(0, 200);
}

function resultFromReport(profile: RepositoryVitestProfile, observed: Extract<RepositoryVitestProcessObservation, { readonly status: "closed" }>,
  report: VitestReport): RepositoryVitestResult {
  if (observed.signal !== null || observed.exitCode === null || !summaryMatches(report)) {
    return failedResult(profile, "execution_failed", "incoherent_vitest_result", observed.process, observed.container);
  }
  if (noTests(report, profile.configuration.selectedTests)) {
    return failedResult(profile, "no_tests", "no_tests", observed.process, observed.container);
  }
  if (!observedTestsMatch(report, profile.configuration.selectedTests)) {
    return failedResult(profile, "execution_failed", "unexpected_test_collection", observed.process, observed.container);
  }
  if (observed.exitCode === 0 && cleanPass(report)) {
    return issueResult(profile, "passed", null, [], observed.process, observed.container);
  }
  if (observed.exitCode === 1 && !report.success && report.numFailedTests > 0 &&
      report.testResults.some((result) => result.status === "failed")) {
    return issueResult(profile, "check_failed", "diagnostics", testDiagnostics(report), observed.process, observed.container);
  }
  return failedResult(profile, "execution_failed", "incoherent_vitest_result", observed.process, observed.container);
}

async function inputsRemainCurrent(profile: RepositoryVitestProfile): Promise<boolean> {
  const candidate = await bindCandidateCheckoutContent(profile.candidate.directory, isProtectedCandidatePath);
  const packageBytes = await readRepositoryInput(join(candidate.checkout, "package.json"), 128 * 1024);
  const lockfileBytes = await readRepositoryInput(join(candidate.checkout, "bun.lock"), 8 * 1024 * 1024);
  const configuration = await readRepositoryInput(join(candidate.checkout, CONFIGURATION_PATH), 128 * 1024);
  const configured = configuredTests(configuration);
  const selectedTests = await selectedTestBindings(candidate.checkout, profile.configuration.selectedTests.map((test) => test.path), configured);
  const dependencies = await linuxX64DependencyBinding(profile.isolation.linuxX64NodeModules, profile.verifier.vitestVersion);
  const executableSha256 = sha256(await readRepositoryInput(profile.isolation.executable, 128 * 1024 * 1024));
  return candidate.contentSha256 === profile.candidate.contentSha256 && sha256(packageBytes) === profile.repository.packageJsonSha256 &&
    sha256(lockfileBytes) === profile.repository.lockfileSha256 && sha256(configuration) === profile.configuration.sha256 &&
    JSON.stringify(selectedTests) === JSON.stringify(profile.configuration.selectedTests) &&
    dependencies.vitestVersion === profile.verifier.vitestVersion && dependencies.viteVersion === profile.verifier.viteVersion &&
    dependencies.entrySha256 === profile.verifier.entrySha256 &&
    dependencies.installationSha256 === profile.verifier.installationSha256 && executableSha256 === profile.isolation.executableSha256;
}

/** Admit the repository's exact fast Vitest declaration without executing its command string. */
export async function prepareRepositoryVitest(options: PrepareOptions): Promise<RepositoryVitestPreparation> {
  const candidate = await bindCandidateCheckoutContent(options.candidate, isProtectedCandidatePath);
  const sourceIdentity = await inspectPromotionSource(candidate.directory, options.source, "package.json");
  if (sourceIdentity.head !== candidate.baseline) throw new Error("Repository Vitest source baseline changed");
  const packageBytes = await readRepositoryInput(join(candidate.checkout, "package.json"), 128 * 1024);
  const lockfileBytes = await readRepositoryInput(join(candidate.checkout, "bun.lock"), 8 * 1024 * 1024);
  const configuration = await readRepositoryInput(join(candidate.checkout, CONFIGURATION_PATH), 128 * 1024);
  const declared = packageSchema.parse(parseRepositoryJson(packageBytes));
  const configured = configuredTests(configuration);
  const selectedTests = await selectedTestBindings(candidate.checkout, options.selectedTests, configured);
  const dependencies = await (options.linuxX64NodeModules === undefined ? Promise.resolve(undefined) :
    linuxX64DependencyBinding(options.linuxX64NodeModules, declared.devDependencies.vitest).catch(() => undefined));
  if (dependencies === undefined || !isOutside(candidate.directory, dependencies.nodeModules)) {
    return Object.freeze({ state: "unavailable", reason: "linux_x64_dependency_closure_unavailable",
    diagnostic: "A provisioned Linux/x64 Vitest dependency closure is required." });
  }
  const runtime = options.runtime ?? await resolveContainerRuntime([sourceIdentity.source, candidate.directory, candidate.checkout]);
  if (!digestPattern.test(runtime.executableSha256) || !containerRuntimeIsOutside(runtime,
    [sourceIdentity.source, candidate.directory, candidate.checkout, dependencies.nodeModules])) throw new Error("Repository Vitest runtime unavailable");
  const profile: RepositoryVitestProfile = {
    profile: REPOSITORY_VITEST_PROFILE, candidate,
    repository: { script: REPOSITORY_VITEST_SCRIPT, packageJsonSha256: sha256(packageBytes), lockfileSha256: sha256(lockfileBytes) },
    configuration: { path: CONFIGURATION_PATH, sha256: sha256(configuration), setupFiles: "absent", globalSetup: "absent",
      projects: "absent", plugins: "absent", selectedTests },
    verifier: { vitestVersion: dependencies.vitestVersion, viteVersion: dependencies.viteVersion,
      entrySha256: dependencies.entrySha256, installationSha256: dependencies.installationSha256,
      dependencyProvenance: "operator_provisioned_unqualified" },
    isolation: { image: CONTAINER_IMAGE, policySha256: vitestContainerPolicySha256(), executable: runtime.executable,
      executableSha256: runtime.executableSha256, linuxX64NodeModules: dependencies.nodeModules },
    command: Object.freeze(["node", "/workspace/node_modules/vitest/vitest.mjs", ...VITEST_SEMANTIC_ARGUMENTS,
      ...selectedTests.map((test) => test.path)]), limits: REPOSITORY_VITEST_LIMITS, authority: "local_operator_approval_required",
  };
  Object.freeze(profile.candidate); Object.freeze(profile.repository); Object.freeze(profile.configuration.selectedTests);
  Object.freeze(profile.configuration); Object.freeze(profile.verifier); Object.freeze(profile.isolation); Object.freeze(profile);
  issuedProfiles.add(profile);
  return Object.freeze({ state: "prepared", profile });
}

/** Execute a previously admitted Vitest profile and fail closed on output or input ambiguity. */
export async function runRepositoryVitest(profile: RepositoryVitestProfile,
  executor: RepositoryVitestExecutor = executeRepositoryVitestContainer, signal?: AbortSignal): Promise<RepositoryVitestResult> {
  if (!issuedProfiles.has(profile)) throw new Error("Repository Vitest profile was not issued");
  if (signal?.aborted === true) return failedResult(profile, "cancelled", "cancelled", "not_started", "absent");
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return failedResult(profile, "execution_failed", "input_drift", "not_started", "absent");
  }
  const name = `tesota-vitest-${randomUUID()}`;
  const observed = await executor(buildVitestContainerInvocation({ candidate: profile.candidate.checkout,
    linuxX64NodeModules: profile.isolation.linuxX64NodeModules,
    selectedTests: profile.configuration.selectedTests.map((test) => test.path) },
  profile.isolation.executable, name), name, signal);
  if (observed.status === "failed") {
    const status = observed.reason === "cancelled" ? "cancelled" : observed.reason === "timeout" ? "timed_out" :
      observed.reason === "spawn_failed" ? "unavailable" : "execution_failed";
    return failedResult(profile, status, observed.reason, observed.process, observed.container);
  }
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return failedResult(profile, "execution_failed", "input_drift", observed.process, observed.container);
  }
  try { return resultFromReport(profile, observed, parseReport(observed)); }
  catch (error) {
    const reason = error instanceof Error && error.message === "output_limit" ? "output_limit" : "invalid_output";
    return failedResult(profile, "execution_failed", reason, observed.process, observed.container);
  }
}

/** A structural clone of an observation never acquires issued provenance. */
export function isIssuedRepositoryVitestResult(result: RepositoryVitestResult): boolean {
  return issuedResults.has(result);
}

export function formatRepositoryVitestProfile(profile: RepositoryVitestProfile): string {
  return `Repository check profile\nProfile: ${profile.profile}\nCandidate: ${profile.candidate.directory}\n` +
    `Baseline: ${profile.candidate.baseline}\nCandidate content: ${profile.candidate.contentSha256}\n` +
    `Repository declaration: ${profile.repository.script}\nConfiguration: ${profile.configuration.path}; ${profile.configuration.sha256}\n` +
    `Selected tests: ${profile.configuration.selectedTests.map((test) => test.path).join(", ")}\n` +
    `Verifier: Vitest ${profile.verifier.vitestVersion}; Vite ${profile.verifier.viteVersion}; installation ${profile.verifier.installationSha256}; dependency provenance ${profile.verifier.dependencyProvenance}\n` +
    `Execution: ${profile.command.join(" ")}\nIsolation: ${profile.isolation.image}; policy ${profile.isolation.policySha256}\n` +
    `Runtime: ${profile.isolation.executable}; SHA-256 ${profile.isolation.executableSha256}\n` +
    "Effects: candidate and Linux/x64 dependencies read-only; network denied; host credentials not mounted\n" +
    `Limits: ${profile.limits.timeoutMs} ms, ${profile.limits.maxOutputBytes} output bytes\n` +
    "Authority: pending explicit local operator approval.\n";
}
