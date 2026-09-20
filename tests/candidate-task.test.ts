import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask, inspectCandidateTask } from "../src/candidate-task.js";
import { decideTask, reviewTask } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import type { ProposalRunGrant } from "../src/proposal-admission.js";
import { TASK_LIMITS } from "../src/task-contract.js";
import { checkRepositoryTypecheck, type RepositoryTypecheckResult } from "../src/repository-typecheck.js";
import { runPiTask } from "../src/integrations/pi-task.js";

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
  vi.mocked(checkRepositoryTypecheck).mockResolvedValue(typecheckResult("passed"));
});

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
});

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
