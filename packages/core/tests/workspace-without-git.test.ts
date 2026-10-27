import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindWorkspace, outsideChange } from "../src/workspace.ts";

// The docs promise that outside a repository Tesota measures from its own snapshot. A machine without Git at all
// must get the same, not a crash at startup: Bun.spawnSync throws when the program is missing.
const saved = { PATH: process.env["PATH"], Path: process.env["Path"] };
const folders: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function withoutGit(): void {
  const empty = mkdtempSync(join(tmpdir(), "tesota-no-git-path-"));
  folders.push(empty);
  process.env["PATH"] = empty;
  if (process.platform === "win32") process.env["Path"] = empty;
}

test("a folder opens as a session's workspace when Git is not installed", () => {
  const folder = mkdtempSync(join(tmpdir(), "tesota-no-git-"));
  folders.push(folder);
  withoutGit();
  const workspace = bindWorkspace(folder, "no-git");
  expect(workspace.cwd.toLowerCase()).toBe(folder.toLowerCase());
  workspace.release();
});

test("a path inside the folder is not an outside change when Git is not installed", () => {
  const folder = mkdtempSync(join(tmpdir(), "tesota-no-git-"));
  folders.push(folder);
  withoutGit();
  expect(outsideChange(join(folder, "notes.md"), folder)).toBe(false);
});
