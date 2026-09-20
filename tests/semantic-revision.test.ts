import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSemanticRevision, recordSemanticRevision } from "../src/semantic-revision.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tesota-revision-test-"));
  roots.push(root);
  return root;
}

const request = {
  taskDefinitionSha256: "a".repeat(64), parentReviewSha256: "b".repeat(64),
  parentWriteSetSha256: "c".repeat(64), parentCheckSha256: "d".repeat(64),
  parentAttemptSha256: "e".repeat(64),
  refinement: "Keep the existing scope, but use the alternate wording.",
  approvedAt: "2026-09-20T00:00:00.000Z",
};

it("records one bounded authority-free semantic revision and rejects a second", async () => {
  const directory = await fixture();
  const record = await recordSemanticRevision(directory, request);
  expect(record).toMatchObject({ revision: "R1", approval: "local_operator_assertion", authority: "none" });
  await expect(readSemanticRevision(directory)).resolves.toEqual(record);
  await expect(recordSemanticRevision(directory, request)).rejects.toThrow();
});

describe.each(["write", "sync", "close"] as const)("%s failure", (failure) => {
  it("fails closed and cannot report a durable revision", async () => {
    const directory = await fixture();
    const fileSystem = { open: async () => ({
      writeFile: async () => { if (failure === "write") throw new Error("write failed"); },
      sync: async () => { if (failure === "sync") throw new Error("sync failed"); },
      close: async () => { if (failure === "close") throw new Error("close failed"); },
    }) };
    await expect(recordSemanticRevision(directory, request, fileSystem)).rejects.toThrow(
      "Semantic revision persistence failed",
    );
    await expect(readSemanticRevision(directory)).resolves.toBeNull();
  });
});

it("rejects a partial record as authority-free invalid evidence", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "semantic-revision.json"), '{"format":"tesota-semantic-revision"');
  await expect(readSemanticRevision(directory)).rejects.toThrow();
});
