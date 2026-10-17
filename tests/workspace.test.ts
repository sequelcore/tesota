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

it("is the whole folder, as one in no repository, when it holds no repository directly, and nothing when unreadable", () => {
  expect(workspaceUnits(folder(["notes.md", "lab/package.json", "deep/inner/.git/"]))).toEqual([{ folder: "", repository: false }]);
  expect(workspaceUnits(join(tmpdir(), "tesota-no-such-folder"))).toEqual([]);
});

it("is a home folder itself and its repositories, never its other folders, which hold a person's files (#478)", () => {
  const home = folder(["NTUSER.DAT", "Documents/report.docx", "Downloads/setup.exe", "projects/app/.git/", "site/.git/"]);
  const given = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  try {
    expect(workspaceUnits(home)).toEqual([{ folder: "", repository: false }, { folder: "site", repository: true }]);
  } finally {
    for (const [name, value] of Object.entries(given)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  // The same folder as anyone else's is a workspace of its folders.
  expect(workspaceUnits(home).map(({ folder }) => folder)).toEqual(["", "Documents", "Downloads", "projects", "site"]);
});
