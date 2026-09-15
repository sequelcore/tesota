import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTaskOutcome, formatTaskOutcome, formatTaskOutcomes, listProposalTaskOutcomes,
  loadTaskOutcome } from "../src/task-outcome.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tesota-outcome-test-"));
  roots.push(directory);
  return directory;
}

const identity = {
  proposalId: "9877887d-1475-4439-a0a6-c1c85091fc9e",
  proposalSha256: "a".repeat(64), baseline: "b".repeat(40),
};

async function proposalFixture(root: string, id: string): Promise<{
  readonly directory: string; readonly identity: typeof identity;
}> {
  const source = join(root, "source");
  const proposals = join(root, "proposals");
  const directory = join(proposals, id);
  await mkdir(source, { recursive: true });
  await mkdir(directory, { recursive: true });
  const record = {
    format: "tesota-task-proposal", version: 1, id, recordedAt: "2026-09-15T00:00:00.000Z",
    source, baseline: "b".repeat(40), request: "Update the guide", authority: "none",
    provenance: "model_proposed", status: "ready",
    proposal: { objective: "Update the guide", completionConditions: ["The guide is current"],
      readFiles: ["docs/guide.md"], writeFiles: ["docs/guide.md"], checks: ["scope-integrity"], uncertainties: [] },
    dirtyPaths: [], dirtyConflicts: [],
    checks: [{ id: "scope-integrity", definition: "application_owned_declarative_only", executable: false }],
    discovery: { provider: "test", model: "test", inferenceTransport: "configured_provider",
      modelControlledNetwork: false, modelInvocations: 1, toolCalls: 1, operations: 1, exposedBytes: 1,
      limits: { operations: 32, listedFiles: 512, searchMatches: 40, fileBytes: 131072,
        scannedBytes: 8388608, exposedBytes: 1048576 } },
  } as const;
  const content = JSON.stringify(record, null, 2) + "\n";
  await writeFile(join(directory, "proposal.json"), content);
  return { directory, identity: { proposalId: id,
    proposalSha256: createHash("sha256").update(content).digest("hex"), baseline: record.baseline } };
}

it("recovers a promoted task with separate execution, decision and adoption facts", async () => {
  const directory = await fixture();
  const times = [0, 100, 500, 700, 800, 900, 1_200].map((offset) =>
    new Date(Date.parse("2026-09-15T00:00:00.000Z") + offset));
  const journal = await createTaskOutcome(directory, identity, () => times.shift() ?? new Date(0));
  await journal.append({ state: "execution_started" });
  await journal.append({ state: "execution_finished", candidate: "candidate-1", result: {
    status: "passed", accounting: { elapsedMs: 400, firstCheck: "check_failed", correctionAttempts: 1,
      modelInvocations: 3, toolCalls: 4, edits: 1,
      consumption: { status: "partial", tokenUsage: "unavailable", cost: "unavailable" } },
  } });
  await journal.append({ state: "review_ready", reviewSha256: "c".repeat(64), checkStatus: "passed" });
  await journal.append({ state: "decision_recorded", decision: "accept", reviewSha256: "c".repeat(64) });
  await journal.append({ state: "promotion_started", reviewSha256: "c".repeat(64) });
  await journal.append({ state: "finished", outcome: "promoted",
    files: [{ path: "docs/guide.md", sourceSha256: "d".repeat(64) }] });
  await journal.close();

  const outcome = await loadTaskOutcome(directory);
  expect(outcome).toMatchObject({ status: "promoted", terminal: true, elapsedMs: 1200,
    candidate: "candidate-1", firstCheck: "check_failed", correctionAttempts: 1,
    operator: { scopeApproval: "approved", decision: "accept" },
    promotion: "applied", authority: "none", provenance: "recorded_untrusted" });
  expect(formatTaskOutcome(outcome)).toContain("Outcome: promoted\nElapsed: 1200 ms\nLast phase: promotion_started\n" +
    "First check: check_failed\nCorrections: 1\n");
});

it("records a declined proposal without creating execution authority and rejects replay", async () => {
  const directory = await fixture();
  const journal = await createTaskOutcome(directory, identity);
  await journal.append({ state: "scope_declined" });
  await journal.close();
  await expect(loadTaskOutcome(directory)).resolves.toMatchObject({ status: "scope_declined", terminal: true,
    candidate: null, operator: { scopeApproval: "declined", decision: "not_reached" }, promotion: "not_reached" });
  await expect(createTaskOutcome(directory, identity)).rejects.toThrow();
});

it("rejects malformed, excess and impossible recovered histories", async () => {
  const directory = await fixture();
  const journal = await createTaskOutcome(directory, identity);
  await journal.close();
  const path = join(directory, "start.jsonl");
  const initial = await readFile(path, "utf8");
  await writeFile(path, initial + JSON.stringify({ state: "promotion_started", timestamp: new Date().toISOString(),
    reviewSha256: "c".repeat(64) }) + "\n");
  await expect(loadTaskOutcome(directory)).rejects.toThrow("Task outcome unavailable");
  await writeFile(path, initial + JSON.stringify({ state: "scope_declined", timestamp: new Date().toISOString(),
    extra: true }) + "\n");
  await expect(loadTaskOutcome(directory)).rejects.toThrow("Task outcome unavailable");
  await writeFile(path, "{\n");
  await expect(loadTaskOutcome(directory)).rejects.toThrow("Task outcome unavailable");
});

it("lists only started proposals, newest first, and keeps corrupt starts visible", async () => {
  const root = await fixture();
  const older = await proposalFixture(root, "9877887d-1475-4439-a0a6-c1c85091fc9e");
  const newer = await proposalFixture(root, "7877887d-1475-4439-a0a6-c1c85091fc9e");
  await proposalFixture(root, "6877887d-1475-4439-a0a6-c1c85091fc9e");
  const corrupt = await proposalFixture(root, "5877887d-1475-4439-a0a6-c1c85091fc9e");

  const oldJournal = await createTaskOutcome(older.directory, older.identity,
    () => new Date("2026-09-15T00:00:00.000Z"));
  await oldJournal.append({ state: "scope_declined" });
  await oldJournal.close();
  const newJournal = await createTaskOutcome(newer.directory, newer.identity,
    () => new Date("2026-09-15T01:00:00.000Z"));
  await newJournal.close();
  await writeFile(join(corrupt.directory, "start.jsonl"), "{\n");

  const outcomes = await listProposalTaskOutcomes(join(root, "proposals"));
  expect(outcomes).toHaveLength(3);
  expect(outcomes.map((entry) => entry.availability === "available" ? entry.outcome.proposalId : entry.proposalId))
    .toEqual([newer.identity.proposalId, older.identity.proposalId, corrupt.identity.proposalId]);
  expect(outcomes.at(-1)).toEqual({ availability: "unavailable", proposalId: corrupt.identity.proposalId });
  const formatted = formatTaskOutcomes(outcomes);
  expect(formatted).toContain(`${corrupt.identity.proposalId}  unavailable`);
  expect(formatted).not.toContain("Update the guide");
  expect(formatted).not.toContain(join(root, "source"));
});

it("reports an empty outcome projection before the first attempted proposal", async () => {
  const root = await fixture();
  await expect(listProposalTaskOutcomes(join(root, "missing"))).resolves.toEqual([]);
  expect(formatTaskOutcomes([])).toBe("No task outcomes recorded.\n");
});
