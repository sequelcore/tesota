import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { workingTreeDiff } from "../src/working-diff.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

function repository(commit = true): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-working-diff-test-"));
  roots.push(root);
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "--quiet");
  writeFileSync(join(root, "price.ts"), "export const price = 1;\n");
  if (commit) { git("add", "--all"); git("commit", "--quiet", "-m", "Fixture"); }
  return root;
}

/** Every object and index entry in the repository's Git directory, which reading its diff must leave as it was. */
function gitState(root: string): string[] {
  return readdirSync(join(root, ".git"), { recursive: true }).map(String).sort();
}

it("shows everything uncommitted against HEAD, untracked files too, and writes nothing to the repository", () => {
  const root = repository();
  writeFileSync(join(root, "price.ts"), "export const price = 2;\n");
  writeFileSync(join(root, "notes.md"), "mine\n");
  const before = gitState(root);
  const diff = workingTreeDiff(root) ?? "";
  expect(diff).toContain("diff --git a/price.ts b/price.ts");
  expect(diff).toContain("+export const price = 2;");
  expect(diff).toContain("diff --git a/notes.md b/notes.md");
  expect(diff).toContain("+mine");
  expect(gitState(root)).toEqual(before);
});

it("shows nothing for a clean tree, every file for a repository with no commit yet, and no diff outside one", () => {
  expect(workingTreeDiff(repository())).toBe("");
  expect(workingTreeDiff(repository(false))).toContain("+export const price = 1;");
  // A repository at the home folder is not the operator's project, as everywhere in Tesota, so a folder in it has no diff.
  const home = repository();
  const folder = join(home, "documents");
  mkdirSync(folder);
  writeFileSync(join(folder, "letter.md"), "draft\n");
  expect(workingTreeDiff(folder, home)).toBeUndefined();
});

it("reads the whole repository from one of its folders, as git diff HEAD does", () => {
  const root = repository();
  writeFileSync(join(root, "price.ts"), "export const price = 2;\n");
  mkdirSync(join(root, "docs"));
  expect(workingTreeDiff(join(root, "docs"))).toContain("+export const price = 2;");
});

it("reads no file's bytes when the repository configures a Git program of its own", () => {
  const root = repository();
  writeFileSync(join(root, "price.ts"), "export const price = 2;\n");
  spawnSync("git", ["config", "filter.run.clean", "touch ran"], { cwd: root, windowsHide: true });
  expect(workingTreeDiff(root)).toBeUndefined();
});
