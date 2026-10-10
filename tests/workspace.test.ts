import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { workspaceUnits } from "../src/workspace.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(entries: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-workspace-"));
  roots.push(root);
  for (const entry of entries) {
    mkdirSync(join(root, entry, ".."), { recursive: true });
    if (entry.endsWith("/")) mkdirSync(join(root, entry), { recursive: true }); else writeFileSync(join(root, entry), "");
  }
  return root;
}

it("is the folder itself inside a repository, below its root included", () => {
  const root = folder([".git/", "src/app.ts", "api/.git/"]);
  expect(workspaceUnits(root)).toEqual([{ folder: "", repository: true }]);
  expect(workspaceUnits(join(root, "src"))).toEqual([{ folder: "", repository: true }]);
});

it("is each repository directly inside a folder that is none, each other folder, and the folder's own files", () => {
  const root = folder(["AGENTS.md", "web/.git/", "api/.git", "lab/package.json", "notes/", ".cache/x", "node_modules/x/",
    "deep/inner/.git/"]);
  expect(workspaceUnits(root)).toEqual([{ folder: "", repository: false }, { folder: "api", repository: true },
    { folder: "deep", repository: false }, { folder: "lab", repository: false }, { folder: "notes", repository: false },
    { folder: "web", repository: true }]);
});

it("is nothing in a folder that holds no repository directly, as outside Git", () => {
  expect(workspaceUnits(folder(["notes.md", "lab/package.json", "deep/inner/.git/"]))).toEqual([]);
  expect(workspaceUnits(join(tmpdir(), "tesota-no-such-folder"))).toEqual([]);
});
