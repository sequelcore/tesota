import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { bindCandidateCheckoutContent, inspectPromotionSource } from "./candidate-checkout.js";
import { CONTAINER_IMAGE, buildNodeTestContainerInvocation, containerRuntimeIsOutside,
  nodeTestContainerPolicySha256, resolveContainerRuntime, type ContainerRuntimeIdentity } from "./command-isolation.js";
import { parseRepositoryJson, readRepositoryInput, sha256 } from "./repository-check-input.js";
import { REPOSITORY_NODE_TEST_LIMITS, executeRepositoryNodeTestContainer,
  type RepositoryNodeTestExecutor } from "./repository-node-test-process.js";
import { validProposalPath } from "./task-proposal-contract.js";

export const REPOSITORY_NODE_TEST_PROFILE = "node-test-targeted/v1" as const;
const selectedTestPattern = /^tests\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.test\.ts$/u;
const protectedInputs = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "tsconfig.json"]);
const packageSchema = z.object({ scripts: z.object({ test: z.string().min(1).max(4_000) }) });
const countSchema = z.number().int().nonnegative();
const reportSchema = z.strictObject({
  format: z.literal("tesota-node-test-report"), version: z.literal(1), summaries: countSchema,
  summary: z.strictObject({ success: z.boolean(), counts: z.strictObject({
    cancelled: countSchema, failed: countSchema, passed: countSchema, skipped: countSchema,
    suites: countSchema, tests: countSchema, todo: countSchema, topLevel: countSchema,
  }) }).nullable(),
  observed: z.strictObject({ passed: countSchema, failed: countSchema, entries: z.array(z.string()) }),
});

export interface RepositoryNodeTestProfile {
  readonly profile: typeof REPOSITORY_NODE_TEST_PROFILE;
  readonly candidate: { readonly directory: string; readonly checkout: string; readonly baseline: string;
    readonly contentSha256: string };
  readonly repository: { readonly packageJsonSha256: string; readonly declaredTestScript: string;
    readonly selectedTest: string; readonly selectedTestSha256: string; readonly allowedWriteFiles: readonly string[] };
  readonly verifier: { readonly reporter: string; readonly reporterSha256: string };
  readonly isolation: { readonly image: typeof CONTAINER_IMAGE; readonly policySha256: string;
    readonly executable: string; readonly executableSha256: string };
  readonly command: readonly string[];
  readonly limits: typeof REPOSITORY_NODE_TEST_LIMITS;
  readonly authority: "local_operator_approval_required";
}

export type RepositoryNodeTestResult = Readonly<{
  profile: typeof REPOSITORY_NODE_TEST_PROFILE;
  status: "passed" | "check_failed" | "no_tests" | "unavailable" | "execution_failed" | "timed_out" | "cancelled";
  reason: string | null;
  diagnostics: readonly string[];
  process: "not_started" | "exited" | "unconfirmed";
  container: "absent" | "unconfirmed";
  binding: Omit<RepositoryNodeTestProfile, "authority">;
  authority: "none";
  provenance: "issued";
}>;

interface PrepareOptions {
  readonly candidate: string;
  readonly source: string;
  readonly selectedTest: string;
  readonly allowedWriteFiles: readonly string[];
  readonly runtime?: ContainerRuntimeIdentity;
}

const issuedProfiles = new WeakSet<object>();
const issuedResults = new WeakSet<object>();

function allowedPaths(options: PrepareOptions): readonly string[] {
  const paths = options.allowedWriteFiles;
  if (!selectedTestPattern.test(options.selectedTest) || !paths.includes(options.selectedTest) ||
      paths.length !== 2 || new Set(paths).size !== paths.length ||
      paths.some((path) => !validProposalPath(path) || protectedInputs.has(path)) ||
      paths.filter((path) => path !== options.selectedTest).some((path) => !path.endsWith(".ts") ||
        path.endsWith(".d.ts") || path.startsWith("tests/"))) {
    throw new Error("Repository Node test selection unsupported");
  }
  return paths;
}

async function candidateBinding(options: PrepareOptions): Promise<RepositoryNodeTestProfile["candidate"]> {
  const allowed = allowedPaths(options);
  return bindCandidateCheckoutContent(options.candidate, (path) => !allowed.includes(path));
}

function reporterPath(): string {
  return fileURLToPath(new URL("../dist/repository-node-test-reporter.js", import.meta.url));
}

export async function prepareRepositoryNodeTest(options: PrepareOptions): Promise<RepositoryNodeTestProfile> {
  const candidate = await candidateBinding(options);
  const source = await inspectPromotionSource(candidate.directory, options.source, "package.json");
  if (source.head !== candidate.baseline) throw new Error("Repository Node test baseline changed");
  const packageBytes = await readRepositoryInput(join(candidate.checkout, "package.json"), 128 * 1024);
  const declared = packageSchema.parse(parseRepositoryJson(packageBytes));
  const selectedTestBytes = await readRepositoryInput(join(candidate.checkout, options.selectedTest), 1024 * 1024);
  const reporter = reporterPath();
  const reporterBytes = await readRepositoryInput(reporter, 128 * 1024);
  const runtime = options.runtime ?? await resolveContainerRuntime([source.source, candidate.directory, reporter]);
  if (!containerRuntimeIsOutside(runtime, [source.source, candidate.directory, reporter]) ||
      !/^[a-f0-9]{64}$/u.test(runtime.executableSha256)) throw new Error("Repository Node test runtime unavailable");
  const profile: RepositoryNodeTestProfile = {
    profile: REPOSITORY_NODE_TEST_PROFILE, candidate,
    repository: { packageJsonSha256: sha256(packageBytes), declaredTestScript: declared.scripts.test,
      selectedTest: options.selectedTest, selectedTestSha256: sha256(selectedTestBytes),
      allowedWriteFiles: Object.freeze([...options.allowedWriteFiles]) },
    verifier: { reporter, reporterSha256: sha256(reporterBytes) },
    isolation: { image: CONTAINER_IMAGE, policySha256: nodeTestContainerPolicySha256(),
      executable: runtime.executable, executableSha256: runtime.executableSha256 },
    command: Object.freeze(["node", "--experimental-strip-types", "--test", "--test-concurrency=1",
      "--test-reporter=/tesota/reporter.mjs", options.selectedTest]),
    limits: REPOSITORY_NODE_TEST_LIMITS, authority: "local_operator_approval_required",
  };
  Object.freeze(profile.repository); Object.freeze(profile.verifier); Object.freeze(profile.isolation); Object.freeze(profile);
  issuedProfiles.add(profile);
  return profile;
}

async function inputsRemainCurrent(profile: RepositoryNodeTestProfile): Promise<boolean> {
  const options: PrepareOptions = { candidate: profile.candidate.directory, source: profile.candidate.checkout,
    selectedTest: profile.repository.selectedTest, allowedWriteFiles: profile.repository.allowedWriteFiles };
  const candidate = await candidateBinding(options);
  const packageBytes = await readRepositoryInput(join(candidate.checkout, "package.json"), 128 * 1024);
  const selectedTestBytes = await readRepositoryInput(join(candidate.checkout, profile.repository.selectedTest), 1024 * 1024);
  const reporterBytes = await readRepositoryInput(profile.verifier.reporter, 128 * 1024);
  const runtimeBytes = await readRepositoryInput(profile.isolation.executable, 128 * 1024 * 1024);
  return candidate.contentSha256 === profile.candidate.contentSha256 &&
    sha256(packageBytes) === profile.repository.packageJsonSha256 &&
    sha256(selectedTestBytes) === profile.repository.selectedTestSha256 &&
    sha256(reporterBytes) === profile.verifier.reporterSha256 &&
    sha256(runtimeBytes) === profile.isolation.executableSha256 &&
    relative(reporterPath(), profile.verifier.reporter) === "";
}

function issueResult(profile: RepositoryNodeTestProfile, status: RepositoryNodeTestResult["status"], reason: string | null,
  diagnostics: readonly string[], process: RepositoryNodeTestResult["process"],
  container: RepositoryNodeTestResult["container"]): RepositoryNodeTestResult {
  const { authority: _authority, ...binding } = profile;
  const result: RepositoryNodeTestResult = Object.freeze({ profile: REPOSITORY_NODE_TEST_PROFILE, status, reason,
    diagnostics: Object.freeze([...diagnostics]), process, container, binding: Object.freeze(binding),
    authority: "none", provenance: "issued" });
  issuedResults.add(result);
  return result;
}

function parsedReport(stdout: Buffer): z.infer<typeof reportSchema> | null {
  try { return reportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout))); }
  catch { return null; }
}

function coherentReport(report: z.infer<typeof reportSchema>, expectedEntry: string): boolean {
  const counts = report.summary?.counts;
  return report.summaries === 1 && counts !== undefined &&
    report.observed.entries.length === 1 && report.observed.entries[0] === expectedEntry &&
    report.observed.passed === counts.passed && report.observed.failed === counts.failed &&
    counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo === counts.tests;
}

function cleanPass(report: z.infer<typeof reportSchema>): boolean {
  const counts = report.summary?.counts;
  return counts !== undefined && report.summary?.success === true && counts.tests > 0 &&
    counts.passed === counts.tests && counts.failed === 0 && counts.cancelled === 0 &&
    counts.skipped === 0 && counts.todo === 0;
}

function observedResult(profile: RepositoryNodeTestProfile, stdout: Buffer, stderr: Buffer, exitCode: number | null,
  signal: NodeJS.Signals | null, process: RepositoryNodeTestResult["process"],
  container: RepositoryNodeTestResult["container"]): RepositoryNodeTestResult {
  if (stdout.length + stderr.length > REPOSITORY_NODE_TEST_LIMITS.maxOutputBytes || stderr.length !== 0 ||
      signal !== null || exitCode === null) return issueResult(profile, "execution_failed", "invalid_output", [], process, container);
  const report = parsedReport(stdout);
  if (report === null) return issueResult(profile, "execution_failed", "invalid_output", [], process, container);
  const counts = report.summary?.counts;
  const expectedEntry = `/workspace/repository/${profile.repository.selectedTest}`;
  if (report.summaries !== 1 || counts === undefined) {
    return issueResult(profile, "execution_failed", "incoherent_node_test_result", [], process, container);
  }
  if (counts.tests === 0 && report.observed.passed === 0 && report.observed.failed === 0 &&
      report.observed.entries.length === 0) return issueResult(profile, "no_tests", "no_tests", [], process, container);
  if (!coherentReport(report, expectedEntry)) {
    return issueResult(profile, "execution_failed", "incoherent_node_test_result", [], process, container);
  }
  if (exitCode === 0 && cleanPass(report)) {
    return issueResult(profile, "passed", null, [], process, container);
  }
  if (exitCode === 1 && (counts.failed > 0 || report.summary?.success === false)) {
    return issueResult(profile, "check_failed", "diagnostics", [
      `Node tests: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.todo} todo.`,
    ], process, container);
  }
  return issueResult(profile, "execution_failed", "incoherent_node_test_result", [], process, container);
}

export async function runRepositoryNodeTest(profile: RepositoryNodeTestProfile,
  executor: RepositoryNodeTestExecutor = executeRepositoryNodeTestContainer,
  signal?: AbortSignal): Promise<RepositoryNodeTestResult> {
  if (!issuedProfiles.has(profile)) throw new Error("Repository Node test profile was not issued");
  if (signal?.aborted === true) return issueResult(profile, "cancelled", "cancelled", [], "not_started", "absent");
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return issueResult(profile, "execution_failed", "input_drift", [], "not_started", "absent");
  }
  const name = `tesota-node-test-${randomUUID()}`;
  const observed = await executor(buildNodeTestContainerInvocation({ candidate: profile.candidate.checkout,
    reporter: profile.verifier.reporter, selectedTest: profile.repository.selectedTest },
  profile.isolation.executable, name), name, signal);
  if (observed.status === "failed") {
    const status = observed.reason === "cancelled" ? "cancelled" : observed.reason === "timeout" ? "timed_out" :
      observed.reason === "spawn_failed" ? "unavailable" : "execution_failed";
    return issueResult(profile, status, observed.reason, [], observed.process, observed.container);
  }
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return issueResult(profile, "execution_failed", "input_drift", [], observed.process, observed.container);
  }
  return observedResult(profile, observed.stdout, observed.stderr, observed.exitCode, observed.signal,
    observed.process, observed.container);
}

export function isIssuedRepositoryNodeTestResult(result: RepositoryNodeTestResult): boolean {
  return issuedResults.has(result);
}
