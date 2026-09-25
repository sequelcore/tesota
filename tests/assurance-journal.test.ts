import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendAssurance, decisionEntry, reviewEntry } from "../src/assurance-journal.js";
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
