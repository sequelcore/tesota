import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";
import { applyWorkspace } from "../src/workspace-apply.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Test Git failed");
  return result.stdout;
}

const lines = (values: readonly string[]): string => `${values.join("\n")}\n`;
const original = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

async function fixture(): Promise<{ source: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-update-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  git(source, ["init", "--quiet"]);
  await writeFile(join(source, "a.txt"), lines(original));
  await writeFile(join(source, "b.txt"), "b\n");
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { source, workspace: await Workspace.create(source, join(root, "workspaces"), { sourcesRoot: join(dirname(join(root, "workspaces")), "sources") }) };
}

const read = (path: string): Promise<string> => readFile(path, "utf8");

it("reports nothing when the source did not change", async () => {
  const { workspace } = await fixture();
  await expect(workspace.update()).resolves.toEqual({ status: "current" });
});

it("takes newer source edits as the base when no work is pending", async () => {
  const { source, workspace } = await fixture();
  await writeFile(join(source, "b.txt"), "b edited\n");
  await writeFile(join(source, "c.txt"), "new\n");
  await expect(workspace.update()).resolves.toEqual({ status: "updated", changes: [
    { status: "modified", path: "b.txt" }, { status: "added", path: "c.txt" },
  ] });
  expect(await read(join(workspace.checkout, "c.txt"))).toBe("new\n");
  expect(workspace.snapshot().changes).toEqual([]);
  await expect(workspace.update()).resolves.toEqual({ status: "current" });
});

it("carries pending work onto newer source edits in other files and other lines", async () => {
  const { source, workspace } = await fixture();
  const agent = [...original];
  agent[0] = "ONE";
  await writeFile(join(workspace.checkout, "a.txt"), lines(agent));
  const user = [...original];
  user[7] = "EIGHT";
  await writeFile(join(source, "a.txt"), lines(user));
  await writeFile(join(source, "b.txt"), "b edited\n");
  const update = await workspace.update();
  expect(update.status).toBe("updated");
  expect(await read(join(workspace.checkout, "a.txt"))).toBe(lines(["ONE", ...original.slice(1, 7), "EIGHT"]));
  expect(await read(join(workspace.checkout, "b.txt"))).toBe("b edited\n");
  const snapshot = workspace.snapshot();
  expect(snapshot.changes).toEqual([{ status: "modified", path: "a.txt" }]);
  expect(snapshot.diff).toContain("+ONE");
  expect(snapshot.diff).not.toContain("EIGHT\n+");
  await applyWorkspace(workspace, snapshot);
  expect(await read(join(source, "a.txt"))).toBe(lines(["ONE", ...original.slice(1, 7), "EIGHT"]));
  await expect(workspace.update()).resolves.toEqual({ status: "current" });
});

it("changes nothing when pending work conflicts with newer source edits", async () => {
  const { source, workspace } = await fixture();
  const agent = [...original];
  agent[3] = "agent";
  await writeFile(join(workspace.checkout, "a.txt"), lines(agent));
  const base = workspace.base;
  const user = [...original];
  user[3] = "user";
  await writeFile(join(source, "a.txt"), lines(user));
  await expect(workspace.update()).resolves.toEqual({ status: "conflict", paths: ["a.txt"] });
  expect(workspace.base).toBe(base);
  expect(await read(join(workspace.checkout, "a.txt"))).toBe(lines(agent));
  expect(workspace.snapshot().changes).toEqual([{ status: "modified", path: "a.txt" }]);
  await expect(workspace.update()).resolves.toEqual({ status: "conflict", paths: ["a.txt"] });
});

it("does not report its own applied changes as newer source edits", async () => {
  const { source, workspace } = await fixture();
  await writeFile(join(workspace.checkout, "b.txt"), "applied\n");
  await applyWorkspace(workspace, workspace.snapshot());
  expect(await read(join(source, "b.txt"))).toBe("applied\n");
  await expect(workspace.update()).resolves.toEqual({ status: "current" });
});
