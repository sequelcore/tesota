import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendAssurance, decisionEntry, reviewEntry, triageEntry } from "../src/assurance-journal.js";
import { hostProvider } from "../src/host-environment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("appends each reviewed candidate and the operator's decision, with the evidence behind them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tesota-journal-"));
  roots.push(directory);
  const tree = "t".repeat(40);
  const snapshot = { base: "b".repeat(40), tree, diff: "not journaled", changes: [{ status: "modified" as const, path: "src/a.ts" }] };
  const check = { verifier: "command" as const, command: "bun run check", claim: "exits 0", limits: "only its tests", tree,
    environment: "host", guarantees: hostProvider.guarantees, outcome: "failed" as const, exitCode: 1, durationMs: 3,
    output: `${"x".repeat(5_000)}END` };
  await appendAssurance(directory, reviewEntry(snapshot, ["Fix a"], [check], [{ path: "src/a.test.ts", status: "modified", kind: "test" }],
    [{ reviewer: "Tesota reviewer", tree, status: "incomplete", reason: "stopped" }]));
  await appendAssurance(directory, decisionEntry(tree, "rejected"));
  const lines = (await readFile(join(directory, "assurance.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ kind: "review", base: snapshot.base, tree, requests: ["Fix a"],
    flags: [{ path: "src/a.test.ts", kind: "test" }], reviews: [{ status: "incomplete", reason: "stopped" }],
    checks: [{ verifier: "command", command: "bun run check", claim: "exits 0", outcome: "failed", exitCode: 1 }] });
  const checks = lines[0]?.["checks"] as { output: string }[] | undefined;
  const journaled = checks?.[0]?.output ?? "";
  expect(journaled.endsWith("END")).toBe(true);
  expect(journaled.length).toBe(2_000);
  expect(JSON.stringify(lines[0])).not.toContain("not journaled");
  expect(lines[1]).toMatchObject({ kind: "decision", tree, decision: "rejected" });
});

it("records how deeply a candidate was reviewed and what the review took", () => {
  const tree = "t".repeat(40);
  const depth = { depth: "deep" as const, reasons: ["changes 500 lines"] };
  const measurement = { at: "2026-09-25T00:00:00.000Z", depth: "deep" as const, correction: false, durationMs: 42_000, tokens: 118_000 };
  expect(reviewEntry({ base: "b".repeat(40), tree, diff: "", changes: [] }, [], [], [], [], depth, measurement))
    .toMatchObject({ kind: "review", depth, measurement });
});

it("records every first pass of the answer check, a skip included, with the model and its probability", () => {
  const tree = "t".repeat(40);
  expect(triageEntry(tree, ["hi"], "typesafe:jev-1.13.0",
    { decided: true, checkable: false, probability: 0.09, reason: "Jev: 0.09 checkable" }, false,
    [{ tool: "bash", subject: `curl ${"x".repeat(400)}`, outcome: "failed" }])).toMatchObject({
    kind: "triage", tree, requests: ["hi"], model: "typesafe:jev-1.13.0", decided: true, checkable: false, probability: 0.09,
    reason: "Jev: 0.09 checkable", runsCheck: false,
    toolCalls: [{ tool: "bash", subject: `curl ${"x".repeat(295)}`, outcome: "failed" }] });
  const undecided = triageEntry(tree, ["hi"], "off", { decided: false, checkable: true, reason: "the first pass is off" }, true, []);
  expect(undecided).toMatchObject({ kind: "triage", decided: false, runsCheck: true });
  expect(undecided).not.toHaveProperty("probability");
});
