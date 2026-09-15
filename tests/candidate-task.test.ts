import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { CandidateTask, checkCandidateTask } from "../src/candidate-task.js";
import { decideTask, reviewTask } from "../src/task-review.js";
import { promoteTask } from "../src/task-promotion.js";
import type { ProposalRunGrant } from "../src/proposal-admission.js";
import { TASK_LIMITS } from "../src/task-contract.js";

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
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "docs", "guide.md"), "# Guide\n\nOld text.\n");
  await writeFile(join(source, "docs", "reference.md"), "# Reference\n");
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
    kind: "documentation-change", proposalId: "b0e37d7c-f19f-4c0c-915c-e52aafea93e7",
    proposalSha256: "a".repeat(64), source, baseline: candidate.baseline,
    objective: "Explain the public workflow.", completionConditions: ["The guide is understandable."],
    readFiles: ["docs/guide.md", "docs/reference.md"], writeFiles: ["docs/guide.md"],
    declaredChecks: ["scope-integrity"],
    verification: { scopeIntegrity: "application_owned", outcome: "human_review_required" },
  };
  return { ...candidate, source, grant, cleanup: async () => {
    if (owned !== undefined) await rm(owned.root, { recursive: true, force: true });
  } };
}

it("derives the bounded tool contract from an approved generic grant", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  expect(task.describe()).toMatchObject({ task: "documentation-change", writeFiles: ["docs/guide.md"],
    check: "scope-integrity", outcome: "human_review_required", limits: TASK_LIMITS });
  expect((await task.read({ path: "docs/reference.md" })).content).toBe("# Reference\n");
  await expect(task.read({ path: "README.md" })).rejects.toThrow("denied");
});

it("requires a check before editing and binds replacement to current bytes", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  const observed = await task.read({ path: "docs/guide.md" });
  await expect(task.replace({ path: "docs/guide.md", expectedSha256: observed.sha256,
    content: "# Guide\n\nClear text.\n" })).rejects.toThrow("denied");

  const next = await fixture();
  const permitted = await CandidateTask.prepare(next.directory, next.grant);
  await permitted.read({ path: "docs/guide.md" });
  expect((await permitted.check()).status).toBe("check_failed");
  await expect(permitted.replace({ path: "docs/guide.md", expectedSha256: "0".repeat(64),
    content: "# Guide\n\nClear text.\n" })).rejects.toThrow("denied");

  const final = await fixture();
  const valid = await CandidateTask.prepare(final.directory, final.grant);
  const baseline = await valid.read({ path: "docs/guide.md" });
  await valid.check();
  await valid.replace({ path: "docs/guide.md", expectedSha256: baseline.sha256,
    content: "# Guide\n\nClear text.\n" });
  expect(await valid.check()).toMatchObject({ status: "passed", provenance: "issued",
    diagnostics: [expect.stringContaining("human review")] });
}, 30_000);

it("rejects an external write and does not reopen a persisted task for editing", async () => {
  const current = await fixture();
  const task = await CandidateTask.prepare(current.directory, current.grant);
  await writeFile(join(current.checkout, "README.md"), "changed outside scope\n");
  await expect(task.check()).rejects.toThrow("denied");
  await expect(checkCandidateTask(current.directory)).rejects.toThrow("scope changed");
  await expect(CandidateTask.prepare(current.directory, current.grant)).rejects.toThrow();
});

it("rejects grant and persisted-plan tampering", async () => {
  const current = await fixture();
  await expect(CandidateTask.prepare(current.directory, { ...current.grant,
    writeFiles: ["README.md"] })).rejects.toThrow();

  const next = await fixture();
  (await CandidateTask.prepare(next.directory, next.grant)).close();
  const planPath = join(next.directory, "task.json");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  plan.contract.objective = "Changed after approval";
  await writeFile(planPath, JSON.stringify(plan));
  await expect(checkCandidateTask(next.directory)).rejects.toThrow("Task plan invalid");
});

it("promotes only the exact accepted candidate bytes while preserving unrelated source state", async () => {
  const current = await fixture(true);
  try {
    const task = await CandidateTask.prepare(current.directory, current.grant);
    const input = await task.read({ path: "docs/guide.md" });
    await task.check();
    await task.replace({ path: "docs/guide.md", expectedSha256: input.sha256, content: "# Guide\n\nClear text.\n" });
    await task.check();
    task.close();
    const review = await reviewTask(current.directory);
    await decideTask(current.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
    const index = await readFile(join(current.source, ".git", "index"));
    await writeFile(join(current.source, "README.md"), "operator work\n");

    const result = await promoteTask(current.directory, current.source, review.reviewSha256);

    expect(result).toMatchObject({ status: "applied", files: [{ path: "docs/guide.md" }] });
    expect(await readFile(join(current.source, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nClear text.\n");
    expect(await readFile(join(current.source, "README.md"), "utf8")).toBe("operator work\n");
    expect(await readFile(join(current.source, ".git", "index"))).toEqual(index);
    expect(createHash("sha256").update("# Guide\n\nClear text.\n").digest("hex"))
      .toBe(result.files[0]?.sourceSha256);
  } finally { await current.cleanup(); }
}, 60_000);
