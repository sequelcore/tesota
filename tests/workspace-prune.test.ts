import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openShellSessionStore } from "../src/shell-session-store.js";
import { openShadow, shadowDirectory } from "../src/source-shadow.js";
import { formatSize } from "../src/folder-size.js";
import { Workspace } from "../src/workspace.js";
import { formatPrunePlan, measureWorkspaces, planWorkspacePrune, removeWorkspaces } from "../src/workspace-prune.js";

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

it("removes only unused and unreadable workspaces", async () => {
  const { source, workspaces, stores } = await fixture();
  const used = await Workspace.create(source, workspaces, { sourcesRoot: join(dirname(workspaces), "sources") });
  const pending = await Workspace.create(source, workspaces, { sourcesRoot: join(dirname(workspaces), "sources") });
  const unused = await Workspace.create(source, workspaces, { sourcesRoot: join(dirname(workspaces), "sources") });
  await writeFile(join(pending.checkout, "b.txt"), "unapplied\n");
  const store = openShellSessionStore(source, stores);
  store.setWorkspace(store.create().id, used.directory);
  store.close();
  const unreadable = join(workspaces, "00000000-0000-4000-8000-000000000000");
  await mkdir(unreadable);

  const plan = await planWorkspacePrune(workspaces, stores, join(dirname(workspaces), "sources"),
    join(dirname(workspaces), "source-sessions"));
  expect(new Map(plan.remove.map((entry) => [entry.directory, entry.reason]))).toEqual(new Map([
    [unreadable, "unreadable"], [unused.directory, "unused"],
  ]));
  expect(new Map(plan.keep.map((entry) => [entry.directory, entry.reason]))).toEqual(new Map([
    [used.directory, "in_use"], [pending.directory, "pending_changes"],
  ]));
  expect(formatPrunePlan(plan)).toContain(`remove  ${unused.directory}  (no session uses it)`);

  await removeWorkspaces(plan);
  expect([unreadable, unused.directory].map(existsSync)).toEqual([false, false]);
  expect([used.directory, pending.directory].map(existsSync)).toEqual([true, true]);
});

it("shows what each workspace holds here and what a provider keeps for it, leaving out one that cannot say", async () => {
  const { source, workspaces, stores } = await fixture();
  const sources = join(dirname(workspaces), "sources");
  const workspace = await Workspace.create(source, workspaces, { sourcesRoot: sources });
  const plan = await planWorkspacePrune(workspaces, stores, sources, join(dirname(workspaces), "source-sessions"));
  const measured = await measureWorkspaces(plan, async () => [{ provider: "wsl", bytes: 900 * 1024 * 1024 }]);
  const here = measured.get(workspace.directory)?.here ?? 0;
  expect(here).toBeGreaterThan(0);
  expect(formatPrunePlan(plan, measured)).toContain(`remove  ${workspace.directory}  (no session uses it; ` +
    `${formatSize(here)} on this computer, 900 MB in the WSL sandbox)`);
  const unknown = await measureWorkspaces(plan, async () => []);
  expect(formatPrunePlan(plan, unknown)).toContain(`(no session uses it; ${formatSize(here)} on this computer)
`);
});

it("keeps every workspace of a repository whose shell is open", async () => {
  const { source, workspaces, stores } = await fixture();
  const unused = await Workspace.create(source, workspaces, { sourcesRoot: join(dirname(workspaces), "sources") });
  const store = openShellSessionStore(source, stores);
  try {
    const plan = await planWorkspacePrune(workspaces, stores, join(dirname(workspaces), "sources"),
    join(dirname(workspaces), "source-sessions"));
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([{ directory: unused.directory, reason: "shell_open" }]);
  } finally { store.close(); }
});

it("removes shadow repositories whose source no longer exists, unless a kept workspace was cloned from one", async () => {
  const { root, source, workspaces, stores } = await fixture();
  const sources = join(root, "sources");
  const used = await Workspace.create(source, workspaces, { sourcesRoot: sources });
  const store = openShellSessionStore(source, stores);
  store.setWorkspace(store.create().id, used.directory);
  store.close();
  const usedShadow = shadowDirectory(await realpath(source), sources);
  const gone = join(root, "gone");
  await mkdir(gone);
  await writeFile(join(gone, "notes.txt"), "notes\n");
  const { shadow } = await openShadow(gone, "folder", sources);
  await rm(gone, { recursive: true });
  await rm(source, { recursive: true });

  const plan = await planWorkspacePrune(workspaces, stores, sources, join(root, "source-sessions"));
  expect(plan.shadows).toEqual([{ directory: shadow, reason: "source_gone" }]);
  expect(formatPrunePlan(plan)).toContain(`remove  ${shadow}  (shadow repository; its source no longer exists)`);
  await removeWorkspaces(plan);
  expect(existsSync(shadow)).toBe(false);
  expect(existsSync(usedShadow)).toBe(true);
});

it("removes a session record in the source that no saved session uses, releasing its trees and leaving its changes", async () => {
  const { root, source, workspaces, stores } = await fixture();
  const sources = join(root, "sources");
  const sessions = join(root, "source-sessions");
  const { SourceSession } = await import("../src/source-session.js");
  const used = await SourceSession.create(source, sessions, { sourcesRoot: sources, kind: "repository" });
  const left = await SourceSession.create(source, sessions, { sourcesRoot: sources, kind: "repository" });
  await left.beginTurn();
  await writeFile(join(source, "b.txt"), "the turn's\n");
  await left.endTurn();
  const store = openShellSessionStore(source, stores);
  store.setWorkspace(store.create().id, used.directory);
  store.close();

  const plan = await planWorkspacePrune(workspaces, stores, sources, sessions);
  expect(plan.sessions).toEqual([{ directory: left.directory, reason: "unused" }]);
  expect(formatPrunePlan(plan)).toContain("(session record; no session uses it; its changes stay in your files)");
  await removeWorkspaces(plan);
  expect(existsSync(left.directory)).toBe(false);
  expect(existsSync(used.directory)).toBe(true);
  expect(existsSync(join(source, "b.txt"))).toBe(true);
  const refs = spawnSync("git", ["-C", used.shadow, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).stdout;
  expect(refs).not.toContain(basename(left.directory));
  expect(refs).toContain(basename(used.directory));
});
