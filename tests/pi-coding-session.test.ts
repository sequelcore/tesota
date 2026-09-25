import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { confinedPath } from "../src/integrations/pi-coding-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tesota-confine-")));
  roots.push(base);
  const root = join(base, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".git"));
  const outside = join(base, "outside");
  await mkdir(outside);
  return { root, outside };
}

it("allows workspace paths, including files that do not exist yet", async () => {
  const { root } = await fixture();
  expect(confinedPath(root, "src/new/file.ts", true)).toBe(join(root, "src", "new", "file.ts"));
  expect(confinedPath(root, "@src", false)).toBe(join(root, "src"));
  expect(confinedPath(root, undefined, false)).toBe(root);
});

it.each(["../outside/secret", "~/secret"])("rejects %s", async (path) => {
  const { root } = await fixture();
  expect(() => confinedPath(root, path, false)).toThrow("outside the workspace");
});

it("rejects absolute paths and links that leave the workspace", async () => {
  const { root, outside } = await fixture();
  expect(() => confinedPath(root, join(outside, "secret"), false)).toThrow("outside the workspace");
  await symlink(outside, join(root, "link"), "junction");
  expect(() => confinedPath(root, "link/secret", true)).toThrow("outside the workspace");
});

it("lets the agent read but not change Git internals", async () => {
  const { root } = await fixture();
  expect(confinedPath(root, ".git/config", false)).toBe(join(root, ".git", "config"));
  expect(() => confinedPath(root, ".git/config", true)).toThrow(".git");
  expect(() => confinedPath(root, ".GIT/hooks/pre-commit", true)).toThrow(".git");
});
