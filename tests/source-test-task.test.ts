import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask, inspectCandidateTask } from "../src/candidate-task.js";
import { validateProposalRunGrant, type ProposalRunGrant } from "../src/proposal-admission.js";
import { prepareRepositoryNodeTest, runRepositoryNodeTest, type RepositoryNodeTestResult } from "../src/repository-node-test.js";
import { decideTask, reviewTask } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import { piTaskPasses, type PiTaskResult } from "../src/integrations/pi-task.js";

vi.mock("../src/repository-node-test.js", () => ({
  prepareRepositoryNodeTest: vi.fn(async (options: { readonly candidate: string }) => ({ directory: options.candidate })),
  runRepositoryNodeTest: vi.fn(),
}));

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

async function fixture(): Promise<{ root: string; source: string;
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
    proposalSha256: "a".repeat(64), source, baseline: candidate.baseline,
    objective: "Fix the value and add a regression.", completionConditions: ["The value is 2."],
    readFiles: ["lib/value.ts", "tests/value.test.ts"], writeFiles: ["lib/value.ts", "tests/value.test.ts"],
    selectedTest: "tests/value.test.ts", declaredChecks: ["scope-integrity", "node-test-targeted/v1"],
    verification: { scopeIntegrity: "application_owned", nodeTest: "node-test-targeted/v1",
      outcome: "human_review_required" },
  });
  vi.mocked(runRepositoryNodeTest).mockImplementation(async () => {
    const contents = await readFile(join(candidate.checkout, "lib", "value.ts"), "utf8");
    const status = contents.includes("value = 2") ? "passed" : "check_failed";
    return { profile: "node-test-targeted/v1", status, reason: status === "passed" ? null : "diagnostics",
      diagnostics: status === "passed" ? [] : ["expected value 2"], process: "exited", container: "absent",
      binding: {} as never, authority: "none", provenance: "issued" } satisfies RepositoryNodeTestResult;
  });
  return { root, source, candidate, grant };
}

it("retains legacy limits and binds a separate source-and-test contract", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.candidate.directory, current.grant);
  expect(task.describe()).toMatchObject({ task: "typescript-source-test-change", limits: { edits: 6, checks: 6 },
    checks: ["scope-integrity", "node-test-targeted/v1"] });
  expect((await inspectCandidateTask(current.candidate.directory)).promotable).toBe(true);
  task.close();
});

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
      failedCheckSha256: createHash("sha256").update(JSON.stringify(red)).digest("hex") }] };
  expect(piTaskPasses(session, recorded)).toBe(true);
  expect(piTaskPasses({ ...session, checks: [before, { ...red,
    changedFiles: ["lib/value.ts", "tests/value.test.ts"] }, green] }, recorded)).toBe(false);
  const review = await reviewTask(current.candidate.directory);
  expect(review.changedFiles).toEqual(["lib/value.ts", "tests/value.test.ts"]);
  await decideTask(current.candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  const result = await promoteTask(current.candidate.directory, current.source, review.reviewSha256);
  expect(result.files.map((file) => file.path)).toEqual(["lib/value.ts", "tests/value.test.ts"]);
  expect(await readFile(join(current.source, "lib", "value.ts"), "utf8")).toBe("export const value = 2;\n");
  expect(createHash("sha256").update(await readFile(join(current.source, "tests", "value.test.ts"))).digest("hex"))
    .toBe(result.files[1]?.sourceSha256);
  expect(prepareRepositoryNodeTest).toHaveBeenCalled();
}, 60_000);
