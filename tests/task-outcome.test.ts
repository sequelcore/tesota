import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTaskOutcome, formatTaskOutcome, loadTaskOutcome } from "../src/task-outcome.js";

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
  expect(formatTaskOutcome(outcome)).toContain("Application: Applied\n");
});

it("records a declined proposal without creating execution authority and rejects replay", async () => {
  const directory = await fixture();
  const journal = await createTaskOutcome(directory, identity);
  await journal.append({ state: "scope_declined" });
  await journal.close();
  const outcome = await loadTaskOutcome(directory);
  expect(outcome).toMatchObject({ status: "scope_declined", terminal: true,
    candidate: null, operator: { scopeApproval: "declined", decision: "not_reached" }, promotion: "not_reached" });
  expect(formatTaskOutcome(outcome)).toContain("Application: Not applied\n");
  await expect(createTaskOutcome(directory, identity)).rejects.toThrow();
});

it("reports unconfirmed application without implying that no write occurred", async () => {
  const directory = await fixture();
  const journal = await createTaskOutcome(directory, identity);
  await journal.append({ state: "execution_started" });
  await journal.append({ state: "execution_finished", candidate: "candidate-1", result: {
    status: "passed", accounting: { elapsedMs: 100, firstCheck: "check_failed", correctionAttempts: 1,
      modelInvocations: 1, toolCalls: 2, edits: 1,
      consumption: { status: "partial", tokenUsage: "unavailable", cost: "unavailable" } },
  } });
  await journal.append({ state: "review_ready", reviewSha256: "c".repeat(64), checkStatus: "passed" });
  await journal.append({ state: "decision_recorded", decision: "accept", reviewSha256: "c".repeat(64) });
  await journal.append({ state: "promotion_started", reviewSha256: "c".repeat(64) });

  expect(formatTaskOutcome(journal.current())).toContain(
    "Application: Unconfirmed; inspect retained evidence before retrying\n",
  );
  await journal.close();
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
