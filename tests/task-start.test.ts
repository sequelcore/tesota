import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { askTaskStartQuestion, startTask } from "../src/task-start.js";
import { createTaskOutcome, loadProposalTaskOutcome, type TaskExecutionAccounting } from "../src/task-outcome.js";
import type { TaskReview } from "../src/task-review.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Fixture Git failed");
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-start-test-"));
  roots.push(root);
  const source = join(root, "source");
  const proposalsRoot = join(root, "proposals");
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "docs", "guide.md"), "# Guide\n");
  git(source, ["init", "--quiet"]); git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  const baseline = git(source, ["rev-parse", "HEAD"]);
  const id = "9877887d-1475-4439-a0a6-c1c85091fc9e";
  const directory = join(proposalsRoot, id);
  await mkdir(directory, { recursive: true });
  const record = {
    format: "tesota-task-proposal", version: 1, id, recordedAt: new Date().toISOString(), source, baseline,
    request: "Explain the flow.", authority: "none", provenance: "model_proposed", status: "ready",
    proposal: { objective: "Explain the flow in plain language.", completionConditions: ["A reader can follow it."],
      readFiles: ["docs/guide.md"], writeFiles: ["docs/guide.md"], checks: ["scope-integrity"], uncertainties: [] },
    dirtyPaths: [], dirtyConflicts: [], checks: [{ id: "scope-integrity",
      definition: "application_owned_declarative_only", executable: false }],
    discovery: { provider: "test", model: "test", inferenceTransport: "configured_provider",
      modelControlledNetwork: false, modelInvocations: 1, toolCalls: 1, operations: 1, exposedBytes: 8,
      limits: { operations: 24, listedFiles: 256, searchMatches: 64, fileBytes: 65536,
        scannedBytes: 524288, exposedBytes: 262144 } },
  };
  await writeFile(join(directory, "proposal.json"), JSON.stringify(record, null, 2) + "\n");
  return { source, proposalsRoot, directory, id, baseline };
}

function passingReview(directory: string, baseline: string): TaskReview {
  return { directory, reviewSha256: "b".repeat(64), diff: "diff --git a/docs/guide.md b/docs/guide.md\n+clear text\n",
    historicalAttempt: "not_evaluated", operatorDecision: null,
    check: { task: "documentation-change", status: "passed", provenance: "recorded_untrusted", baseline,
      writeSetSha256: "c".repeat(64), taskAcceptance: "not_evaluated",
      diagnostics: ["Scope integrity passed. Outcome correctness requires human review."] } };
}

const accounting: TaskExecutionAccounting = { elapsedMs: 100, firstCheck: "check_failed", correctionAttempts: 1,
  modelInvocations: 3, toolCalls: 4, edits: 1,
  consumption: { status: "partial", tokenUsage: "unavailable", cost: "unavailable" } };

it("runs one approved proposal through execution, review, decision and promotion without copied lifecycle ids", async () => {
  const current = await fixture();
  const candidate = { directory: join(current.directory, "candidate"), checkout: join(current.directory, "repo"),
    baseline: current.baseline, sourceDirty: false };
  const review = passingReview(candidate.directory, current.baseline);
  const execute = vi.fn(async () => ({ candidate, status: "passed" as const, accounting }));
  const decide = vi.fn(async () => ({ ...review, operatorDecision: { record: { format: "tesota-task-decision" as const,
    version: 1 as const, decision: "accept" as const, reviewSha256: review.reviewSha256,
    recordedAt: new Date().toISOString(), authority: "local_operator_assertion" as const },
  provenance: "recorded_untrusted" as const, applicability: "current" as const } }));
  const promote = vi.fn(async () => ({ status: "applied" as const, source: current.source,
    files: [{ path: "docs/guide.md", sourceSha256: "d".repeat(64) }] }));
  const output: string[] = [];
  const progress: string[] = [];
  await expect(startTask({ proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.id, ask: vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("yes"),
    write: (text) => output.push(text), report: (event) => progress.push(`${event.phase}:${event.operation}`),
    execute, review: async () => review, decide, promote })).resolves.toBe(0);
  expect(execute).toHaveBeenCalledOnce();
  expect(decide).toHaveBeenCalledWith(candidate.directory, { decision: "accept", reviewSha256: review.reviewSha256 });
  expect(promote).toHaveBeenCalledWith(candidate.directory, current.source, review.reviewSha256);
  expect(output.join("")).toContain("Outcome correctness requires human review");
  expect(output.join("")).toContain(JSON.stringify(review.diff));
  expect(progress).toEqual(["awaiting_approval:proposal_scope", "executing:candidate_task",
    "ready_for_review:candidate_review", "promoting:accepted_candidate"]);
  expect(await readFile(join(current.directory, "start.jsonl"), "utf8")).toContain('"outcome":"promoted"');
  expect(output.join("")).toContain("First check: check_failed\nCorrections: 1");
  await expect(loadProposalTaskOutcome(current.proposalsRoot, current.id)).resolves.toMatchObject({
    status: "promoted", proposalId: current.id, candidate: candidate.directory,
  });
});

it("records scope refusal without granting execution and rejects replay of the exact proposal", async () => {
  const current = await fixture();
  const execute = vi.fn();
  await expect(startTask({ proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.id, ask: async () => "no", write: () => {}, execute })).resolves.toBe(0);
  expect(execute).not.toHaveBeenCalled();
  expect(await readFile(join(current.directory, "start.jsonl"), "utf8")).toContain('"state":"scope_declined"');
  await expect(startTask({ proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.id, ask: async () => "yes", write: () => {}, execute })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();

  const retry = await fixture();
  const candidate = { directory: "retained-candidate", checkout: "retained-checkout",
    baseline: retry.baseline, sourceDirty: false };
  const failed = vi.fn(async () => ({ candidate, status: "failed" as const, accounting }));
  const options = { proposalsRoot: retry.proposalsRoot, sourceDirectory: retry.source,
    reference: retry.id, ask: async () => "yes", write: () => {}, execute: failed };
  await expect(startTask(options)).resolves.toBe(1);
  await expect(startTask(options)).rejects.toThrow();
  expect(failed).toHaveBeenCalledOnce();
});

it("releases each task-start prompt and maps cancellation without promotion", async () => {
  const events: string[] = [];
  const terminal = {
    question: vi.fn(async () => { events.push("question"); return "yes"; }),
    once: vi.fn(() => terminal), removeListener: vi.fn(() => terminal),
    close: vi.fn(() => events.push("close")),
  };
  await expect(askTaskStartQuestion("Approve? ", () => terminal)).resolves.toBe("yes");
  expect(events).toEqual(["question", "close"]);

  const current = await fixture();
  const candidate = { directory: "cancelled-candidate", checkout: "cancelled-checkout",
    baseline: current.baseline, sourceDirty: false };
  const output: string[] = [];
  await expect(startTask({ proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.id, ask: async () => "yes", write: (text) => output.push(text),
    execute: async () => ({ candidate, status: "cancelled", accounting }) })).resolves.toBe(130);
  expect(output.join("")).toContain("Execution did not pass");
  expect(await readFile(join(current.directory, "start.jsonl"), "utf8")).toContain('"outcome":"cancelled"');
});

it("records failure and grants no decision when Ctrl+C cancels either approval prompt", async () => {
  const before = await fixture();
  const abort = new DOMException("cancelled", "AbortError");
  await expect(startTask({ proposalsRoot: before.proposalsRoot, sourceDirectory: before.source,
    reference: before.id, ask: async () => { throw abort; }, write: () => {} })).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(join(before.directory, "start.jsonl"), "utf8")).toContain('"outcome":"cancelled"');

  const after = await fixture();
  const candidate = { directory: join(after.directory, "candidate"), checkout: join(after.directory, "repo"),
    baseline: after.baseline, sourceDirty: false };
  const review = passingReview(candidate.directory, after.baseline);
  const decide = vi.fn(); const promote = vi.fn();
  const ask = vi.fn().mockResolvedValueOnce("yes").mockRejectedValueOnce(abort);
  await expect(startTask({ proposalsRoot: after.proposalsRoot, sourceDirectory: after.source,
    reference: after.id, ask, write: () => {}, execute: async () => ({ candidate, status: "passed", accounting }),
    review: async () => review, decide, promote })).rejects.toMatchObject({ name: "AbortError" });
  expect(decide).not.toHaveBeenCalled(); expect(promote).not.toHaveBeenCalled();
  expect(await readFile(join(after.directory, "start.jsonl"), "utf8")).toContain('"outcome":"cancelled"');
});

it("reports an applied promotion without recording false failure when final start evidence cannot persist", async () => {
  const current = await fixture();
  const candidate = { directory: join(current.directory, "candidate"), checkout: join(current.directory, "repo"),
    baseline: current.baseline, sourceDirty: false };
  const review = passingReview(candidate.directory, current.baseline);
  const records: Record<string, unknown>[] = [];
  const output: string[] = [];
  const options = {
    proposalsRoot: current.proposalsRoot, sourceDirectory: current.source, reference: current.id,
    ask: vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("yes"), write: (text: string) => output.push(text),
    execute: async () => ({ candidate, status: "passed" as const, accounting }), review: async () => review,
    decide: async () => ({ ...review, operatorDecision: { record: { format: "tesota-task-decision" as const,
      version: 1 as const, decision: "accept" as const, reviewSha256: review.reviewSha256,
      recordedAt: new Date().toISOString(), authority: "local_operator_assertion" as const },
    provenance: "recorded_untrusted" as const, applicability: "current" as const } }),
    promote: async () => ({ status: "applied" as const, source: current.source,
      files: [{ path: "docs/guide.md", sourceSha256: "d".repeat(64) }] }),
    createOutcome: async (directory: string, identity: Parameters<typeof createTaskOutcome>[1]) => {
      const journal = await createTaskOutcome(directory, identity);
      return { ...journal, append: async (event: Parameters<typeof journal.append>[0]) => {
        const entry = Object.fromEntries(Object.entries(event)); records.push(entry);
        if (entry["outcome"] === "promoted") throw new Error("synthetic storage failure");
        await journal.append(event);
      } };
    },
  };
  await expect(startTask(options)).resolves.toBe(1);
  expect(records.some((record) => record["outcome"] === "failed")).toBe(false);
  expect(output.join("")).toContain("Promotion applied, but proposal start evidence is incomplete");
  await expect(loadProposalTaskOutcome(current.proposalsRoot, current.id)).resolves.toMatchObject({
    status: "promotion_started", terminal: false, promotion: "unconfirmed",
  });
});
