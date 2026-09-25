import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";
import { applyWorkspace, ApplyConflictError } from "../src/workspace-apply.js";
import { runChecks, suggestChecks } from "../src/workspace-checks.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false",
    "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid", ...args],
  { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Test Git failed");
  return result.stdout;
}

async function fixture(): Promise<{ source: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-workspace-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  git(source, ["init", "--quiet"]);
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\n");
  await writeFile(join(source, "src/old.ts"), "export const old = true;\n");
  await writeFile(join(source, ".gitignore"), "node_modules/\n");
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { source, workspace: await Workspace.create(source, join(root, "workspaces")) };
}

async function changeEverything(workspace: Workspace): Promise<void> {
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  await writeFile(join(workspace.checkout, "src/tax.ts"), "export const tax = 0.2;\n");
  await unlink(join(workspace.checkout, "src/old.ts"));
}

it("describes added, modified and deleted files with a complete diff", async () => {
  const { workspace } = await fixture();
  expect(workspace.snapshot().changes).toEqual([]);
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  expect(snapshot.changes).toEqual([
    { status: "deleted", path: "src/old.ts" },
    { status: "modified", path: "src/price.ts" },
    { status: "added", path: "src/tax.ts" },
  ]);
  expect(snapshot.diff).toContain("+export const tax = 0.2;");
  expect(snapshot.diff).toContain("-export const old = true;");
});

it("reverts work but keeps ignored files such as installed dependencies", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  await mkdir(join(workspace.checkout, "node_modules"));
  await writeFile(join(workspace.checkout, "node_modules/dep.js"), "installed\n");
  workspace.revert();
  expect(workspace.snapshot().changes).toEqual([]);
  expect(existsSync(join(workspace.checkout, "src/tax.ts"))).toBe(false);
  expect(await readFile(join(workspace.checkout, "node_modules/dep.js"), "utf8")).toBe("installed\n");
});

it("applies the reviewed content to the source and makes it the new base", async () => {
  const { source, workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  await expect(applyWorkspace(workspace, snapshot)).resolves.toEqual(snapshot.changes);
  expect(await readFile(join(source, "src/price.ts"), "utf8")).toBe("export const price = 2;\n");
  expect(await readFile(join(source, "src/tax.ts"), "utf8")).toBe("export const tax = 0.2;\n");
  expect(existsSync(join(source, "src/old.ts"))).toBe(false);
  expect(workspace.base).not.toBe(snapshot.base);
  expect(workspace.snapshot().changes).toEqual([]);
  expect(git(source, ["log", "--oneline"]).trim().split("\n")).toHaveLength(1);
});

it("refuses to overwrite files that changed in the source and writes nothing", async () => {
  const { source, workspace } = await fixture();
  await changeEverything(workspace);
  await writeFile(join(source, "src/price.ts"), "export const price = 3;\n");
  const snapshot = workspace.snapshot();
  const failure = applyWorkspace(workspace, snapshot);
  await expect(failure).rejects.toBeInstanceOf(ApplyConflictError);
  await expect(failure).rejects.toMatchObject({ paths: ["src/price.ts"] });
  expect(existsSync(join(source, "src/tax.ts"))).toBe(false);
  expect(existsSync(join(source, "src/old.ts"))).toBe(true);
  expect(workspace.base).toBe(snapshot.base);
});

it("treats a CRLF checkout of the base content as unchanged and keeps its line endings", async () => {
  const { source, workspace } = await fixture();
  await writeFile(join(source, "src/price.ts"), "export const price = 1;\r\n");
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 2;\n");
  await applyWorkspace(workspace, workspace.snapshot());
  expect(await readFile(join(source, "src/price.ts"), "utf8")).toBe("export const price = 2;\r\n");
});

it("refuses content that changed after review", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  await writeFile(join(workspace.checkout, "src/price.ts"), "export const price = 9;\n");
  await expect(applyWorkspace(workspace, snapshot)).rejects.toThrow("changed after review");
});

it("binds check outcomes to the reviewed tree", async () => {
  const { workspace } = await fixture();
  await changeEverything(workspace);
  const snapshot = workspace.snapshot();
  const signal = new AbortController().signal;
  const results = await runChecks(workspace, snapshot, ["node -e \"process.exit(0)\"", "node -e \"process.exit(3)\""], signal);
  expect(results.map((result) => [result.outcome, result.exitCode, result.tree])).toEqual([
    ["passed", 0, snapshot.tree], ["failed", 3, snapshot.tree],
  ]);
  const changing = await runChecks(workspace, snapshot,
    ["node -e \"require('fs').writeFileSync('src/price.ts', 'formatted')\"", "node -e \"process.exit(0)\""], signal);
  expect(changing.map((result) => result.outcome)).toEqual(["changed_files"]);
});

it("suggests the repository's own check script", async () => {
  const { workspace } = await fixture();
  expect(suggestChecks(workspace.checkout)).toEqual([]);
  await writeFile(join(workspace.checkout, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "oxlint" } }));
  expect(suggestChecks(workspace.checkout)).toEqual(["npm run lint", "npm run test"]);
  await writeFile(join(workspace.checkout, "bun.lock"), "");
  await writeFile(join(workspace.checkout, "package.json"), JSON.stringify({ scripts: { check: "all", test: "vitest" } }));
  expect(suggestChecks(workspace.checkout)).toEqual(["bun run check"]);
});
