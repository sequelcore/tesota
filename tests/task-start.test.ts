import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { askTaskStartQuestion, startTask } from "../src/task-start.js";
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
      readFiles: ["docs/guide.md"], writeFiles: ["docs/guide.md"], checks: ["repository-check"], uncertainties: [] },
    dirtyPaths: [], dirtyConflicts: [], checks: [{ id: "repository-check",
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
    check: { task: "proposal-documentation", status: "passed", provenance: "recorded_untrusted", baseline,
      writeSetSha256: "c".repeat(64), taskAcceptance: "not_evaluated",
      diagnostics: ["Repository check not executed in this first slice; review must judge the requested documentation outcome."] } };
}

it("runs one approved proposal through execution, review, decision and promotion without copied lifecycle ids", async () => {
  const current = await fixture();
  const candidate = { directory: join(current.directory, "candidate"), checkout: join(current.directory, "repo"),
    baseline: current.baseline, sourceDirty: false };
  const review = passingReview(candidate.directory, current.baseline);
  const execute = vi.fn(async () => ({ candidate, status: "passed" as const }));
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
  expect(output.join("")).toContain("repository check will not run");
  expect(output.join("")).toContain(JSON.stringify(review.diff));
  expect(progress).toEqual(["awaiting_approval:proposal_scope", "executing:candidate_task",
    "ready_for_review:candidate_review", "promoting:accepted_candidate"]);
  expect(await readFile(join(current.directory, "start.jsonl"), "utf8")).toContain('"outcome":"promoted"');
});

it("creates no run record before approval and rejects replay after a start", async () => {
  const current = await fixture();
  const execute = vi.fn();
  await expect(startTask({ proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.id, ask: async () => "no", write: () => {}, execute })).resolves.toBe(0);
  expect(execute).not.toHaveBeenCalled();
  await expect(readFile(join(current.directory, "start.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const candidate = { directory: "retained-candidate", checkout: "retained-checkout",
    baseline: current.baseline, sourceDirty: false };
  const failed = vi.fn(async () => ({ candidate, status: "failed" as const }));
  const options = { proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.id, ask: async () => "yes", write: () => {}, execute: failed };
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
    execute: async () => ({ candidate, status: "cancelled" }) })).resolves.toBe(130);
  expect(output.join("")).toContain("Execution did not pass");
  expect(await readFile(join(current.directory, "start.jsonl"), "utf8")).toContain('"outcome":"cancelled"');
});

it("records failure and grants no decision when Ctrl+C cancels either approval prompt", async () => {
  const before = await fixture();
  const abort = new DOMException("cancelled", "AbortError");
  await expect(startTask({ proposalsRoot: before.proposalsRoot, sourceDirectory: before.source,
    reference: before.id, ask: async () => { throw abort; }, write: () => {} })).rejects.toMatchObject({ name: "AbortError" });
  await expect(readFile(join(before.directory, "start.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const after = await fixture();
  const candidate = { directory: join(after.directory, "candidate"), checkout: join(after.directory, "repo"),
    baseline: after.baseline, sourceDirty: false };
  const review = passingReview(candidate.directory, after.baseline);
  const decide = vi.fn(); const promote = vi.fn();
  const ask = vi.fn().mockResolvedValueOnce("yes").mockRejectedValueOnce(abort);
  await expect(startTask({ proposalsRoot: after.proposalsRoot, sourceDirectory: after.source,
    reference: after.id, ask, write: () => {}, execute: async () => ({ candidate, status: "passed" }),
    review: async () => review, decide, promote })).rejects.toMatchObject({ name: "AbortError" });
  expect(decide).not.toHaveBeenCalled(); expect(promote).not.toHaveBeenCalled();
  expect(await readFile(join(after.directory, "start.jsonl"), "utf8")).toContain('"outcome":"failed"');
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
    execute: async () => ({ candidate, status: "passed" as const }), review: async () => review,
    decide: async () => ({ ...review, operatorDecision: { record: { format: "tesota-task-decision" as const,
      version: 1 as const, decision: "accept" as const, reviewSha256: review.reviewSha256,
      recordedAt: new Date().toISOString(), authority: "local_operator_assertion" as const },
    provenance: "recorded_untrusted" as const, applicability: "current" as const } }),
    promote: async () => ({ status: "applied" as const, source: current.source,
      files: [{ path: "docs/guide.md", sourceSha256: "d".repeat(64) }] }),
    record: async (_file: unknown, value: object) => {
      const entry = Object.fromEntries(Object.entries(value));
      records.push(entry);
      if (entry["outcome"] === "promoted") throw new Error("synthetic storage failure");
    },
  };
  await expect(startTask(options)).resolves.toBe(1);
  expect(records.some((record) => record["outcome"] === "failed")).toBe(false);
  expect(output.join("")).toContain("Promotion applied, but proposal start evidence is incomplete");
});
