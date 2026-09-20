import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import * as z from "zod";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask, inspectCandidateTask, type CandidateTaskCheck } from "../src/candidate-task.js";
import { decideTask, reviewTask, validateCorrectionParent } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import type { ProposalRunGrant } from "../src/proposal-admission.js";
import { TASK_LIMITS } from "../src/task-contract.js";
import { checkRepositoryTypecheck, type RepositoryTypecheckResult } from "../src/repository-typecheck.js";
import { createPiTaskBudget, PI_TASK_LIMITS, runPiTask, type PiTaskResult } from "../src/integrations/pi-task.js";
import { LIVE_CODEX_MODEL_ID } from "../src/integrations/pi-live.js";
import { recordSemanticRevision, semanticRevisionSha256 } from "../src/semantic-revision.js";

const candidateRename = vi.hoisted(() => ({
  active: false,
  afterTemporaryClose: null as (() => Promise<void>) | null,
  dispatches: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original,
    open: async (path: string, flags: string, mode?: number) => {
      const opened = await original.open(path, flags, mode);
      if (!candidateRename.active || flags !== "wx" || !path.includes(".tesota-")) return opened;
      return {
        writeFile: opened.writeFile.bind(opened),
        sync: opened.sync.bind(opened),
        close: async () => {
          await opened.close();
          await candidateRename.afterTemporaryClose?.();
        },
      };
    },
    rename: async (from: string, to: string) => {
      if (candidateRename.active && from.includes(".tesota-")) candidateRename.dispatches += 1;
      await original.rename(from, to);
    },
  };
});

vi.mock("../src/repository-typecheck.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, checkRepositoryTypecheck: vi.fn(async () => ({
    profile: "typescript-no-emit/v1", status: "passed", reason: null, diagnostics: [],
    process: "exited", container: "absent", binding: {}, authority: "none", provenance: "issued",
  })) };
});

function typecheckResult(status: "passed" | "check_failed" | "timed_out", identity = "a"): RepositoryTypecheckResult {
  return { profile: "typescript-no-emit/v1", status, reason: status === "passed" ? null : status,
    diagnostics: status === "check_failed" ? ["src/value.ts(1,14): error TS2322: invalid"] : [],
    process: status === "timed_out" ? "unconfirmed" : "exited", container: "absent",
    binding: { identity } as never, authority: "none", provenance: "issued" };
}

beforeEach(() => {
  vi.clearAllMocks();
  candidateRename.active = false;
  candidateRename.afterTemporaryClose = null;
  candidateRename.dispatches = 0;
  vi.mocked(checkRepositoryTypecheck).mockResolvedValue(typecheckResult("passed"));
});

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let sharedRoot = "";
let sharedSource = "";
let sharedCandidates = "";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Fixture Git failed");
  return result.stdout.trim();
}

async function createSource(crlfAttributes = false): Promise<{ root: string; source: string; candidates: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-generic-task-test-"));
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "value.ts"), "export const value = 'old';\n");
  await writeFile(join(source, "src", "reference.ts"), "export const reference = 'context';\n");
  await writeFile(join(source, "README.md"), "untouched\n");
  if (crlfAttributes) await writeFile(join(source, ".gitattributes"), "src/*.ts text eol=crlf\n");
  git(source, ["init", "--quiet"]); git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { root, source, candidates: join(root, "candidates") };
}

beforeAll(async () => {
  const created = await createSource();
  sharedRoot = created.root; sharedSource = created.source; sharedCandidates = created.candidates;
});
afterAll(async () => {
  if (sharedRoot !== "") await rm(sharedRoot, { recursive: true, force: true });
});

async function fixture(isolatedSource = false, crlfAttributes = false) {
  const owned = isolatedSource ? await createSource(crlfAttributes) : undefined;
  const source = owned?.source ?? sharedSource;
  const candidates = owned?.candidates ?? sharedCandidates;
  const candidate = await createCandidateCheckout(source, candidates);
  const grant: ProposalRunGrant = {
    kind: "typescript-change", proposalId: "b0e37d7c-f19f-4c0c-915c-e52aafea93e7",
    proposalSha256: "a".repeat(64), source, baseline: candidate.baseline,
    objective: "Change the exported value.", completionConditions: ["The module exports the requested value."],
    readFiles: ["src/value.ts", "src/reference.ts"], writeFiles: ["src/value.ts"],
    declaredChecks: ["scope-integrity", "typescript-no-emit/v1"],
    verification: { scopeIntegrity: "application_owned", typecheck: "typescript-no-emit/v1",
      outcome: "human_review_required" },
  };
  return { ...candidate, source, grant, cleanup: async () => {
    if (owned !== undefined) await rm(owned.root, { recursive: true, force: true });
  } };
}

function issued(check: CandidateTaskCheck): CandidateTaskCheck {
  return { ...check, provenance: "issued" };
}

function r0Session(current: CandidateTaskCheck): PiTaskResult {
  const before: CandidateTaskCheck = { ...issued(current), status: "check_failed", outcome: "check_failed",
    diagnostics: ["No admitted file changed."], typecheck: null, writeSetSha256: "1".repeat(64) };
  return { status: "completed", modelInvocations: 4, toolCalls: 3, edits: 1,
    checks: [before, issued(current)], checksSuppliedToModel: 2, finalCheckSuppliedToModel: true,
    deadlineExpired: false, settlement: "observed", denied: false, terminalStopReason: "stop",
    taskAcceptance: "not_evaluated", executionCause: "initial_implementation", activeMs: 100,
    editCauses: [{ cause: "initial_implementation" }] };
}

function r1Session(current: CandidateTaskCheck): PiTaskResult {
  return { status: "completed", modelInvocations: 6, toolCalls: 4, edits: 0,
    checks: [issued(current)], checksSuppliedToModel: 1, finalCheckSuppliedToModel: true,
    deadlineExpired: false, settlement: "observed", denied: false, terminalStopReason: "stop",
    taskAcceptance: "not_evaluated", executionCause: "semantic_revision", activeMs: 150, editCauses: [] };
}

function attemptStarted(version: 1 | 2, baseline: string, timestamp: string, revision?: Readonly<{
  sha256: string; parentReviewSha256: string; parentAttemptSha256: string;
}>): Record<string, unknown> {
  const executor = Object.fromEntries([
    "task-run.js", "candidate-checkout.js", "candidate-task.js", "task-contract.js", "task-source.js",
    "semantic-revision.js", "repository-check-input.js", "proposal-admission.js", "repository-typecheck.js",
    "repository-typecheck-process.js", "command-isolation.js", "verification/invocation-admission.js",
    "integrations/pi-task.js", "integrations/pi-live.js", "integrations/codex-credentials.js", "../bun.lock",
  ].map((path) => [path, "8".repeat(64)]));
  return { format: "tesota-task-attempt", version, state: "started", timestamp, baseline,
    sourceDirty: false, executor, model: LIVE_CODEX_MODEL_ID, limits: PI_TASK_LIMITS,
    taskAcceptance: "not_evaluated", executionCause: version === 1 ? "initial_implementation" : "semantic_revision",
    ...(revision === undefined ? {} : { revisionSha256: revision.sha256,
      parentReviewSha256: revision.parentReviewSha256, parentAttemptSha256: revision.parentAttemptSha256 }) };
}

function attemptText(started: Record<string, unknown>, session: PiTaskResult,
  current: CandidateTaskCheck, timestamp: string): string {
  return [started, { state: "finished", timestamp, outcome: "passed", session, current, reviewSaved: true,
    taskAcceptance: "not_evaluated" }].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function retainedParentFixture() {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const input = await task.read({ path: "src/value.ts" });
  await task.check();
  await task.replace({ path: "src/value.ts", expectedSha256: input.sha256,
    content: "export const value = 'new';\n" });
  await task.check();
  task.close();
  const r0 = await reviewTask(current.directory);
  const timestamp = new Date().toISOString();
  await writeFile(join(current.directory, "candidate.diff"), r0.diff);
  const r0Attempt = attemptText(attemptStarted(1, current.baseline, timestamp), r0Session(r0.check), r0.check, timestamp);
  await writeFile(join(current.directory, "attempt.jsonl"), r0Attempt);
  const parentAttemptSha256 = createHash("sha256").update(r0Attempt).digest("hex");
  return { current, task, r0, timestamp, r0Attempt, parentAttemptSha256 };
}

async function retainedRevisionFixture() {
  const parent = await retainedParentFixture();
  const { current, task, r0, timestamp, parentAttemptSha256 } = parent;
  const revision = await recordSemanticRevision(current.directory, {
    taskDefinitionSha256: task.describe().definitionSha256, parentReviewSha256: r0.reviewSha256,
    parentWriteSetSha256: r0.check.writeSetSha256,
    parentCheckSha256: createHash("sha256").update(JSON.stringify(r0.check)).digest("hex"),
    parentAttemptSha256, refinement: "Keep the exact bytes but clarify the semantic criterion.",
  });
  await writeFile(join(current.directory, "candidate-r1.diff"), r0.diff);
  const r1Attempt = attemptText(attemptStarted(2, current.baseline, timestamp, {
    sha256: semanticRevisionSha256(revision), parentReviewSha256: r0.reviewSha256, parentAttemptSha256,
  }), r1Session(r0.check), r0.check, timestamp);
  await writeFile(join(current.directory, "attempt-r1.jsonl"), r1Attempt);
  return { ...parent, revision, r1Attempt };
}

it("derives the bounded tool contract from an approved TypeScript grant", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  expect(task.describe()).toMatchObject({ task: "typescript-change", writeFiles: ["src/value.ts"],
    checks: ["scope-integrity", "typescript-no-emit/v1"], outcome: "human_review_required", limits: TASK_LIMITS });
  expect((await task.read({ path: "src/reference.ts" })).content).toContain("reference");
  await expect(task.read({ path: "README.md" })).rejects.toThrow("denied");
});

it("requires a check before editing and binds replacement to current bytes", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const observed = await task.read({ path: "src/value.ts" });
  await expect(task.replace({ path: "src/value.ts", expectedSha256: observed.sha256,
    content: "export const value = 'new';\n" })).rejects.toThrow("denied");

  const next = await fixture();
  const permitted = await CandidateTask.prepare(next.directory, next.grant);
  await permitted.read({ path: "src/value.ts" });
  expect((await permitted.check()).status).toBe("check_failed");
  await expect(permitted.replace({ path: "src/value.ts", expectedSha256: "0".repeat(64),
    content: "export const value = 'new';\n" })).rejects.toThrow("denied");

  const final = await fixture();
  const valid = await CandidateTask.prepare(final.directory, final.grant);
  const baseline = await valid.read({ path: "src/value.ts" });
  await valid.check();
  await valid.replace({ path: "src/value.ts", expectedSha256: baseline.sha256,
    content: "export const value = 'new';\n" });
  expect(await valid.check()).toMatchObject({ status: "passed", provenance: "issued",
    diagnostics: expect.arrayContaining([expect.stringContaining("human review")]),
    typecheck: { profile: "typescript-no-emit/v1", status: "passed" } });
}, 30_000);

it("permanently denies every R0 capability after settlement without closing R1", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const r0 = task.beginExecution();
  const r0Description = r0.describe();
  const observed = await r0.read({ path: "src/value.ts" });
  const r0Check = await r0.check();
  r0.close();
  await expect(r0.read({ path: "src/value.ts" })).rejects.toThrow("expired");
  const r1 = task.beginExecution({ cause: "semantic_revision", refinement: "Use the alternate wording.",
    parentReviewSha256: "b".repeat(64), parentWriteSetSha256: "d".repeat(64),
    parentCheckSha256: "e".repeat(64), effectiveCriteriaSha256: "c".repeat(64),
    parentEvidence: r0Check,
    remainingBudget: { reads: 7, edits: 2, checks: 2, modelInvocations: 6, toolCalls: 7, activeMs: 1000 } });
  const r1Description = r1.describe();
  const { executionCause: r0Cause, semanticRevision: r0Revision, ...r0Contract } = r0Description;
  const { executionCause: r1Cause, semanticRevision: r1Revision, ...r1Contract } = r1Description;

  expect(r0Cause).toBe("initial_implementation");
  expect(r0Revision).toBeUndefined();
  expect(r1Cause).toBe("semantic_revision");
  expect(r1Revision).toMatchObject({ refinement: "Use the alternate wording.",
    parentEvidence: r0Check,
    remainingBudget: { reads: 7, edits: 2, checks: 2, modelInvocations: 6, toolCalls: 7, activeMs: 1000 } });
  expect(r1Contract).toEqual(r0Contract);
  expect(r1.requestSchemas().read.safeParse({ path: "README.md" }).success).toBe(false);
  expect(r1.requestSchemas().replace.safeParse({ path: "src/reference.ts", expectedSha256: observed.sha256,
    content: "export const reference = 2;\n" }).success).toBe(false);
  await expect(r0.read({ path: "src/value.ts" })).rejects.toThrow("expired");
  await expect(r0.replace({ path: "src/value.ts", expectedSha256: observed.sha256,
    content: "export const value = 'stale';\n" })).rejects.toThrow("expired");
  await expect(r0.check()).rejects.toThrow("expired");
  await expect(r1.read({ path: "src/value.ts" })).resolves.toMatchObject({ sha256: observed.sha256 });
  await expect(r1.check()).resolves.toMatchObject({ baseline: r0Check.baseline,
    sourceInputsSha256: r0Check.sourceInputsSha256, typecheck: r0Check.typecheck });
  r1.close();
  task.close();
});

it("denies a candidate rename when R0 is revoked after temporary preparation", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const r0 = task.beginExecution();
  const observed = await r0.read({ path: "src/value.ts" });
  await r0.check();
  const prepared = deferred();
  const release = deferred();
  candidateRename.active = true;
  candidateRename.afterTemporaryClose = async () => {
    prepared.resolve();
    await release.promise;
  };

  const replacing = r0.replace({ path: "src/value.ts", expectedSha256: observed.sha256,
    content: "export const value = 'revoked';\n" });
  await prepared.promise;
  r0.close();
  release.resolve();

  await expect(replacing).rejects.toThrow("denied");
  expect(candidateRename.dispatches).toBe(0);
  await expect(readFile(join(current.checkout, "src", "value.ts"), "utf8"))
    .resolves.toBe("export const value = 'old';\n");
  await expect(r0.read({ path: "src/value.ts" })).rejects.toThrow("expired");
});

it("rejects an external write and does not reopen a persisted task for editing", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  await writeFile(join(current.checkout, "README.md"), "changed outside scope\n");
  await expect(task.check()).rejects.toThrow("denied");
  await expect(checkCandidateTask(current.directory)).rejects.toThrow("scope changed");
  await expect(CandidateTask.prepare(current.directory, current.grant)).rejects.toThrow();
});

it("returns compiler diagnostics but closes the task on an operational typecheck failure", async () => {
  const invalid = await fixture();
  const invalidTask = await CandidateTask.prepare(invalid.directory, invalid.grant);
  const invalidInput = await invalidTask.read({ path: "src/value.ts" });
  await invalidTask.check();
  await invalidTask.replace({ path: "src/value.ts", expectedSha256: invalidInput.sha256,
    content: "export const value: string = 1;\n" });
  vi.mocked(checkRepositoryTypecheck).mockResolvedValueOnce(typecheckResult("check_failed"));
  await expect(invalidTask.check()).resolves.toMatchObject({ status: "check_failed",
    diagnostics: [expect.stringContaining("TS2322")], typecheck: { status: "check_failed" } });

  const unavailable = await fixture();
  const unavailableTask = await CandidateTask.prepare(unavailable.directory, unavailable.grant);
  const unavailableInput = await unavailableTask.read({ path: "src/value.ts" });
  await unavailableTask.check();
  await unavailableTask.replace({ path: "src/value.ts", expectedSha256: unavailableInput.sha256,
    content: "export const value = 'new';\n" });
  vi.mocked(checkRepositoryTypecheck).mockResolvedValueOnce(typecheckResult("timed_out"));
  const unavailableCheck = await unavailableTask.check();
  expect(unavailableCheck).toMatchObject({ status: "check_failed", outcome: "operational_failed", settlement: "unconfirmed",
    diagnostics: [expect.stringContaining("settlement is unconfirmed")], typecheck: { status: "timed_out", process: "unconfirmed" } });
  expect(checkRepositoryTypecheck).toHaveBeenLastCalledWith({ candidate: unavailable.directory,
    source: unavailable.source }, undefined);
  await expect(unavailableTask.read({ path: "src/value.ts" })).rejects.toThrow("closed");
});

it("preserves an unconfirmed check that finishes after task authority closes", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const input = await task.read({ path: "src/value.ts" });
  await task.check();
  await task.replace({ path: "src/value.ts", expectedSha256: input.sha256,
    content: "export const value = 'new';\n" });
  vi.mocked(checkRepositoryTypecheck).mockClear();
  let release: ((result: RepositoryTypecheckResult) => void) | undefined;
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  vi.mocked(checkRepositoryTypecheck).mockImplementationOnce(async () => await new Promise((resolve) => {
    release = resolve;
    markEntered?.();
  }));

  const running = task.check();
  await entered;
  expect(checkRepositoryTypecheck).toHaveBeenCalledOnce();
  task.close();
  release?.(typecheckResult("timed_out"));

  await expect(running).resolves.toMatchObject({ outcome: "operational_failed", settlement: "unconfirmed",
    typecheck: { status: "timed_out", process: "unconfirmed" } });
  await expect(task.read({ path: "src/value.ts" })).rejects.toThrow("closed");
}, 20_000);

it("keeps an in-flight real task check unsettled when Pi cancellation closes authority", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const close = vi.spyOn(task, "close");
  let release: ((result: RepositoryTypecheckResult) => void) | undefined;
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  vi.mocked(checkRepositoryTypecheck).mockImplementationOnce(async () => await new Promise((resolve) => {
    release = resolve;
    markEntered?.();
  }));
  const oldContent = "export const value = 'old';\n";
  const faux = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage(fauxToolCall("tesota_replace", { path: "src/value.ts",
      expectedSha256: createHash("sha256").update(oldContent).digest("hex"),
      content: "export const value = 'new';\n" })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
  ]);
  const cancellation = new AbortController();

  const running = runPiTask(task, faux.getModel(), faux.provider.streamSimple, cancellation.signal);
  await entered;
  expect(checkRepositoryTypecheck).toHaveBeenCalledOnce();
  cancellation.abort();
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
  const early = await Promise.race([
    running.then((result) => ({ kind: "result" as const, result })),
    new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 25)),
  ]);
  release?.(typecheckResult("timed_out"));

  const result = early.kind === "result" ? early.result : await running;
  expect(result).toMatchObject({ status: "unsettled", settlement: "unconfirmed" });
}, 20_000);

it("stops review checking at the first unconfirmed effect", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const input = await task.read({ path: "src/value.ts" });
  await task.check();
  await task.replace({ path: "src/value.ts", expectedSha256: input.sha256,
    content: "export const value = 'new';\n" });
  task.close();
  vi.mocked(checkRepositoryTypecheck).mockClear();
  vi.mocked(checkRepositoryTypecheck).mockResolvedValueOnce(typecheckResult("timed_out"));

  await expect(reviewTask(current.directory)).rejects.toMatchObject({ name: "TaskReviewUnsettledError" });
  expect(checkRepositoryTypecheck).toHaveBeenCalledOnce();
}, 20_000);

it("makes a review stale when the bound typecheck evidence changes", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const input = await task.read({ path: "src/value.ts" });
  await task.check();
  await task.replace({ path: "src/value.ts", expectedSha256: input.sha256,
    content: "export const value = 'new';\n" });
  task.close();

  vi.mocked(checkRepositoryTypecheck).mockResolvedValue(typecheckResult("passed", "first"));
  const first = await reviewTask(current.directory);
  vi.mocked(checkRepositoryTypecheck).mockResolvedValue(typecheckResult("passed", "second"));
  const second = await reviewTask(current.directory);

  expect(first.changedFiles).toEqual(["src/value.ts"]);
  expect(second.reviewSha256).not.toBe(first.reviewSha256);
  expect(second.check.writeSetSha256).toBe(first.check.writeSetSha256);
}, 20_000);

it.each(["no-op", "batched edit and check"])(
  "composes a real offline CandidateTask through R0, admitted R1 %s and fresh durable review", async (revisionWork) => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const budget = createPiTaskBudget();
  const oldContent = "export const value = 'old';\n";
  const r0Provider = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  r0Provider.setResponses([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage(fauxToolCall("tesota_replace", { path: "src/value.ts",
      expectedSha256: createHash("sha256").update(oldContent).digest("hex"),
      content: "export const value = 'new';\n" })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage("done"),
  ]);
  const r0Capability = task.beginExecution();
  const r0Session = await runPiTask(r0Capability, r0Provider.getModel(), r0Provider.provider.streamSimple,
    new AbortController().signal, budget);
  r0Capability.close();
  const r0Current = await checkCandidateTask(current.directory);
  const timestamp = new Date().toISOString();
  const r0Diff = await import("../src/candidate-checkout.js").then(({ candidateDiff }) => candidateDiff(current.directory));
  await writeFile(join(current.directory, "candidate.diff"), r0Diff);
  const r0Attempt = attemptText(attemptStarted(1, current.baseline, timestamp), r0Session, r0Current, timestamp);
  await writeFile(join(current.directory, "attempt.jsonl"), r0Attempt);
  const r0 = await reviewTask(current.directory);
  const parent = await validateCorrectionParent(current.directory, {
    parentReviewSha256: r0.reviewSha256, parentWriteSetSha256: r0.check.writeSetSha256,
    parentCheckSha256: createHash("sha256").update(JSON.stringify(r0.check)).digest("hex"),
    parentAttemptSha256: createHash("sha256").update(r0Attempt).digest("hex"),
    taskDefinitionSha256: task.describe().definitionSha256,
  });
  const revision = await recordSemanticRevision(current.directory, {
    taskDefinitionSha256: task.describe().definitionSha256, parentReviewSha256: r0.reviewSha256,
    parentWriteSetSha256: r0.check.writeSetSha256,
    parentCheckSha256: createHash("sha256").update(JSON.stringify(r0.check)).digest("hex"),
    parentAttemptSha256: parent.attemptSha256, refinement: "Keep the new value and clarify the criterion.",
  });
  const r1Provider = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  r1Provider.setResponses([
    fauxAssistantMessage(revisionWork === "no-op" ? [fauxToolCall("tesota_check", {})] : [
      fauxToolCall("tesota_replace", { path: "src/value.ts",
        expectedSha256: createHash("sha256").update("export const value = 'new';\n").digest("hex"),
        content: "export const value = 'revised';\n" }), fauxToolCall("tesota_check", {}),
    ]), fauxAssistantMessage("done"),
  ]);
  const r1Capability = task.beginExecution({ cause: "semantic_revision", refinement: revision.refinement,
    parentReviewSha256: revision.parentReviewSha256, parentWriteSetSha256: revision.parentWriteSetSha256,
    parentCheckSha256: revision.parentCheckSha256, effectiveCriteriaSha256: revision.effectiveCriteriaSha256,
    parentEvidence: parent.check,
    remainingBudget: { reads: 7, edits: 1, checks: 1,
      modelInvocations: PI_TASK_LIMITS.modelInvocations - budget.modelInvocations,
      toolCalls: PI_TASK_LIMITS.toolCalls - budget.toolCalls,
      activeMs: PI_TASK_LIMITS.sessionMs - budget.activeMs } });
  const r1Session = await runPiTask(r1Capability, r1Provider.getModel(), r1Provider.provider.streamSimple,
    new AbortController().signal, budget);
  r1Capability.close();
  const r1Current = await checkCandidateTask(current.directory);
  const r1Diff = await import("../src/candidate-checkout.js").then(({ candidateDiff }) => candidateDiff(current.directory));
  await writeFile(join(current.directory, "candidate-r1.diff"), r1Diff);
  await writeFile(join(current.directory, "attempt-r1.jsonl"), attemptText(
    attemptStarted(2, current.baseline, timestamp, { sha256: semanticRevisionSha256(revision),
      parentReviewSha256: r0.reviewSha256, parentAttemptSha256: parent.attemptSha256 }),
    r1Session, r1Current, new Date().toISOString()));

  const r1 = await reviewTask(current.directory);
  expect(r0Session).toMatchObject({ status: "completed", executionCause: "initial_implementation" });
  expect(r1Session).toMatchObject({ status: "completed", executionCause: "semantic_revision" });
  expect(r1.historicalAttempt).toBe("semantic_revision_passed");
  expect(r1.reviewSha256).not.toBe(r0.reviewSha256);
  expect(budget.modelInvocations).toBeGreaterThan(r0Session.modelInvocations);
  expect(r1Session.modelInvocations - r0Session.modelInvocations).toBe(2);
  expect(r1Session.toolCalls - r0Session.toolCalls).toBe(revisionWork === "no-op" ? 1 : 2);
}, 30_000);

it("gives an R1 no-op fresh semantic review identity without claiming changed correction bytes", async () => {
  const { current, r0 } = await retainedRevisionFixture();

  const r1 = await reviewTask(current.directory);
  expect(r1.reviewSha256).not.toBe(r0.reviewSha256);
  expect(r1.check.writeSetSha256).toBe(r0.check.writeSetSha256);
  expect(r1.historicalAttempt).toBe("semantic_revision_passed");
  expect(r1.operatorDecision).toBeNull();
}, 20_000);

it("rejects all-zero R1 consumption with otherwise valid retained evidence", async () => {
  const { current, r0, revision, timestamp, parentAttemptSha256 } = await retainedRevisionFixture();
  await expect(reviewTask(current.directory)).resolves.toMatchObject({ historicalAttempt: "semantic_revision_passed" });
  await writeFile(join(current.directory, "attempt-r1.jsonl"), attemptText(
    attemptStarted(2, current.baseline, timestamp, { sha256: semanticRevisionSha256(revision),
      parentReviewSha256: r0.reviewSha256, parentAttemptSha256 }),
    { ...r1Session(r0.check), modelInvocations: 0, toolCalls: 0, activeMs: 0 }, r0.check, timestamp));
  await expect(reviewTask(current.directory)).rejects.toThrow("Semantic revision resource evidence invalid");
}, 20_000);

it.each([
  ["zero model invocations", { modelInvocations: 0 }],
  ["zero tool calls", { toolCalls: 0 }],
  ["zero active time", { activeMs: 0 }],
  ["nonzero model regression", { modelInvocations: 3 }],
  ["nonzero tool regression", { toolCalls: 2 }],
  ["nonzero time regression", { activeMs: 99 }],
  ["unchanged model consumption", { modelInvocations: 4 }],
  ["only one new model invocation", { modelInvocations: 5 }],
  ["unchanged tool consumption", { toolCalls: 3 }],
  ["tool delta omitting a claimed edit", { edits: 1, editCauses: [{ cause: "semantic_revision" }] }],
] satisfies ReadonlyArray<readonly [string, Partial<PiTaskResult>]>)(
  "rejects R1 %s without changing bytes, checks or lineage", async (_name, mutation) => {
    const { current, r0, revision, timestamp, parentAttemptSha256 } = await retainedRevisionFixture();
    await writeFile(join(current.directory, "attempt-r1.jsonl"), attemptText(
      attemptStarted(2, current.baseline, timestamp, { sha256: semanticRevisionSha256(revision),
        parentReviewSha256: r0.reviewSha256, parentAttemptSha256 }),
      { ...r1Session(r0.check), ...mutation }, r0.check, timestamp));
    vi.mocked(checkRepositoryTypecheck).mockClear();
    await expect(reviewTask(current.directory)).rejects.toThrow("Semantic revision resource evidence invalid");
    expect(checkRepositoryTypecheck).not.toHaveBeenCalled();
  }, 20_000);

it("accepts R1 rounded-time equality and minimum no-op resource increments", async () => {
  const { current, r0, revision, timestamp, parentAttemptSha256 } = await retainedRevisionFixture();
  await writeFile(join(current.directory, "attempt-r1.jsonl"), attemptText(
    attemptStarted(2, current.baseline, timestamp, { sha256: semanticRevisionSha256(revision),
      parentReviewSha256: r0.reviewSha256, parentAttemptSha256 }),
    { ...r1Session(r0.check), activeMs: r0Session(r0.check).activeMs }, r0.check, timestamp));
  await expect(reviewTask(current.directory)).resolves.toMatchObject({ historicalAttempt: "semantic_revision_passed" });
}, 20_000);

it.each([0, 2])("rejects aggregate phase consumption with %i R1 edits and two R1 checks", async (edits) => {
  const { current, r0, revision, timestamp, parentAttemptSha256 } = await retainedRevisionFixture();
  const failed: CandidateTaskCheck = { status: "check_failed", diagnostics: ["TypeScript check failed."],
    outcome: "check_failed", settlement: "observed", task: r0.check.task, typecheck: typecheckResult("check_failed"),
    baseline: r0.check.baseline, writeSetSha256: "2".repeat(64), sourceInputsSha256: r0.check.sourceInputsSha256,
    taskAcceptance: "not_evaluated", provenance: "issued" };
  const session: PiTaskResult = { ...r1Session(r0.check), toolCalls: 9, edits,
    checks: [edits === 0 ? issued(r0.check) : failed, issued(r0.check)], checksSuppliedToModel: 2,
    editCauses: edits === 0 ? [] : [{ cause: "semantic_revision" }, { cause: "diagnostic_repair",
      failedCheckSha256: createHash("sha256").update(JSON.stringify(failed)).digest("hex") }] };
  await writeFile(join(current.directory, "attempt-r1.jsonl"), attemptText(
    attemptStarted(2, current.baseline, timestamp, { sha256: semanticRevisionSha256(revision),
      parentReviewSha256: r0.reviewSha256, parentAttemptSha256 }), session, r0.check, timestamp));
  await expect(reviewTask(current.directory)).rejects.toThrow("Semantic revision resource evidence invalid");
}, 20_000);

const revisionEvidenceFailures = [
  "altered R0 start record",
  "altered R0 finish record",
  "incomplete R0 attempt",
  "skeletal R1 session",
  "missing R1 accounting field",
  "partial R1 attempt",
  "extra R1 attempt record",
  "R1 attempt symlink",
  "R1 attempt hardlink",
  "mismatched R0 attempt digest",
  "R1 attempt from another revision",
  "R1 attempt from another parent",
  "partial semantic revision",
  "partial R1 diff",
] as const;

async function applyRevisionEvidenceFailure(failure: (typeof revisionEvidenceFailures)[number], directory: string,
  r0Attempt: string, r1Attempt: string): Promise<void> {
  const parse = (text: string): [Record<string, unknown>, Record<string, unknown>] => {
    const lines = text.trimEnd().split("\n").map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    const parsed = z.tuple([z.record(z.string(), z.unknown()), z.record(z.string(), z.unknown())]).parse(lines);
    return parsed;
  };
  const serialize = (lines: readonly Record<string, unknown>[]): string =>
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  const r0Path = join(directory, "attempt.jsonl");
  const r1Path = join(directory, "attempt-r1.jsonl");
  switch (failure) {
    case "altered R0 start record": {
      const lines = parse(r0Attempt); lines[0]["model"] = "substituted";
      await writeFile(r0Path, serialize(lines)); return;
    }
    case "altered R0 finish record": {
      const lines = parse(r0Attempt); const session = z.record(z.string(), z.unknown()).parse(lines[1]["session"]);
      session["activeMs"] = z.number().parse(session["activeMs"]) + 1;
      lines[1]["session"] = session; await writeFile(r0Path, serialize(lines)); return;
    }
    case "incomplete R0 attempt": await writeFile(r0Path, r0Attempt.split("\n")[0] + "\n"); return;
    case "skeletal R1 session": {
      const lines = parse(r1Attempt); lines[1]["session"] = {
        status: "completed", settlement: "observed", executionCause: "semantic_revision",
        finalCheckSuppliedToModel: true, taskAcceptance: "not_evaluated",
      }; await writeFile(r1Path, serialize(lines)); return;
    }
    case "missing R1 accounting field": {
      const lines = parse(r1Attempt); const session = z.record(z.string(), z.unknown()).parse(lines[1]["session"]);
      delete session["toolCalls"]; lines[1]["session"] = session; await writeFile(r1Path, serialize(lines)); return;
    }
    case "partial R1 attempt": await writeFile(r1Path, r1Attempt.split("\n")[0] + "\n"); return;
    case "extra R1 attempt record":
      await writeFile(r1Path, r1Attempt + JSON.stringify({ state: "unexpected" }) + "\n"); return;
    case "R1 attempt symlink":
    case "R1 attempt hardlink": {
      const substitute = join(directory, `substitute-${failure === "R1 attempt symlink" ? "symlink" : "hardlink"}.jsonl`);
      await writeFile(substitute, r1Attempt); await rm(r1Path);
      if (failure === "R1 attempt symlink") await symlink(substitute, r1Path, "file");
      else await link(substitute, r1Path);
      return;
    }
    case "mismatched R0 attempt digest": {
      const path = join(directory, "semantic-revision.json");
      const revision = JSON.parse(await readFile(path, "utf8")); revision.parentAttemptSha256 = "6".repeat(64);
      await writeFile(path, JSON.stringify(revision, null, 2) + "\n"); return;
    }
    case "R1 attempt from another revision":
    case "R1 attempt from another parent": {
      const lines = parse(r1Attempt);
      lines[0][failure === "R1 attempt from another revision" ? "revisionSha256" : "parentReviewSha256"] =
        failure === "R1 attempt from another revision" ? "5".repeat(64) : "7".repeat(64);
      await writeFile(r1Path, serialize(lines)); return;
    }
    case "partial semantic revision":
      await writeFile(join(directory, "semantic-revision.json"), "{\"format\":\"tesota-semantic-revision\""); return;
    case "partial R1 diff": await writeFile(join(directory, "candidate-r1.diff"), "partial diff\n");
  }
}

it.each(revisionEvidenceFailures)("rejects %s before claiming a passed semantic revision", async (failure) => {
  const { current, r0Attempt, r1Attempt } = await retainedRevisionFixture();
  await applyRevisionEvidenceFailure(failure, current.directory, r0Attempt, r1Attempt);
  await expect(reviewTask(current.directory)).rejects.toThrow();
}, 30_000);

it("rejects grant and persisted-plan tampering", async () => {
  const current = await fixture();
  await expect(CandidateTask.prepare(current.directory, { ...current.grant,
    writeFiles: ["README.md"] })).rejects.toThrow();
  await expect(CandidateTask.prepare(current.directory, { ...current.grant,
    readFiles: ["src/types.d.ts"], writeFiles: ["src/types.d.ts"] })).rejects.toThrow();
  await expect(CandidateTask.prepare(current.directory, { ...current.grant,
    readFiles: ["src/value.test.ts"], writeFiles: ["src/value.test.ts"] })).rejects.toThrow();

  const next = await fixture();
  (await CandidateTask.prepare(next.directory, next.grant)).close();
  const planPath = join(next.directory, "task.json");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  plan.contract.objective = "Changed after approval";
  await writeFile(planPath, JSON.stringify(plan));
  await expect(checkCandidateTask(next.directory)).rejects.toThrow("Task plan invalid");
});

it("rejects source-level TypeScript suppression instead of treating it as a clean check", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const input = await task.read({ path: "src/value.ts" });
  await task.check();
  await task.replace({ path: "src/value.ts", expectedSha256: input.sha256,
    content: "// @ts-ignore\nexport const value: string = 1;\n" });

  await expect(task.check()).resolves.toMatchObject({ status: "check_failed", typecheck: null,
    diagnostics: [expect.stringContaining("suppression directives")] });
  expect(checkRepositoryTypecheck).not.toHaveBeenCalled();
});

it("promotes only the exact accepted candidate bytes while preserving unrelated source state", async () => {
  const current = await fixture(true);
  try {
    const task = await CandidateTask.prepare(current.directory, current.grant);
    const input = await task.read({ path: "src/value.ts" });
    await task.check();
    await task.replace({ path: "src/value.ts", expectedSha256: input.sha256, content: "export const value = 'new';\n" });
    await task.check();
    task.close();
    const review = await reviewTask(current.directory);
    await decideTask(current.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
    const index = await readFile(join(current.source, ".git", "index"));
    await writeFile(join(current.source, "README.md"), "operator work\n");

    const result = await promoteTask(current.directory, current.source, review.reviewSha256);

    expect(result).toMatchObject({ status: "applied", files: [{ path: "src/value.ts" }] });
    const promotion = await readFile(join(current.directory, "promotion.jsonl"), "utf8");
    expect(promotion.indexOf('"state":"source_write_started"')).toBeLessThan(promotion.indexOf('"state":"applied"'));
    expect(await readFile(join(current.source, "src", "value.ts"), "utf8")).toBe("export const value = 'new';\n");
    expect(await readFile(join(current.source, "README.md"), "utf8")).toBe("operator work\n");
    expect(await readFile(join(current.source, ".git", "index"))).toEqual(index);
    expect(createHash("sha256").update("export const value = 'new';\n").digest("hex"))
      .toBe(result.files[0]?.sourceSha256);
  } finally { await current.cleanup(); }
}, 60_000);

it("classifies a rejected promotion before source writing as not applied", async () => {
  const current = await fixture(true);
  try {
    const before = await readFile(join(current.source, "src", "value.ts"), "utf8");
    await expect(promoteTask(current.directory, current.source, "a".repeat(64))).rejects.toMatchObject({
      name: "PromotionNotAppliedError",
    });
    expect(await readFile(join(current.source, "src", "value.ts"), "utf8")).toBe(before);
  } finally { await current.cleanup(); }
});

it("preserves an unconfirmed promotion-time review before source writing", async () => {
  const current = await fixture(true);
  try {
    const task = await CandidateTask.prepare(current.directory, current.grant);
    const input = await task.read({ path: "src/value.ts" });
    await task.check();
    await task.replace({ path: "src/value.ts", expectedSha256: input.sha256,
      content: "export const value = 'new';\n" });
    await task.check();
    task.close();
    const review = await reviewTask(current.directory);
    await decideTask(current.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
    vi.mocked(checkRepositoryTypecheck).mockClear();
    vi.mocked(checkRepositoryTypecheck).mockResolvedValueOnce(typecheckResult("timed_out"));

    await expect(promoteTask(current.directory, current.source, review.reviewSha256)).rejects.toMatchObject({
      name: "PromotionUncertainError",
    });
    expect(checkRepositoryTypecheck).toHaveBeenCalledOnce();
  } finally { await current.cleanup(); }
}, 60_000);

async function acceptedChange(current: Awaited<ReturnType<typeof fixture>>) {
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const input = await task.read({ path: "src/value.ts" });
  await task.check();
  await task.replace({ path: "src/value.ts", expectedSha256: input.sha256, content: "export const value = 'new';\n" });
  task.close();
  const review = await reviewTask(current.directory);
  await decideTask(current.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  return { task, review };
}

it.each([false, true])("promotes exact accepted LF bytes over an admitted CRLF source (attributes: %s)", async (attributes) => {
  const current = await fixture(true, attributes);
  try {
    const target = join(current.source, "src/value.ts");
    git(current.source, ["config", "core.autocrlf", "true"]);
    await writeFile(target, "export const value = 'old';\r\n");
    git(current.source, ["add", "--", "src/value.ts"]);
    expect(git(current.source, ["status", "--porcelain"])).toBe("");
    const { review } = await acceptedChange(current);
    expect(review.check.sourceInputsSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(promoteTask(current.directory, current.source, review.reviewSha256))
      .resolves.toMatchObject({ status: "applied" });
    expect(await readFile(target)).toEqual(await readFile(join(current.checkout, "src/value.ts")));
    expect(await readFile(target, "utf8")).toBe("export const value = 'new';\n");
  } finally { await current.cleanup(); }
}, 60_000);

it.each(["export const value = 'operator';\r\n", "export const value = 'old';\n"])(
  "rejects source drift after CRLF admission: %j", async (replacement) => {
    const current = await fixture(true);
    try {
      const target = join(current.source, "src/value.ts");
      await writeFile(target, "export const value = 'old';\r\n");
      const { review } = await acceptedChange(current);
      await writeFile(target, replacement);
      await expect(promoteTask(current.directory, current.source, review.reviewSha256))
        .rejects.toMatchObject({ name: "PromotionNotAppliedError" });
      expect(await readFile(target, "utf8")).toBe(replacement);
      await expect(readFile(join(current.directory, "promotion.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await current.cleanup(); }
  }, 60_000);

it("rejects an existing substantive source edit before creating a task plan", async () => {
  const current = await fixture(true);
  try {
    await writeFile(join(current.source, "src/value.ts"), "export const value = 'operator';\r\n");
    await expect(CandidateTask.prepare(current.directory, current.grant)).rejects.toThrow("Task source binding invalid");
    await expect(readFile(join(current.directory, "task.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await current.cleanup(); }
});

it("rejects source permission drift after admission", async () => {
  const current = await fixture(true);
  const target = join(current.source, "src/value.ts");
  const mode = (await lstat(target)).mode & 0o777;
  try {
    const { review } = await acceptedChange(current);
    await chmod(target, 0o444);
    expect((await lstat(target)).mode & 0o777).not.toBe(mode);
    await expect(promoteTask(current.directory, current.source, review.reviewSha256))
      .rejects.toMatchObject({ name: "PromotionNotAppliedError" });
    expect(await readFile(target, "utf8")).toBe("export const value = 'old';\n");
  } finally { await chmod(target, mode); await current.cleanup(); }
}, 60_000);

it("makes acceptance stale if a persisted source representation is rebound", async () => {
  const current = await fixture(true);
  try {
    const { task, review } = await acceptedChange(current);
    const planPath = join(current.directory, "task.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const crlf = "export const value = 'old';\r\n";
    plan.sourceInputs["src/value.ts"].sha256 = createHash("sha256").update(crlf).digest("hex");
    plan.definitionSha256 = createHash("sha256").update(JSON.stringify({ task: plan.task, version: 2,
      grant: plan.grant, contract: plan.contract, instructions: task.describe().instructions,
      inputs: plan.inputs, sourceInputs: plan.sourceInputs })).digest("hex");
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(join(current.source, "src/value.ts"), crlf);
    const rebound = await reviewTask(current.directory);
    expect(rebound.check.writeSetSha256).toBe(review.check.writeSetSha256);
    expect(rebound.reviewSha256).not.toBe(review.reviewSha256);
    expect(rebound.operatorDecision?.applicability).toBe("stale");
    await expect(promoteTask(current.directory, current.source, review.reviewSha256))
      .rejects.toMatchObject({ name: "PromotionNotAppliedError" });
  } finally { await current.cleanup(); }
}, 60_000);

it("keeps legacy plans inspectable without reconstructing source binding or promotion authority", async () => {
  const current = await fixture(true);
  try {
    const task = await CandidateTask.prepare(current.directory, current.grant);
    const input = await task.read({ path: "src/value.ts" });
    await task.check();
    await task.replace({ path: "src/value.ts", expectedSha256: input.sha256, content: "export const value = 'new';\n" });
    task.close();
    const planPath = join(current.directory, "task.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.version = 1;
    delete plan.sourceInputs;
    plan.definitionSha256 = createHash("sha256").update(JSON.stringify({ task: plan.task, version: 1,
      grant: plan.grant, contract: plan.contract, instructions: task.describe().instructions })).digest("hex");
    await writeFile(planPath, JSON.stringify(plan));
    await expect(checkCandidateTask(current.directory)).resolves.toMatchObject({ status: "passed", sourceInputsSha256: null });
    await expect(inspectCandidateTask(current.directory)).resolves.toMatchObject({ sourceInputs: null, promotable: false });
    const review = await reviewTask(current.directory);
    await expect(decideTask(current.directory, { decision: "accept", reviewSha256: review.reviewSha256 }))
      .rejects.toThrow("Acceptance requires a passing current check and an admitted source binding");
    await expect(readFile(join(current.directory, "decision.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(promoteTask(current.directory, current.source, "a".repeat(64)))
      .rejects.toMatchObject({ name: "PromotionNotAppliedError" });
    const persisted = JSON.parse(await readFile(planPath, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.sourceInputs).toBeUndefined();
  } finally { await current.cleanup(); }
}, 60_000);
