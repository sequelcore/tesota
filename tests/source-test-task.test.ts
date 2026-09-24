import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { bindCandidateCheckoutContent, candidateDiff, createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask, inspectCandidateTask } from "../src/candidate-task.js";
import { validateProposalRunGrant, type ProposalRunGrant } from "../src/proposal-admission.js";
import { prepareRepositoryNodeTest, runRepositoryNodeTest,
  type RepositoryNodeTestResult } from "../src/repository-node-test.js";
import { checkRepositoryTypecheck, runRepositoryTypecheck,
  type RepositoryTypecheckResult } from "../src/repository-typecheck.js";
import { decideTask, reviewTask, validateCorrectionParent } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import { PI_SOURCE_TEST_TYPECHECK_LIMITS, piTaskPasses, taskCheckSha256,
  type PiTaskResult } from "../src/integrations/pi-task.js";
import { LIVE_CODEX_MODEL_ID } from "../src/integrations/pi-live.js";

vi.mock("../src/repository-node-test.js", () => ({
  prepareRepositoryNodeTest: vi.fn(async (options: { readonly candidate: string }) => ({ directory: options.candidate })),
  runRepositoryNodeTest: vi.fn(),
  nodeTestProfileFingerprint: vi.fn(() => "a".repeat(64)),
}));
vi.mock("../src/repository-typecheck.js", () => ({ checkRepositoryTypecheck: vi.fn(),
  prepareRepositoryTypecheck: vi.fn(async () => ({ profile: "typescript-no-emit/v1" })),
  runRepositoryTypecheck: vi.fn(),
  typecheckProfileFingerprint: vi.fn(() => "b".repeat(64)) }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error(result.stderr || "Git fixture failed");
  return result.stdout.trim();
}

async function fixture(includeTypecheck = false): Promise<{ root: string; source: string;
  candidate: Awaited<ReturnType<typeof createCandidateCheckout>>; grant: ProposalRunGrant }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-source-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "lib"), { recursive: true });
  await mkdir(join(source, "tests"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ scripts: {
    test: "node --experimental-strip-types --test tests/*.test.ts",
  } }) + "\n");
  await writeFile(join(source, "lib", "value.ts"), "export const value = 1;\n");
  await writeFile(join(source, "tests", "value.test.ts"), "// no regression yet\n");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "--", "package.json", "lib", "tests"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  const grant = validateProposalRunGrant({
    kind: "typescript-source-test-change", proposalId: "b0e37d7c-f19f-4c0c-915c-e52aafea93e7",
    executionEnvironment: "docker-contained",
    proposalSha256: "a".repeat(64), source, baseline: candidate.baseline,
    objective: "Fix the value and add a regression.", completionConditions: ["The value is 2."],
    readFiles: ["lib/value.ts", "tests/value.test.ts"], writeFiles: ["lib/value.ts", "tests/value.test.ts"],
    selectedTest: "tests/value.test.ts", declaredChecks: includeTypecheck ?
      ["scope-integrity", "node-test-targeted/v1", "typescript-no-emit/v1"] :
      ["scope-integrity", "node-test-targeted/v1"],
    verification: { scopeIntegrity: "application_owned", nodeTest: "node-test-targeted/v1",
      typecheck: includeTypecheck ? "typescript-no-emit/v1" : null, outcome: "human_review_required" },
    ...(includeTypecheck ? { approvedChecks: { "node-test-targeted/v1": "a".repeat(64),
      "typescript-no-emit/v1": "b".repeat(64) } } : {}),
  });
  vi.mocked(runRepositoryNodeTest).mockImplementation(async () => {
    const contents = await readFile(join(candidate.checkout, "lib", "value.ts"), "utf8");
    const status = contents.includes("value = 2") ? "passed" : "check_failed";
    const binding = await bindCandidateCheckoutContent(candidate.directory, () => false);
    const selectedTestSha256 = createHash("sha256").update(await readFile(join(candidate.checkout,
      "tests", "value.test.ts"))).digest("hex");
    return { profile: "node-test-targeted/v1", status, reason: status === "passed" ? null : "diagnostics",
      diagnostics: status === "passed" ? [] : ["expected value 2"], process: "exited", container: "absent",
      binding: { candidate: binding, repository: { selectedTestSha256 },
        isolation: { kind: "docker-contained" } } as never,
      authority: "none", provenance: "issued" } satisfies RepositoryNodeTestResult;
  });
  vi.mocked(checkRepositoryTypecheck).mockImplementation(async () => ({
    profile: "typescript-no-emit/v1", status: "passed", reason: null, diagnostics: [],
    process: "exited", container: "absent",
    binding: { candidate: await bindCandidateCheckoutContent(candidate.directory, () => false),
      isolation: { kind: "docker-contained" } } as never,
    authority: "none", provenance: "issued",
  } satisfies RepositoryTypecheckResult));
  vi.mocked(runRepositoryTypecheck).mockImplementation(async () => checkRepositoryTypecheck({
    candidate: candidate.directory, source,
  }));
  return { root, source, candidate, grant };
}

it("retains source-task limits and binds a separate source-and-test contract", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.candidate.directory, current.grant);
  expect(task.describe()).toMatchObject({ task: "typescript-source-test-change", limits: { edits: 6, checks: 6 },
    checks: ["scope-integrity", "node-test-targeted/v1"] });
  expect((await inspectCandidateTask(current.candidate.directory)).sourceInputs).toBeDefined();
  task.close();
});

it("requires both selected checks on the same final source-and-test result", async () => {
  const current = await fixture(true);
  const task = await CandidateTask.prepare(current.candidate.directory, current.grant);
  const source = await task.read({ path: "lib/value.ts" });
  const test = await task.read({ path: "tests/value.test.ts" });
  await task.check();
  await task.replace({ path: "tests/value.test.ts", expectedSha256: test.sha256,
    content: "// regression: expect value 2\n" });
  const red = await task.check();
  expect(red.nodeTest?.status).toBe("check_failed");
  expect(runRepositoryTypecheck).not.toHaveBeenCalled();
  await task.replace({ path: "lib/value.ts", expectedSha256: source.sha256,
    content: "export const value = 2;\n" });
  const green = await task.check();
  expect(green).toMatchObject({ status: "passed", nodeTest: { status: "passed" },
    typecheck: { status: "passed" } });
  expect(green.nodeTest?.binding.candidate.contentSha256)
    .toBe(green.typecheck?.binding.candidate.contentSha256);
  vi.mocked(checkRepositoryTypecheck).mockResolvedValueOnce({
    ...green.typecheck!, status: "check_failed", reason: "diagnostics", diagnostics: ["Type error"],
  });
  const failed = await task.check();
  expect(failed).toMatchObject({ status: "check_failed", outcome: "check_failed",
    nodeTest: { status: "passed" }, typecheck: { status: "check_failed" } });
  vi.mocked(checkRepositoryTypecheck).mockResolvedValueOnce({
    ...green.typecheck!, binding: { ...green.typecheck!.binding,
      candidate: { ...green.typecheck!.binding.candidate, contentSha256: "f".repeat(64) } },
  });
  const mismatched = await task.check();
  expect(mismatched).toMatchObject({ status: "check_failed", outcome: "operational_failed" });
  const typecheckRuns = vi.mocked(runRepositoryTypecheck).mock.calls.length;
  const nodeRunsBeforeReplacement = vi.mocked(runRepositoryNodeTest).mock.calls.length;
  await expect(checkCandidateTask(current.candidate.directory)).rejects.toThrow("no longer applies");
  expect(runRepositoryTypecheck).toHaveBeenCalledTimes(typecheckRuns);
  expect(runRepositoryNodeTest).toHaveBeenCalledTimes(nodeRunsBeforeReplacement);
  task.close();
}, 60_000);

it("reviews combined retained evidence above five minutes and rejects an excess over ten", async () => {
  const current = await fixture(true);
  const task = await CandidateTask.prepare(current.candidate.directory, current.grant);
  const source = await task.read({ path: "lib/value.ts" });
  const test = await task.read({ path: "tests/value.test.ts" });
  const before = await task.check();
  await task.replace({ path: "tests/value.test.ts", expectedSha256: test.sha256,
    content: "// regression: expect value 2\n" });
  const red = await task.check();
  await task.replace({ path: "lib/value.ts", expectedSha256: source.sha256,
    content: "export const value = 2;\n" });
  const green = await task.check();
  task.close();
  const recorded = await checkCandidateTask(current.candidate.directory);
  const diff = await candidateDiff(current.candidate.directory);
  await writeFile(join(current.candidate.directory, "candidate.diff"), diff);
  const timestamp = new Date().toISOString();
  const executor = Object.fromEntries([
    "task-run.js", "candidate-checkout.js", "candidate-task.js", "task-contract.js", "task-source.js",
    "semantic-revision.js", "repository-check-input.js", "proposal-admission.js", "repository-typecheck.js",
    "repository-typecheck-process.js", "command-isolation.js", "verification/invocation-admission.js",
    "integrations/pi-task.js", "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock",
  ].map((path) => [path, "8".repeat(64)]));
  const started = { format: "tesota-task-attempt", version: 1, state: "started", timestamp,
    baseline: current.candidate.baseline, sourceDirty: false, executor, model: LIVE_CODEX_MODEL_ID,
    limits: PI_SOURCE_TEST_TYPECHECK_LIMITS, taskAcceptance: "not_evaluated",
    executionCause: "initial_implementation" };
  const session: PiTaskResult = { status: "completed", modelInvocations: 10, toolCalls: 10, edits: 2,
    checks: [before, red, green], checksSuppliedToModel: 3, finalCheckSuppliedToModel: true,
    deadlineExpired: false, settlement: "observed", denied: false, terminalStopReason: "stop",
    taskAcceptance: "not_evaluated", executionCause: "initial_implementation", activeMs: 300_001,
    editCauses: [{ cause: "initial_implementation" }, { cause: "diagnostic_repair",
      failedCheckSha256: taskCheckSha256(red) }] };
  const attempt = (usage: PiTaskResult) => [started, { state: "finished", timestamp, outcome: "passed",
    session: usage, current: recorded, reviewSaved: true, taskAcceptance: "not_evaluated" }]
    .map((event) => JSON.stringify(event)).join("\n") + "\n";
  const attemptPath = join(current.candidate.directory, "attempt.jsonl");
  const retained = attempt(session);
  await writeFile(attemptPath, retained);
  expect(piTaskPasses(session, recorded)).toBe(true);
  expect(green.writeSetSha256).toBe(recorded.writeSetSha256);
  expect(isDeepStrictEqual({ ...green, provenance: "recorded_untrusted" }, recorded)).toBe(true);
  const review = await reviewTask(current.candidate.directory);
  const identity = { parentReviewSha256: review.reviewSha256,
    parentWriteSetSha256: recorded.writeSetSha256,
    parentCheckSha256: createHash("sha256").update(JSON.stringify(recorded)).digest("hex"),
    parentAttemptSha256: createHash("sha256").update(retained).digest("hex"),
    taskDefinitionSha256: task.describe().definitionSha256 };
  await expect(validateCorrectionParent(current.candidate.directory, identity)).resolves.toMatchObject({
    attemptSha256: identity.parentAttemptSha256,
  });
  const excess = attempt({ ...session, activeMs: 600_001 });
  await writeFile(attemptPath, excess);
  await expect(validateCorrectionParent(current.candidate.directory, {
    ...identity, parentAttemptSha256: createHash("sha256").update(excess).digest("hex"),
  })).rejects.toThrow();
}, 60_000);

it("keeps the red regression, green repair, current review and exact two-file promotion distinct", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.candidate.directory, current.grant);
  const source = await task.read({ path: "lib/value.ts" });
  const test = await task.read({ path: "tests/value.test.ts" });
  const before = await task.check();
  expect(before.status).toBe("check_failed");
  await task.replace({ path: "tests/value.test.ts", expectedSha256: test.sha256,
    content: "// regression: expect value 2\n" });
  const red = await task.check();
  expect(red).toMatchObject({ status: "check_failed", nodeTest: { status: "check_failed" },
    changedFiles: ["tests/value.test.ts"], selectedTest: "tests/value.test.ts" });
  await task.replace({ path: "lib/value.ts", expectedSha256: source.sha256,
    content: "export const value = 2;\n" });
  const green = await task.check();
  expect(green).toMatchObject({ status: "passed", nodeTest: { status: "passed" }, typecheck: null });
  task.close();
  const recorded = await checkCandidateTask(current.candidate.directory);
  expect(recorded.writeSetSha256).toBe(green.writeSetSha256);
  const session: PiTaskResult = { status: "completed", modelInvocations: 10, toolCalls: 10, edits: 2,
    checks: [before, red, green], checksSuppliedToModel: 3, finalCheckSuppliedToModel: true,
    deadlineExpired: false, settlement: "observed", denied: false, terminalStopReason: "stop",
    taskAcceptance: "not_evaluated", executionCause: "initial_implementation", activeMs: 100,
    editCauses: [{ cause: "initial_implementation" }, { cause: "diagnostic_repair",
      failedCheckSha256: taskCheckSha256(red) }] };
  expect(piTaskPasses(session, recorded)).toBe(true);
  expect(piTaskPasses({ ...session, checks: [before, { ...red,
    changedFiles: ["lib/value.ts", "tests/value.test.ts"] }, green] }, recorded)).toBe(false);
  const nodeRuns = vi.mocked(runRepositoryNodeTest).mock.calls.length;
  const review = await reviewTask(current.candidate.directory);
  expect(review.changedFiles).toEqual(["lib/value.ts", "tests/value.test.ts"]);
  await decideTask(current.candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  const result = await promoteTask(current.candidate.directory, current.source, review.reviewSha256);
  expect(runRepositoryNodeTest).toHaveBeenCalledTimes(nodeRuns);
  expect(result.files.map((file) => file.path)).toEqual(["lib/value.ts", "tests/value.test.ts"]);
  expect(await readFile(join(current.source, "lib", "value.ts"), "utf8")).toBe("export const value = 2;\n");
  expect(createHash("sha256").update(await readFile(join(current.source, "tests", "value.test.ts"))).digest("hex"))
    .toBe(result.files[1]?.sourceSha256);
  expect(prepareRepositoryNodeTest).toHaveBeenCalled();
}, 60_000);
