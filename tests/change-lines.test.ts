import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { changeLines, numstatRecords } from "../src/change-lines.js";
import { atCommit } from "../src/test-rung.js";

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
    "src/client.ts": "export const generated = 1;\n", "icon.bin": "\u0000a", "src/restored.ts": "export const kept = 1;\n",
    ".gitattributes": "src/client.ts linguist-generated\ntests/gen.test.ts linguist-generated\n" });
  write(root, {
    // Generated, yet a test: it counts in tests and is listed as generated.
    "tests/gen.test.ts": "generated\n",
    // A tool's configuration written in TypeScript is configuration, not implementation.
    "vite.config.ts": "export default {};\n",
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
  // restored.ts was changed during the request and put back as the base has it, so it counts nothing.
  const changed = ["src/price.ts", "src/client.ts", "tests/price.test.ts", "tests/gen.test.ts", "vite.config.ts", "README.md",
    "migrations/001.sql", "logo.png", "icon.bin", "old.md", "src/restored.ts"];
  expect(await changeLines(root, base, changed)).toEqual({
    // price.ts: one line changed and one added; the generated client, the configuration and the SQL count as other.
    implementation: { added: 2, removed: 1 },
    tests: { added: 3, removed: 0 },
    // client.ts +1 -1, vite.config.ts 1, README.md 3 lines without a final newline, the migration 1, old.md removed 1.
    other: { added: 6, removed: 2 },
    binary: ["icon.bin", "logo.png"],
    generated: ["src/client.ts", "tests/gen.test.ts"],
  });
  // The tracked files' counts are Git's own.
  expect(git(root, "diff", "--numstat", base, "--", "src/price.ts").trim()).toBe("2\t1\tsrc/price.ts");
});

it("counts only the files it is given, and every line of each before the first commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-lines-"));
  git(root, "init", "-q");
  write(root, { "src/a.ts": "a\nb\n", "notes.md": "x\n" });
  expect(await changeLines(root, null, ["src/a.ts"])).toEqual({
    implementation: { added: 2, removed: 0 }, tests: { added: 0, removed: 0 }, other: { added: 0, removed: 0 }, binary: [], generated: [] });
});

it("reads a numstat path whole, tabs included", () => {
  expect(numstatRecords("3\t1\tsrc/a\tb.ts\0-\t-\timg.png\0")).toEqual(new Map<string, unknown>([
    ["src/a\tb.ts", { added: 3, removed: 1 }], ["img.png", "binary"]]));
});

it("takes a test as there at the base only when the base held a file at its path, not a folder", async () => {
  const { root, base } = repository({ "tests/kept.test.ts": "x\n", "tests/folder.test.ts/inside.txt": "x\n" });
  expect(await atCommit(root, base, "tests/kept.test.ts")).toBe(true);
  expect(await atCommit(root, base, "tests/folder.test.ts")).toBe(false);
  expect(await atCommit(root, base, "tests/new.test.ts")).toBe(false);
});
