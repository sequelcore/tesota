import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openShellSessionStore } from "../src/shell-session-store.js";
import { Workspace } from "../src/workspace.js";
import { formatPrunePlan, planWorkspacePrune, removeWorkspaces } from "../src/workspace-prune.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Test Git failed");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-prune-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  git(source, ["init", "--quiet"]);
  await writeFile(join(source, "a.txt"), "a\n");
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { root, source, workspaces: join(root, "workspaces"), stores: join(root, "stores") };
}

it("removes only unused, incomplete and stale scratch workspaces", async () => {
  const { source, workspaces, stores } = await fixture();
  const used = await Workspace.create(source, workspaces);
  const pending = await Workspace.create(source, workspaces);
  const unused = await Workspace.create(source, workspaces);
  await writeFile(join(pending.checkout, "b.txt"), "unapplied\n");
  const store = openShellSessionStore(source, stores);
  store.setWorkspace(store.create().id, used.directory);
  store.close();
  const unreadable = join(workspaces, "00000000-0000-4000-8000-000000000000");
  await mkdir(unreadable);
  const staleScratch = join(workspaces, ".snapshot-old");
  await mkdir(staleScratch);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(staleScratch, old, old);
  const recentScratch = join(workspaces, ".snapshot-new");
  await mkdir(recentScratch);

  const plan = await planWorkspacePrune(workspaces, stores);
  expect(new Map(plan.remove.map((entry) => [entry.directory, entry.reason]))).toEqual(new Map([
    [unreadable, "unreadable"], [staleScratch, "scratch"], [unused.directory, "unused"],
  ]));
  expect(new Map(plan.keep.map((entry) => [entry.directory, entry.reason]))).toEqual(new Map([
    [recentScratch, "recent"], [used.directory, "in_use"], [pending.directory, "pending_changes"],
  ]));
  expect(formatPrunePlan(plan)).toContain(`remove  ${unused.directory}  (no session uses it)`);

  await removeWorkspaces(plan);
  expect([unreadable, staleScratch, unused.directory].map(existsSync)).toEqual([false, false, false]);
  expect([recentScratch, used.directory, pending.directory].map(existsSync)).toEqual([true, true, true]);
});

it("keeps every workspace of a repository whose shell is open", async () => {
  const { source, workspaces, stores } = await fixture();
  const unused = await Workspace.create(source, workspaces);
  const store = openShellSessionStore(source, stores);
  try {
    const plan = await planWorkspacePrune(workspaces, stores);
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ directory: unused.directory, reason: "shell_open" }]);
  } finally { store.close(); }
});
