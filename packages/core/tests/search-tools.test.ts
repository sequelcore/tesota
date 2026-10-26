import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, ripgrepPath, runRipgrep } from "../src/ripgrep.ts";
import type { EngineTool } from "../src/tool.ts";
import { codingTools } from "../src/tools/index.ts";

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 3 }); });
const folder = (): string => {
  const path = mkdtempSync(join(tmpdir(), "tesota-search-"));
  folders.push(path);
  return path;
};
const run = (cwd: string, name: string, args: unknown, signal = new AbortController().signal) => {
  const tool: EngineTool | undefined = codingTools(cwd, () => cwd).find((tool) => tool.name === name);
  if (tool === undefined) throw new Error(`Missing tool: ${name}`);
  expect(tool.access).toBe("read");
  return tool.execute(args as never, signal, "search");
};

test("source uses the vendored executable and a missing executable explains setup", async () => {
  expect(await ripgrepPath()).toContain(join("vendor", "ripgrep"));
  await expect(ripgrepPath(join(folder(), "missing"))).rejects.toThrow("bun run vendor");
});

for (const repository of [false, true]) {
  test(`search tools explore ${repository ? "Git" : "plain"} folders with ignores and hidden files`, async () => {
    const cwd = folder();
    if (repository) expect(Bun.spawnSync(["git", "init", cwd]).exitCode).toBe(0);
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(cwd, ".ignore"), "other.txt\n");
    for (const name of ["tracked.txt", "untracked.txt", ".hidden.txt", "ignored.txt", "other.txt"]) {
      writeFileSync(join(cwd, name), "before\n-needle\nAFTER\n");
    }
    if (repository) expect(Bun.spawnSync(["git", "-C", cwd, "add", "tracked.txt"]).exitCode).toBe(0);
    else { mkdirSync(join(cwd, ".git")); writeFileSync(join(cwd, ".git", "secret.txt"), "-needle"); }
    const ls = await run(cwd, "ls", {});
    expect(ls.text.split("\n")).toEqual([".git/", ".gitignore", ".hidden.txt", ".ignore", "ignored.txt", "other.txt", "tracked.txt", "untracked.txt"]);
    expect((await run(cwd, "find", { pattern: "**/*.txt" })).text).toBe(".hidden.txt\ntracked.txt\nuntracked.txt");
    const grep = await run(cwd, "grep", { pattern: "-needle", glob: "*.txt" });
    expect(grep.text.split("\n")).toEqual([".hidden.txt:2:-needle", "tracked.txt:2:-needle", "untracked.txt:2:-needle"]);
    expect((await run(cwd, "grep", { pattern: "after", path: "tracked.txt", ignoreCase: true, context: 1 })).text)
      .toBe("tracked.txt-2--needle\ntracked.txt:3:AFTER");
    expect((await run(cwd, "find", { pattern: "*.txt", limit: 1 })).text).toContain("2 files omitted");
    expect((await run(cwd, "ls", { limit: 1 })).text).toContain("7 entries omitted");
    expect((await run(cwd, "grep", { pattern: "needle", limit: 1 })).text).toContain("truncated");
  });
}

test("tools reject missing folders and cancellation", async () => {
  const cwd = folder();
  for (const [name, args] of [["ls", {}], ["find", { pattern: "*" }], ["grep", { pattern: "x" }]] as const) {
    await expect(run(cwd, name, { ...args, path: "missing" })).rejects.toThrow();
    await expect(run(cwd, name, args, AbortSignal.abort())).rejects.toThrow();
  }
  await expect(listFiles(cwd, { signal: AbortSignal.abort() })).rejects.toThrow();
  await expect(listFiles(cwd, { timeoutMs: 0 })).rejects.toThrow();
});

test("output size is capped, and the lister reports the exact omitted count", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, "large.txt"), `needle${"x".repeat(100_000)}\nneedle\n`);
  const result = await run(cwd, "grep", { pattern: "needle" });
  expect(result.text).toContain("truncated");
  expect(Buffer.byteLength(result.text)).toBeLessThan(52_000);
  expect(await listFiles(cwd, { limit: 0 })).toEqual({ files: [], omitted: 1 });
  expect((await run(cwd, "grep", { pattern: "absent" })).text).toBe("No matches found");
});

test("cancellation during ripgrep output is awaited, and a full consumer stops receiving records", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, "notes.txt"), "needle\n".repeat(5000));
  const controller = new AbortController();
  await expect(runRipgrep(cwd, ["--regexp", "needle", "."], controller.signal, () => {
    controller.abort();
    return true;
  })).rejects.toThrow();
  let records = 0;
  await runRipgrep(cwd, ["--regexp", "needle", "."], new AbortController().signal, () => { records++; return false; });
  expect(records).toBe(1);
});

test("recursive searches preserve the read permission floor for protected descendants", async () => {
  const cwd = folder();
  writeFileSync(join(cwd, ".env"), "secret-marker\n");
  writeFileSync(join(cwd, ".env.production"), "secret-marker\n");
  writeFileSync(join(cwd, "notes.txt"), "ordinary\n");
  expect((await run(cwd, "grep", { pattern: "secret-marker" })).text).toBe("No matches found");
  expect((await run(cwd, "find", { pattern: ".env*" })).text).toBe("No files found matching pattern");
  await expect(run(cwd, "grep", { pattern: "secret-marker", path: ".env" })).rejects.toThrow();
});

test("selecting .git as the search root does not expose its private files", async () => {
  const cwd = folder();
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "probe.txt"), "private-marker\n");
  expect((await run(cwd, "find", { pattern: "*", path: ".git" })).text).toBe("No files found matching pattern");
  expect((await run(cwd, "grep", { pattern: "private-marker", path: ".git" })).text).toBe("No matches found");
});
