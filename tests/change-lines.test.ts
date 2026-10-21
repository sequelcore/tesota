import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { changeLines } from "../src/change-lines.js";

const git = (root: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
};

const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** A repository with a first commit holding `files`; its commit. */
function repository(files: Readonly<Record<string, string>>): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "tesota-lines-"));
  git(root, "init", "-q");
  write(root, files);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return { root, base: git(root, "rev-parse", "HEAD").trim() };
}

it("counts the change's lines by category as git diff --numstat does, untracked files whole and binary ones apart", async () => {
  const { root, base } = repository({
    "src/price.ts": "export const a = 1;\nexport const b = 2;\n", "old.md": "gone\n",
    "src/client.ts": "export const generated = 1;\n", ".gitattributes": "src/client.ts linguist-generated\n", "icon.bin": "\u0000a" });
  write(root, {
    "src/price.ts": "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n",
    "src/client.ts": "export const generated = 2;\n",
    "tests/price.test.ts": "test\ntest\n",
    "README.md": "one\ntwo\nthree",
    "migrations/001.sql": "create table t (id int);\n",
    "logo.png": "\u0089PNG\u0000\u0001",
    // Tracked and binary: Git counts no lines for it.
    "icon.bin": "\u0000b",
  });
  rmSync(join(root, "old.md"));
  git(root, "add", "src/price.ts", "src/client.ts");
  const changed = ["src/price.ts", "src/client.ts", "tests/price.test.ts", "README.md", "migrations/001.sql", "logo.png", "icon.bin", "old.md"];
  expect(await changeLines(root, base, changed)).toEqual({
    // price.ts: one line changed and one added; the generated client and the SQL count as other, not implementation.
    implementation: { added: 2, removed: 1 },
    tests: { added: 2, removed: 0 },
    // client.ts +1 -1, README.md 3 lines without a final newline, the migration 1, old.md removed 1.
    other: { added: 5, removed: 2 },
    binary: ["icon.bin", "logo.png"],
  });
  // The tracked files' counts are Git's own.
  expect(git(root, "diff", "--numstat", base, "--", "src/price.ts").trim()).toBe("2\t1\tsrc/price.ts");
});

it("counts only the files it is given, and every line of each before the first commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-lines-"));
  git(root, "init", "-q");
  write(root, { "src/a.ts": "a\nb\n", "notes.md": "x\n" });
  expect(await changeLines(root, null, ["src/a.ts"])).toEqual({
    implementation: { added: 2, removed: 0 }, tests: { added: 0, removed: 0 }, other: { added: 0, removed: 0 }, binary: [] });
});
