import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask } from "../src/candidate-task.js";
import { decideTask, reviewTask } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import type { ProposalRunGrant } from "../src/proposal-admission.js";
import { TASK_LIMITS } from "../src/task-contract.js";
import { checkRepositoryTypecheck, type RepositoryTypecheckResult } from "../src/repository-typecheck.js";

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

async function createSource(): Promise<{ root: string; source: string; candidates: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-generic-task-test-"));
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "value.ts"), "export const value = 'old';\n");
  await writeFile(join(source, "src", "reference.ts"), "export const reference = 'context';\n");
  await writeFile(join(source, "README.md"), "untouched\n");
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

async function fixture(isolatedSource = false) {
  const owned = isolatedSource ? await createSource() : undefined;
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
