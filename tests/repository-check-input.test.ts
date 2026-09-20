import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dependencyInstallationSha256, readDependencyInstallationInput, readRepositoryInput,
  snapshotDependencyInstallation } from "../src/repository-check-input.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof fs>(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(content: string | Buffer): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "tesota-input-test-"));
  roots.push(root);
  const path = join(root, "input");
  await fs.writeFile(path, content);
  return path;
}

it.each([0, 1, 65_537])("reads %i bytes exactly without reserving the policy maximum", async (size) => {
  const content = Buffer.alloc(size, 97);
  const path = await fixture(content);
  const result = await readDependencyInstallationInput(path, 128 * 1024 * 1024);
  expect(result).toEqual(content);
  expect(result.buffer.byteLength).toBeLessThanOrEqual(size + 1);
});

it("accepts the exact bound and rejects an oversized file", async () => {
  const path = await fixture("abc");
  expect(await readRepositoryInput(path, 3)).toEqual(Buffer.from("abc"));
  await expect(readRepositoryInput(path, 2)).rejects.toThrow("Repository check input unavailable");
});

it.each(["abcdef", "a"])("rejects an input changed after observation to %s", async (replacement) => {
  const path = await fixture("abc");
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    await fs.writeFile(path, replacement);
    return await originalOpen(...args);
  });
  await expect(readRepositoryInput(path, 100)).rejects.toThrow("Repository check input unavailable");
});

it("retains the separate source and dependency hardlink policies", async () => {
  const path = await fixture("abc");
  await fs.link(path, `${path}-link`);
  await expect(readRepositoryInput(path, 3)).rejects.toThrow();
  expect(await readDependencyInstallationInput(path, 3)).toEqual(Buffer.from("abc"));
});

it("cancels between reads and closes the open input", async () => {
  const path = await fixture(Buffer.alloc(128 * 1024, 97));
  const controller = new AbortController();
  const originalOpen = fs.open;
  let closed = false;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      controller.abort();
      return result;
    });
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
    return handle;
  });
  await expect(dependencyInstallationSha256(join(path, ".."), false, controller.signal))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(closed).toBe(true);
});

it("removes a cancelled partial snapshot", async () => {
  const path = await fixture("abc");
  const root = join(path, "..");
  const candidate = await fs.mkdtemp(join(tmpdir(), "tesota-input-candidate-"));
  roots.push(candidate);
  const digest = await dependencyInstallationSha256(root);
  const result = await snapshotDependencyInstallation(root, candidate, digest,
    ".tesota-typecheck-dependencies-1234", AbortSignal.abort());
  expect(result).toEqual({ state: "cancelled" });
  expect(await fs.readdir(candidate)).toEqual([]);
});
