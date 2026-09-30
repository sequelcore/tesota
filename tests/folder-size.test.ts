import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { folderSize, formatSize } from "../src/folder-size.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("adds the files under a folder, counts a link as itself, and a missing folder as nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-size-"));
  roots.push(root);
  await mkdir(join(root, "inner"));
  await writeFile(join(root, "a.txt"), "x".repeat(100));
  await writeFile(join(root, "inner", "b.txt"), "y".repeat(50));
  const outside = await mkdtemp(join(tmpdir(), "tesota-size-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "big.txt"), "z".repeat(10_000));
  const linked = await symlink(outside, join(root, "link"), "junction").then(() => true, () => false);
  const size = await folderSize(root);
  expect(size).toBeGreaterThanOrEqual(150);
  if (linked) expect(size).toBeLessThan(10_000);
  expect(await folderSize(join(root, "missing"))).toBe(0);
});

it("writes a size in the largest unit that keeps it at least 1", () => {
  expect([0, 512, 1024, 1536, 15 * 1024, 900 * 1024 * 1024, 3.5 * 1024 ** 3].map(formatSize))
    .toEqual(["0 B", "512 B", "1.0 KB", "1.5 KB", "15 KB", "900 MB", "3.5 GB"]);
});
