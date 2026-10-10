import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { gitEnvironment } from "../src/git.js";
import { SNAPSHOT_LIMITS, takeSnapshot } from "../src/snapshot.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-snapshot-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The files the snapshot of `root` holds, read with the Git it uses there. */
function snapshotted(root: string): string[] {
  const listed = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8", env: gitEnvironment(root) });
  expect(listed.status).toBe(0);
  return listed.stdout.split("\n").filter((path) => path !== "").sort();
}

it("snapshots a folder's files outside it, leaving secrets, dependencies and build output out and the folder as it was", async () => {
  const root = folder({ "budget.csv": "a,b\n", "notes/todo.md": "- one\n", ".env": "KEY=1\n", ".env.local": "KEY=2\n",
    "node_modules/dep/index.js": "x\n", "dist/out.js": "x\n", "ignored.log": "x\n", ".gitignore": "*.log\n" });
  const snapshot = await takeSnapshot(root, false);
  expect(snapshot).toMatchObject({ tooLarge: [] });
  expect(snapshotted(root)).toEqual([".gitignore", "budget.csv", "notes/todo.md"]);
  expect(readdirSync(root).sort()).toEqual([".env", ".env.local", ".gitignore", "budget.csv", "dist", "ignored.log", "node_modules", "notes"]);
  // A later snapshot is a new base holding the folder as it then is.
  writeFileSync(join(root, "budget.csv"), "a,b,c\n");
  const later = await takeSnapshot(root, false);
  expect("base" in later && "base" in snapshot && later.base !== snapshot.base).toBe(true);
});

it("takes only the folder's own files when asked, and leaves out a file over the size limit, naming it", async () => {
  const root = folder({ "AGENTS.md": "# Rules\n", "lab/package.json": "{}", "big.bin": "" });
  writeFileSync(join(root, "big.bin"), Buffer.alloc(SNAPSHOT_LIMITS.fileBytes + 1));
  expect(await takeSnapshot(root, true)).toMatchObject({ tooLarge: ["big.bin"] });
  expect(snapshotted(root)).toEqual(["AGENTS.md"]);
});

it("refuses a home folder, a drive's root, and a folder past the limits, saying why", async () => {
  expect(await takeSnapshot(homedir(), false)).toEqual({ refused: "Tesota does not snapshot a home folder or a drive's root" });
  expect(await takeSnapshot(join(tmpdir(), "..", "..", "..", "..", "..", ".."), false))
    .toEqual({ refused: "Tesota does not snapshot a home folder or a drive's root" });
  const root = folder({ "a.md": "", "b.md": "", "c.md": "" });
  expect(await takeSnapshot(root, false, { ...SNAPSHOT_LIMITS, files: 2 }))
    .toEqual({ refused: "it holds more than 2 files, past what Tesota snapshots" });
  expect(existsSync(join(root, ".git"))).toBe(false);
});
