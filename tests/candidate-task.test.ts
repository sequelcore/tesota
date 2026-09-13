import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall,
  type Context, type FauxResponseStep } from "@earendil-works/pi-ai";
import { PI_TASK_LIMITS, piTaskPasses, runPiTask } from "../src/integrations/pi-task.js";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask } from "../src/candidate-task.js";
import { CANDIDATE_TASK_LIMITS, PI_DECISION_TASK_STATUS } from "../src/candidate-task-definition.js";
import { reviewTask, decideTask } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import { prepareTaskRecovery } from "../src/task-run.js";
import { expectedMultiFileTask } from "../src/multi-file-task-check.js";
import type { ProposalRunGrant } from "../src/proposal-admission.js";
import { CODE_PROPOSAL_TEST_FILE, proposedCodeTaskDefinition } from "../src/proposed-code-task.js";

const editedFile = "docs/decisions/002-use-pi.md";
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (result.status !== 0) throw new Error("Fixture Git failed");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-task-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  git(source, ["init", "--quiet"]);
  for (const path of [editedFile, "docs/roadmap.md", "experiments/codex/history.md", "src/cli.ts", "src/integrations/pi-task.ts",
    "src/verification/candidate.ts", "src/verification/invocation-admission.ts", "README.md", "docs/identity.md",
    "tests/candidate-task.test.ts", CODE_PROPOSAL_TEST_FILE]) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), await readFile(new URL("../" + path, import.meta.url)));
  }
  git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "--quiet", "-m", "Task baseline"]);
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  return { source, ...candidate };
}

function proposalGrant(candidate: Awaited<ReturnType<typeof fixture>>): ProposalRunGrant {
  return {
    kind: "proposal-documentation", proposalId: "b0e37d7c-f19f-4c0c-915c-e52aafea93e7",
    proposalSha256: "a".repeat(64), source: candidate.source, baseline: candidate.baseline,
    objective: "Add a plain-language operator note.",
    completionConditions: ["The note explains the behavior without internal jargon."],
    readFiles: ["docs/identity.md"], writeFiles: ["docs/identity.md"],
    declaredChecks: ["repository-check"],
    verification: { scopeIntegrity: "application_owned", repositoryCheck: "not_executed_in_first_slice" },
  };
}

function codeProposalGrant(candidate: Awaited<ReturnType<typeof fixture>>): ProposalRunGrant {
  const definition = proposedCodeTaskDefinition();
  return {
    kind: "proposal-code", task: "pi-result-consistency",
    proposalId: "26ff8867-86b9-4b05-8cc0-96343fb5204c", proposalSha256: "b".repeat(64),
    source: candidate.source, baseline: candidate.baseline,
    objective: definition.objective,
    completionConditions: [definition.oracle],
    readFiles: ["src/integrations/pi-task.ts", CODE_PROPOSAL_TEST_FILE],
    writeFiles: ["src/integrations/pi-task.ts", CODE_PROPOSAL_TEST_FILE],
    declaredChecks: ["pi-result-consistency"],
    verification: { scopeIntegrity: "application_owned", behaviorCheck: "pinned_container" },
  };
}

function correction(content: string): string {
  return content.replace(/Status:[\s\S]*?(?=\n\n## Decision and rationale)/, PI_DECISION_TASK_STATUS);
}

it("prepares code scope independently of the documentation task and denies other files", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "pi-result-consistency");
  expect(task.describe()).toMatchObject({ task: "pi-result-consistency", writeFiles: ["src/integrations/pi-task.ts"] });
  expect(task.describe().instructions).toContain("numeric bounds 10, 13 and 2");
  expect((await task.read({ path: "src/integrations/pi-task.ts" })).content).toContain("piTaskPasses");
  await expect(task.read({ path: editedFile })).rejects.toThrow("denied");
});

it.runIf(process.platform === "win32")("binds a proposed code grant to the registered objective, test context and trusted check", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepareProposal(candidate.directory, codeProposalGrant(candidate));
  expect(task.describe()).toMatchObject({
    task: "proposal-code",
    objective: expect.stringContaining("piTaskPasses"),
    readFiles: ["src/integrations/pi-task.ts", CODE_PROPOSAL_TEST_FILE],
    writeFiles: ["src/integrations/pi-task.ts", CODE_PROPOSAL_TEST_FILE],
  });
  const source = await task.read({ path: "src/integrations/pi-task.ts" });
  const test = await task.read({ path: CODE_PROPOSAL_TEST_FILE });
  expect(test.content).toContain("piTaskPasses");
  expect((await task.check()).status).toBe("check_failed");
  const corrected = source.content
    .replace("{ value: result.modelInvocations, maximum: 8 }",
      "{ value: result.modelInvocations, maximum: 10 }")
    .replace("typeof check.writeSetSha256 === \"string\" && check.writeSetSha256.length > 0),",
      "typeof check.writeSetSha256 === \"string\" && check.writeSetSha256.length > 0 &&\n" +
      "      check.taskAcceptance === \"not_evaluated\"),")
    .replace("current.status === \"passed\",",
      "current.status === \"passed\",\n    current.provenance === \"recorded_untrusted\",\n" +
      "    current.taskAcceptance === \"not_evaluated\",");
  await task.replace({ path: "src/integrations/pi-task.ts", expectedSha256: source.sha256, content: corrected });
  expect(await task.check()).toMatchObject({ status: "check_failed",
    diagnostics: expect.arrayContaining(["The admitted regression test must preserve its baseline and append focused cases"]) });
  await task.replace({ path: CODE_PROPOSAL_TEST_FILE, expectedSha256: test.sha256,
    content: test.content + "\n// Proposed task regression coverage.\n" });
  expect((await task.check()).status).toBe("passed");
  task.close();
  const review = await reviewTask(candidate.directory);
  expect(review).toMatchObject({ check: { task: "proposal-code", status: "passed" } });
  const decided = await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  expect(decided.operatorDecision?.applicability).toBe("current");
  await expect(promoteTask(candidate.directory, candidate.source, review.reviewSha256)).resolves.toMatchObject({
    status: "applied", files: [
      { path: "src/integrations/pi-task.ts" },
      { path: CODE_PROPOSAL_TEST_FILE },
    ],
  });
  expect(await readFile(join(candidate.source, "src/integrations/pi-task.ts"), "utf8")).toBe(corrected);
}, 60_000);

it.runIf(process.platform === "win32")("rejects a proposed source that omits result acceptance", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepareProposal(candidate.directory, codeProposalGrant(candidate));
  const source = await task.read({ path: "src/integrations/pi-task.ts" });
  await task.check();
  const weakened = source.content.replace('    result.taskAcceptance === "not_evaluated",\n', "");
  expect(weakened).not.toBe(source.content);
  await task.replace({ path: "src/integrations/pi-task.ts", expectedSha256: source.sha256, content: weakened });
  expect(await task.check()).toMatchObject({ status: "check_failed",
    diagnostics: expect.arrayContaining(["result acceptance"]) });
  task.close();
}, 30_000);

it("rejects a persisted code grant whose canonical objective is rewritten", async () => {
  const candidate = await fixture();
  await CandidateTask.prepareProposal(candidate.directory, codeProposalGrant(candidate));
  const path = join(candidate.directory, "task.json");
  const plan = JSON.parse(await readFile(path, "utf8"));
  plan.grant.objective = "Rewritten persisted objective";
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n");

  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("canonical");
});

it("returns LemmaScript diagnostics and accepts the corrected formal task", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "formal-invocation-admission");
  const seeded = await task.read({ path: "src/verification/invocation-admission.ts" });
  expect((await task.check()).status).toBe("check_failed");
  const corrected = await readFile(new URL("../src/verification/invocation-admission.ts", import.meta.url), "utf8");
  await task.replace({ path: "src/verification/invocation-admission.ts", expectedSha256: seeded.sha256, content: corrected });
  expect((await task.check()).status).toBe("passed");
  task.close();
}, 30_000);

it("executes a registered TypeScript correction without task-specific engine branches", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "candidate-source-newline");
  const description = task.describe();
  expect(description).toMatchObject({
    task: "candidate-source-newline",
    readFiles: ["src/verification/candidate.ts"],
    writeFiles: ["src/verification/candidate.ts"],
    oracle: "Exact baseline restoration of optional-final-LF candidate acceptance while preserving every other byte.",
  });
  const seeded = await task.read({ path: "src/verification/candidate.ts" });
  expect(seeded.content).toContain("source === CANDIDATE_EXPECTED_SOURCE &&");
  expect(await task.check()).toMatchObject({
    status: "check_failed",
    diagnostics: ["Candidate source must accept the expected declaration with or without its final LF"],
  });
  const corrected = await readFile(new URL("../src/verification/candidate.ts", import.meta.url), "utf8");
  await task.replace({ path: "src/verification/candidate.ts", expectedSha256: seeded.sha256, content: corrected });
  expect((await task.check()).status).toBe("passed");
  expect(JSON.parse(await readFile(join(candidate.directory, "task.json"), "utf8"))).toMatchObject({
    version: 3,
    task: "candidate-source-newline",
    definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    contract: {
      oracleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      readFiles: ["src/verification/candidate.ts"],
      writeFiles: ["src/verification/candidate.ts"],
      effects: ["read_candidate", "replace_candidate_file", "run_task_check"],
      promotion: "denied",
    },
  });
  task.close();
}, 30_000);

it("binds, checks, reviews and promotes one registered two-file write set", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "multi-file-task-status");
  expect(task.describe()).toMatchObject({
    task: "multi-file-task-status",
    readFiles: ["README.md", "docs/identity.md"],
    writeFiles: ["README.md", "docs/identity.md"],
  });
  const readme = await task.read({ path: "README.md" });
  const identity = await task.read({ path: "docs/identity.md" });
  const expected = expectedMultiFileTask({ "README.md": readme.content, "docs/identity.md": identity.content });
  const before = await task.check();
  expect(before).toMatchObject({ status: "check_failed", writeSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await task.replace({ path: "README.md", expectedSha256: readme.sha256,
    content: expected["README.md"] });
  await task.replace({ path: "docs/identity.md", expectedSha256: identity.sha256,
    content: expected["docs/identity.md"] });
  const after = await task.check();
  expect(after.status).toBe("passed");
  expect(after.writeSetSha256).not.toBe(before.writeSetSha256);
  task.close();

  const review = await reviewTask(candidate.directory);
  await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  const promoted = await promoteTask(candidate.directory, candidate.source, review.reviewSha256);
  expect(promoted.files.map((file) => file.path)).toEqual(["README.md", "docs/identity.md"]);
  expect(await readFile(join(candidate.source, "README.md"), "utf8")).toBe(expected["README.md"]);
  expect(await readFile(join(candidate.source, "docs/identity.md"), "utf8")).toBe(expected["docs/identity.md"]);
  expect(await readFile(join(candidate.directory, "promotion.jsonl"), "utf8"))
    .toContain('"version":2');
}, 60_000);

it("validates every multi-file promotion target before changing any source file", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory, "multi-file-task-status");
  const inputs: Record<string, { content: string; sha256: string }> = {};
  for (const path of ["README.md", "docs/identity.md"]) {
    const input = await task.read({ path });
    inputs[path] = input;
  }
  const expected = expectedMultiFileTask(Object.fromEntries(Object.entries(inputs).map(([path, input]) => [path, input.content])));
  for (const path of ["README.md", "docs/identity.md"] as const) {
    const input = inputs[path];
    if (input === undefined) throw new Error("Missing multi-file test input");
    await task.check().catch(() => {});
    await task.replace({ path, expectedSha256: input.sha256,
      content: expected[path] });
  }
  task.close();
  const review = await reviewTask(candidate.directory);
  await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  const readmeBefore = await readFile(join(candidate.source, "README.md"));
  await writeFile(join(candidate.source, "docs/identity.md"), "conflicting operator work\n");
  await expect(promoteTask(candidate.directory, candidate.source, review.reviewSha256)).rejects.toThrow();
  expect(await readFile(join(candidate.source, "README.md"))).toEqual(readmeBefore);
}, 60_000);

async function acceptedCandidate() {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) });
  task.close();
  const review = await reviewTask(candidate.directory);
  await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  return { ...candidate, review, original: input.content };
}

it("promotes through the CLI while preserving unrelated source edits, index and refs", async () => {
  const candidate = await acceptedCandidate();
  await writeFile(join(candidate.source, "src/cli.ts"), "unrelated edit");
  const index = await readFile(join(candidate.source, ".git/index"));
  const head = await readFile(join(candidate.source, ".git/HEAD"));
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = spawnSync("bun", ["--no-env-file", entry, "task", "promote", candidate.directory, candidate.review.reviewSha256], {
    cwd: candidate.source, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("applied");
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(correction(candidate.original));
  expect(await readFile(join(candidate.source, "src/cli.ts"), "utf8")).toBe("unrelated edit");
  expect(await readFile(join(candidate.source, ".git/index"))).toEqual(index);
  expect(await readFile(join(candidate.source, ".git/HEAD"))).toEqual(head);
  expect(await readFile(join(candidate.directory, "promotion.jsonl"), "utf8")).toContain('"state":"applied"');
  await expect(promoteTask(candidate.directory, candidate.source, candidate.review.reviewSha256)).rejects.toThrow();
}, 60_000);

it.each(["working", "index", "revision", "candidate", "wrong_source", "journal"] as const)(
  "refuses promotion after %s changes without overwriting source", async (change) => {
    const candidate = await acceptedCandidate();
    const target = join(candidate.source, editedFile);
    if (change === "working") await writeFile(target, "newer work");
    if (change === "index" || change === "revision") {
      await writeFile(target, "staged work");
      git(candidate.source, ["add", editedFile]);
      if (change === "revision") git(candidate.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--no-gpg-sign", "--quiet", "-m", "Newer source"]);
      await writeFile(target, candidate.original);
    }
    if (change === "candidate") await writeFile(join(candidate.checkout, editedFile), "changed candidate");
    if (change === "journal") await writeFile(join(candidate.directory, "promotion.jsonl"), '{"state":"started"}\n');
    const before = await readFile(target);
    await expect(promoteTask(candidate.directory, change === "wrong_source" ? candidate.checkout : candidate.source,
      candidate.review.reviewSha256)).rejects.toThrow();
    expect(await readFile(target)).toEqual(before);
  }, 60_000);

it("does not promote a passing candidate without explicit acceptance", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory)).close();
  const original = await readFile(join(candidate.source, editedFile), "utf8");
  await writeFile(join(candidate.checkout, editedFile), correction(original));
  const review = await reviewTask(candidate.directory);
  await expect(promoteTask(candidate.directory, candidate.source, review.reviewSha256)).rejects.toThrow("accepted");
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(original);
}, 30_000);

it("records acceptance for reviewed bytes separately from check evidence and refuses to overwrite it", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) });
  task.close();
  const review = await reviewTask(candidate.directory);
  expect(review).toMatchObject({ operatorDecision: null, historicalAttempt: "not_evaluated" });
  expect(review.diff).toContain("+Coding Agent host task and an immutable four-lens Gentle review have also");
  const accepted = await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  expect(accepted.operatorDecision).toMatchObject({ provenance: "recorded_untrusted", applicability: "current",
    record: { decision: "accept", authority: "local_operator_assertion" } });
  expect(accepted.check.taskAcceptance).toBe("not_evaluated");
  await expect(decideTask(candidate.directory, { decision: "reject", reviewSha256: review.reviewSha256 })).rejects.toThrow("already exists");
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(input.content);
  await writeFile(join(candidate.checkout, editedFile), input.content);
  const stale = await reviewTask(candidate.directory);
  expect(stale.operatorDecision?.applicability).toBe("stale");
  expect(stale.check.status).toBe("check_failed");
}, 60_000);

it("rejects a stale review and refuses acceptance based on forged saved success or diff claims", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const original = await task.read({ path: editedFile });
  task.close();
  await writeFile(join(candidate.directory, "attempt.jsonl"), '{"outcome":"passed"}\n');
  await writeFile(join(candidate.directory, "candidate.diff"), "Forged successful diff");
  const before = await reviewTask(candidate.directory);
  expect(before.diff).toBe("");
  await expect(decideTask(candidate.directory, { decision: "accept", reviewSha256: before.reviewSha256 })).rejects.toThrow("passing current check");
  await writeFile(join(candidate.checkout, editedFile), correction(original.content));
  await expect(decideTask(candidate.directory, { decision: "accept", reviewSha256: before.reviewSha256 })).rejects.toThrow("stale");
  await expect(readFile(join(candidate.directory, "decision.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("allows rejecting a failed candidate through the compiled CLI without granting acceptance", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory)).close();
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const review = spawnSync("bun", ["--no-env-file", entry, "task", "review", candidate.directory], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  expect(review.status).toBe(0);
  const fingerprint: unknown = JSON.parse(review.stdout).reviewSha256;
  if (typeof fingerprint !== "string") throw new Error("Missing review fingerprint");
  const decision = spawnSync("bun", ["--no-env-file", entry, "task", "decide", candidate.directory, "reject", fingerprint], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  expect(decision.status).toBe(0);
  expect(JSON.parse(decision.stdout)).toMatchObject({
    check: { status: "check_failed", taskAcceptance: "not_evaluated" },
    operatorDecision: { record: { decision: "reject" }, applicability: "current" },
  });
}, 30_000);

it("rejects malformed decisions and scope changes instead of presenting a current acceptance", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory)).close();
  await expect(decideTask(candidate.directory, { decision: "accept", reviewSha256: "0".repeat(64), authority: "model" })).rejects.toThrow();
  await writeFile(join(candidate.directory, "decision.json"), '{"decision":"accept","authority":"human"}');
  await expect(reviewTask(candidate.directory)).rejects.toThrow();
  await writeFile(join(candidate.directory, "decision.json"), " ".repeat(4097));
  await expect(reviewTask(candidate.directory)).rejects.toThrow("unavailable");
  await writeFile(join(candidate.checkout, "src/cli.ts"), "out of scope");
  await expect(reviewTask(candidate.directory)).rejects.toThrow("scope");
}, 30_000);

function fakeModel(steps: FauxResponseStep[]) {
  const fake = fauxProvider({ models: [{ id: "task-test", name: "Task test" }], tokensPerSecond: 1_000_000 });
  fake.setResponses(steps);
  return { model: fake.getModel(), stream: vi.fn(fake.provider.streamSimple) };
}

function modelReplacement(
  context: Context,
  path: string,
  transform: (content: string) => string,
) {
  const read = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "tesota_read");
  if (read?.role !== "toolResult") throw new Error("Missing tool result");
  const text = read?.content.find((block) => block.type === "text");
  if (text?.type !== "text") throw new Error("Missing model context");
  const input: unknown = JSON.parse(text.text);
  if (typeof input !== "object" || input === null || !("content" in input) || typeof input.content !== "string" ||
      !("sha256" in input) || typeof input.sha256 !== "string") throw new Error("Invalid model context");
  return fauxAssistantMessage(fauxToolCall("tesota_replace", {
    path, expectedSha256: input.sha256, content: transform(input.content),
  }));
}

function modelCorrection(context: Context) {
  return modelReplacement(context, editedFile, correction);
}

it("executes a Pi repository task and distinguishes model completion from applicable checks", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: editedFile })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    modelCorrection,
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage("Done."),
  ]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  const current = await checkCandidateTask(candidate.directory);
  expect(result).toMatchObject({ status: "completed", modelInvocations: 5, toolCalls: 4, edits: 1,
    checksSuppliedToModel: 2, finalCheckSuppliedToModel: true, denied: false, deadlineExpired: false });
  expect(piTaskPasses(result, current)).toBe(true);
  expect(piTaskPasses({ ...result, finalCheckSuppliedToModel: false }, current)).toBe(false);
  expect(piTaskPasses(result, { ...current, writeSetSha256: "0".repeat(64) })).toBe(false);
  expect(fake.stream.mock.calls[0]?.[1].systemPrompt).toContain("Run tesota_check before the first replacement");
  await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
}, 30_000);

it("re-reads a file before a second Pi correction after an edited check fails", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: editedFile })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    (context) => modelReplacement(context, editedFile, (content) => correction(content) + "\nUnrequested text\n"),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: editedFile })),
    (context) => modelReplacement(context, editedFile, (content) =>
      correction(content).replace(/\n+Unrequested text\n$/u, "\n")),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage("Done."),
  ]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  const current = await checkCandidateTask(candidate.directory);
  expect(result).toMatchObject({ status: "completed", modelInvocations: 8, toolCalls: 7, edits: 2,
    checks: [{ status: "check_failed" }, { status: "check_failed" }, { status: "passed" }] });
  expect(piTaskPasses(result, current)).toBe(true);
}, 30_000);

it("runs a second registered task through the same Pi tools and evidence predicate", async () => {
  const candidate = await fixture();
  const file = "src/verification/candidate.ts";
  const task = await CandidateTask.prepare(candidate.directory, "candidate-source-newline");
  const fake = fakeModel([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: file })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    (context) => modelReplacement(context, file, (content) =>
      content.replace("source === CANDIDATE_EXPECTED_SOURCE &&",
        "source === CANDIDATE_EXPECTED_SOURCE ||")),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage("Done."),
  ]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  const current = await checkCandidateTask(candidate.directory);
  expect(result).toMatchObject({
    status: "completed",
    modelInvocations: 5,
    toolCalls: 4,
    edits: 1,
    checksSuppliedToModel: 2,
    finalCheckSuppliedToModel: true,
  });
  expect(result.checks.map((check) => check.status)).toEqual(["check_failed", "passed"]);
  expect(piTaskPasses(result, current)).toBe(true);
}, 30_000);

it("prepares a fresh successor for failed task recovery without inheriting candidate bytes or evidence", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory, "candidate-source-newline")).close();
  const started = { format: "tesota-task-attempt", version: 1, state: "started",
    timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: false,
    executor: {}, model: "gpt-5.6-luna", limits: PI_TASK_LIMITS, taskAcceptance: "not_evaluated" };
  const finished = { state: "finished", timestamp: new Date().toISOString(), outcome: "failed",
    session: null, current: null, reviewSaved: true, taskAcceptance: "not_evaluated" };
  await writeFile(join(candidate.directory, "attempt.jsonl"), `${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`);
  await writeFile(join(candidate.directory, "candidate.diff"), "historical untrusted bytes\n");

  const recovery = await prepareTaskRecovery(candidate.directory);

  expect(recovery.taskId).toBe("candidate-source-newline");
  expect(recovery.predecessor).toBe(candidate.directory);
  expect(recovery.candidate.baseline).toBe(candidate.baseline);
  expect(recovery.candidate.directory).not.toBe(candidate.directory);
  expect(await readFile(join(recovery.candidate.checkout, "src/verification/candidate.ts"), "utf8"))
    .toBe(await readFile(new URL("../src/verification/candidate.ts", import.meta.url), "utf8"));
  await expect(readFile(join(recovery.candidate.directory, "attempt.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(recovery.candidate.directory, "candidate.diff"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("recovers an incomplete task attempt conservatively and refuses a recorded success", async () => {
  const incomplete = await fixture();
  (await CandidateTask.prepare(incomplete.directory, "candidate-source-newline")).close();
  const started = { format: "tesota-task-attempt", version: 1, state: "started",
    timestamp: new Date().toISOString(), baseline: incomplete.baseline, sourceDirty: false,
    executor: {}, model: "gpt-5.6-luna", limits: PI_TASK_LIMITS, taskAcceptance: "not_evaluated" };
  await writeFile(join(incomplete.directory, "attempt.jsonl"), `${JSON.stringify(started)}\n{"state":"fin`);
  await expect(prepareTaskRecovery(incomplete.directory)).resolves.toMatchObject({ priorOutcome: "incomplete" });

  const successful = await fixture();
  (await CandidateTask.prepare(successful.directory, "candidate-source-newline")).close();
  const successStarted = { ...started, baseline: successful.baseline };
  const finished = { state: "finished", timestamp: new Date().toISOString(), outcome: "passed",
    session: null, current: null, reviewSaved: true, taskAcceptance: "not_evaluated" };
  await writeFile(join(successful.directory, "attempt.jsonl"),
    `${JSON.stringify(successStarted)}\n${JSON.stringify(finished)}\n`);
  const before = await readdir(dirname(successful.directory));
  await expect(prepareTaskRecovery(successful.directory)).rejects.toThrow("Successful task attempts cannot be recovered");
  expect(await readdir(dirname(successful.directory))).toEqual(before);

  const decided = await fixture();
  (await CandidateTask.prepare(decided.directory, "candidate-source-newline")).close();
  await writeFile(join(decided.directory, "attempt.jsonl"), `${JSON.stringify({ ...started, baseline: decided.baseline })}\n`);
  await writeFile(join(decided.directory, "decision.json"), JSON.stringify({ decision: "reject" }));
  await expect(prepareTaskRecovery(decided.directory)).rejects.toThrow("undecided candidate");
}, 30_000);

it("refuses recovery before successor creation when the predecessor escaped task scope", async () => {
  const candidate = await fixture();
  (await CandidateTask.prepare(candidate.directory, "candidate-source-newline")).close();
  const started = { format: "tesota-task-attempt", version: 1, state: "started",
    timestamp: new Date().toISOString(), baseline: candidate.baseline, sourceDirty: false,
    executor: {}, model: "gpt-5.6-luna", limits: PI_TASK_LIMITS, taskAcceptance: "not_evaluated" };
  const finished = { state: "finished", timestamp: new Date().toISOString(), outcome: "failed",
    session: null, current: null, reviewSaved: false, taskAcceptance: "not_evaluated" };
  await writeFile(join(candidate.directory, "attempt.jsonl"), `${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`);
  await writeFile(join(candidate.checkout, "src/cli.ts"), "out of scope\n");
  const root = dirname(candidate.directory);
  const before = await readdir(root);

  await expect(prepareTaskRecovery(candidate.directory)).rejects.toThrow("scope changed");
  expect(await readdir(root)).toEqual(before);
}, 30_000);

it.each([
  { name: "tesota_replace", args: { path: "../outside", expectedSha256: "0".repeat(64), content: "SYNTHETIC_PRIVATE" } },
  { name: "tesota_check", args: { command: "SYNTHETIC_PRIVATE" } },
  { name: "unknown", args: {} },
])("denies malformed or unknown model tools and closes further authority: $name", async ({ name, args }) => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([fauxAssistantMessage(fauxToolCall(name, args)), fauxAssistantMessage("Done.")]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", edits: 0, checks: [], denied: true });
  expect(fake.stream).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
  expect(await readFile(join(candidate.checkout, editedFile))).toEqual(await readFile(join(candidate.source, editedFile)));
});

it("executes, reviews and promotes an admitted documentation grant while reporting its check limitation", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepareProposal(candidate.directory, proposalGrant(candidate));
  expect(task.describe()).toMatchObject({ task: "proposal-documentation", writeFiles: ["docs/identity.md"] });
  const input = await task.read({ path: "docs/identity.md" });
  expect(await task.check()).toMatchObject({ status: "check_failed",
    diagnostics: [expect.stringContaining("Repository check not executed")] });
  const updated = input.content + "\nThe operator reviews the exact candidate diff before promotion.\n";
  await task.replace({ path: "docs/identity.md", expectedSha256: input.sha256, content: updated });
  expect(await task.check()).toMatchObject({ status: "passed",
    diagnostics: [expect.stringContaining("review must judge")] });
  task.close();
  const review = await reviewTask(candidate.directory);
  expect(review).toMatchObject({ check: { task: "proposal-documentation", status: "passed" } });
  await decideTask(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  await expect(promoteTask(candidate.directory, candidate.source, review.reviewSha256)).resolves.toMatchObject({
    status: "applied", files: [{ path: "docs/identity.md" }],
  });
  expect(await readFile(join(candidate.source, "docs/identity.md"), "utf8")).toBe(updated);
}, 60_000);

it("rejects a modified persisted proposal grant without reopening task authority", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepareProposal(candidate.directory, proposalGrant(candidate));
  task.close();
  const path = join(candidate.directory, "task.json");
  const plan = JSON.parse(await readFile(path, "utf8")) as { grant: { objective: string } };
  plan.grant.objective = "Replace a different document.";
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n");
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("invalid");
});

it("does not pass a model's unsupported completion claim", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const fake = fakeModel([fauxAssistantMessage("All checks passed. Accepted.")]);
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(piTaskPasses(result, await checkCandidateTask(candidate.directory))).toBe(false);
  expect(result.taskAcceptance).toBe("not_evaluated");
});

it("bounds model continuations independently of the permitted read budget", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const admittedReads = CANDIDATE_TASK_LIMITS.reads + 1;
  const fake = fakeModel(Array.from({ length: admittedReads }, () => fauxAssistantMessage(fauxToolCall("tesota_read", { path: editedFile }))));
  const result = await runPiTask(task, fake.model, fake.stream, new AbortController().signal);
  expect(result).toMatchObject({ status: "failed", denied: true, modelInvocations: admittedReads });
  expect(fake.stream).toHaveBeenCalledTimes(admittedReads);
}, 30_000);

it.each(["deadline", "interrupt"] as const)("closes authority when a stream will not settle after %s", async (reason) => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const model = fakeModel([]).model;
  const cancellation = new AbortController();
  const stream = createAssistantMessageEventStream();
  vi.useFakeTimers();
  const running = runPiTask(task, model, () => stream, cancellation.signal);
  if (reason === "interrupt") {
    await vi.advanceTimersByTimeAsync(0);
    cancellation.abort();
  }
  await vi.advanceTimersByTimeAsync(reason === "deadline" ? PI_TASK_LIMITS.sessionMs + PI_TASK_LIMITS.settlementMs : PI_TASK_LIMITS.settlementMs);
  const result = await running;
  expect(result).toMatchObject({ status: "unsettled", deadlineExpired: reason === "deadline" });
  await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
  const snapshot = JSON.stringify(result);
  const message = fauxAssistantMessage("Late completion");
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.stringify(result)).toBe(snapshot);
});

it("permits the exact documentation correction, binds its checks to bytes and preserves the source", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  const before = await task.check();
  expect(before).toMatchObject({ status: "check_failed", provenance: "issued", taskAcceptance: "not_evaluated" });
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) });
  const after = await task.check();
  expect(after.status).toBe("passed");
  expect(after.writeSetSha256).not.toBe(before.writeSetSha256);
  expect(await readFile(join(candidate.source, editedFile), "utf8")).toBe(input.content);
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(correction(input.content));
  task.close();
  expect(await checkCandidateTask(candidate.directory)).toMatchObject({ status: "passed", provenance: "recorded_untrusted" });
  await expect(task.replace({ path: editedFile, expectedSha256: after.writeSetSha256, content: input.content })).rejects.toThrow("closed");
  await writeFile(join(candidate.checkout, editedFile), input.content);
  expect((await checkCandidateTask(candidate.directory)).status).toBe("check_failed");
}, 30_000);

it.each(["../source/docs/decisions/002-use-pi.md", ".git/config", "docs\\decisions\\002-use-pi.md", "src/cli.ts"])(
  "rejects a write to %s before any file mutation", async (path) => {
    const candidate = await fixture();
    const task = await CandidateTask.prepare(candidate.directory);
    const input = await task.read({ path: editedFile });
    await task.check();
    await expect(task.replace({ path, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
    expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(input.content);
    await expect(task.read({ path: editedFile })).rejects.toThrow("closed");
  });

it("requires an initial check and rejects stale hashes without overwriting source", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await expect(task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe(input.content);
  // Fresh explicit task authority uses a fresh candidate; a saved plan cannot reset a budget.
  const second = await fixture();
  const next = await CandidateTask.prepare(second.directory);
  const content = await next.read({ path: editedFile });
  await next.check();
  await expect(next.replace({ path: editedFile, expectedSha256: "0".repeat(64), content: correction(content.content) })).rejects.toThrow("denied");
  expect(await readFile(join(second.checkout, editedFile), "utf8")).toBe(content.content);
}, 30_000);

it("detects out-of-scope changes and refuses to read unlisted files", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  await writeFile(join(candidate.checkout, "src/cli.ts"), "external change");
  await expect(task.read({ path: editedFile })).rejects.toThrow("denied");
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("scope changed");
  expect(await readFile(join(candidate.checkout, "src/cli.ts"), "utf8")).toBe("external change");
});

it("detects external modification of the writable file and preserves it", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await writeFile(join(candidate.checkout, editedFile), "external");
  await expect(task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) })).rejects.toThrow("denied");
  expect(await readFile(join(candidate.checkout, editedFile), "utf8")).toBe("external");
});

it("does not pass a corrected status if unrelated document text changes, and bounds correction attempts", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  const input = await task.read({ path: editedFile });
  await task.check();
  await task.replace({ path: editedFile, expectedSha256: input.sha256, content: correction(input.content) + "\nUnrequested text\n" });
  expect((await task.check()).status).toBe("check_failed");
  const current = await task.read({ path: editedFile });
  await task.replace({ path: editedFile, expectedSha256: current.sha256, content: correction(input.content) });
  expect((await task.check()).status).toBe("passed");
  await expect(task.check()).rejects.toThrow("denied");
}, 30_000);

it("rejects additional payload fields and refuses forged persisted scope", async () => {
  const candidate = await fixture();
  const task = await CandidateTask.prepare(candidate.directory);
  await expect(task.read({ path: editedFile, command: "SYNTHETIC_PRIVATE" })).rejects.toThrow("denied");
  const path = join(candidate.directory, "task.json");
  const original = await readFile(path, "utf8");
  await expect(CandidateTask.prepare(candidate.directory)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), writeFiles: ["src/cli.ts"] }));
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("invalid");
  await writeFile(path, JSON.stringify({ ...JSON.parse(original), definitionSha256: "0".repeat(64) }));
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("invalid");
  const changedContract = JSON.parse(original);
  changedContract.contract.writeFiles = ["src/cli.ts"];
  await writeFile(path, JSON.stringify(changedContract));
  await expect(checkCandidateTask(candidate.directory)).rejects.toThrow("invalid");
}, 30_000);

it("prepares and checks through the compiled CLI without authorizing editing or invoking a model", async () => {
  const candidate = await fixture();
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const prepare = spawnSync("bun", ["--no-env-file", entry, "task", "prepare", candidate.directory], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(prepare.status).toBe(0);
  expect(JSON.parse(prepare.stdout)).toMatchObject({ task: "pi-decision-status", writeFiles: [editedFile] });
  const check = spawnSync("bun", ["--no-env-file", entry, "task", "check", candidate.directory], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(check.status).toBe(1);
  expect(JSON.parse(check.stdout)).toMatchObject({ status: "check_failed", provenance: "recorded_untrusted" });
});
