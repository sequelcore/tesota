import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hasUndecidedTurns } from "../src/source-session.js";
import { holdsSourceFiles, worksInSourceFiles } from "../src/verification/source-holder-rule.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("lets an idle session in the operator's files, with every turn decided, hold nothing (#246)", () => {
  expect(holdsSourceFiles(false, true, false, false)).toBe(false);
  expect(holdsSourceFiles(false, true, true, false)).toBe(true);
  expect(holdsSourceFiles(false, true, false, true)).toBe(true);
  expect(holdsSourceFiles(true, false, false, false)).toBe(true);
  // A session in an isolated copy never holds the operator's files, however busy.
  expect(holdsSourceFiles(false, false, true, true)).toBe(false);
});

it("puts a new session in the operator's files only in a repository, not chosen isolated, and not held elsewhere", () => {
  expect(worksInSourceFiles(true, false, false)).toBe(true);
  expect(worksInSourceFiles(false, false, false)).toBe(false);
  expect(worksInSourceFiles(true, true, false)).toBe(false);
  expect(worksInSourceFiles(true, false, true)).toBe(false);
});

it("counts a session record that cannot be read as holding undecided turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-holder-"));
  roots.push(root);
  expect(hasUndecidedTurns(root)).toBe(true);
  await writeFile(join(root, "session.json"), "{ not json");
  expect(hasUndecidedTurns(root)).toBe(true);
});
