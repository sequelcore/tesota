import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { currentBranch } from "../src/repository-git.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-branch-"));
  roots.push(root);
  const git = (...args: string[]): void => {
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  };
  git("init", "-q", "-b", "feature/web");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return root;
}

it("names the branch checked out, or the short commit when detached, and nothing where Git cannot look", () => {
  const root = repository();
  expect(currentBranch(root)).toBe("feature/web");
  spawnSync("git", ["checkout", "-q", "--detach"], { cwd: root });
  expect(currentBranch(root)).toMatch(/^[0-9a-f]{7,}$/u);
  // A folder may sit inside another repository, so a missing one is the reliable case.
  expect(currentBranch(join(root, "missing"))).toBeUndefined();
});
