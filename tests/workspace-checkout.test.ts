import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createWorkspaceCheckout, inspectWorkspaceCheckout } from "../src/workspace-checkout.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const originalChild = await vi.importActual<typeof childProcess>("node:child_process");

const roots: string[] = [];
let templateRoot = "";
let templateSource = "";
let templateBaseline = "";
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockImplementation(originalChild.spawnSync);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
  if (templateRoot !== "") await rm(templateRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "user.name=Tesota test",
    "-c", "user.email=test@example.invalid", ...args],
    { cwd, input, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || "Test Git failed");
  return result.stdout;
}

beforeAll(async () => {
  templateRoot = await mkdtemp(join(tmpdir(), "tesota-checkout-template-"));
  templateSource = join(templateRoot, "source");
  await mkdir(templateSource);
  git(templateSource, ["init", "--quiet"]);
  await writeFile(join(templateSource, "source.ts"), "export const value = 1;\n");
  await writeFile(join(templateSource, ".gitignore"), "ignored/\n");
  git(templateSource, ["add", "--", "source.ts", ".gitignore"]);
  git(templateSource, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  templateBaseline = git(templateSource, ["rev-parse", "HEAD"]).trim();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-checkout-test-"));
  roots.push(root);
  const source = join(root, "source with spaces");
  git(templateSource, ["clone", "--quiet", "--no-local", "--no-hardlinks", "--", templateSource, source]);
  return { root, source, workspaces: join(root, "workspaces"), baseline: templateBaseline };
}

it("includes uncommitted work without changing the source's index, refs, config or objects", async () => {
  const { source, workspaces, baseline } = await fixture();
  await writeFile(join(source, "source.ts"), "operator work\n");
  git(source, ["add", "source.ts"]);
  await writeFile(join(source, "untracked.txt"), "private\n");
  await mkdir(join(source, "ignored"));
  await writeFile(join(source, "ignored/private.txt"), "private\n");
  const beforeStatus = git(source, ["status", "--porcelain=v1", "-z", "--ignored"]);
  const beforeRefs = git(source, ["show-ref"]);
  const beforeIndex = await readFile(join(source, ".git/index"));
  const beforeConfig = await readFile(join(source, ".git/config"));
  const beforeObjects = git(source, ["count-objects", "-v"]);
  const created = await createWorkspaceCheckout(source, workspaces);
  expect(created.baseline).toBe(baseline);
  expect(created.head).not.toBe(baseline);
  expect(created.included).toEqual([{ status: "modified", path: "source.ts" }, { status: "added", path: "untracked.txt" }]);
  expect(await readFile(join(created.checkout, "source.ts"), "utf8")).toBe("operator work\n");
  expect(await readFile(join(created.checkout, "untracked.txt"), "utf8")).toBe("private\n");
  expect(await readdir(created.checkout)).not.toContain("ignored");
  expect(git(created.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD");
  expect(git(created.checkout, ["remote"])).toBe("");
  expect(git(created.checkout, ["status", "--porcelain"])).toBe("");
  expect(await readFile(join(source, ".git/index"))).toEqual(beforeIndex);
  expect(await readFile(join(source, ".git/config"))).toEqual(beforeConfig);
  expect(git(source, ["count-objects", "-v"])).toBe(beforeObjects);
  expect(git(source, ["show-ref"])).toBe(beforeRefs);
  expect(git(source, ["status", "--porcelain=v1", "-z", "--ignored"])).toBe(beforeStatus);
  await writeFile(join(created.checkout, "source.ts"), "workspace change\n");
  expect(await readFile(join(source, "source.ts"), "utf8")).toBe("operator work\n");
  await rm(join(source, ".git"), { recursive: true, force: true });
  expect((await inspectWorkspaceCheckout(created.directory)).head).toBe(created.head);
});

it("sees line endings as the operator's Git does and captures deletions", async () => {
  const { source, workspaces } = await fixture();
  git(source, ["config", "core.autocrlf", "true"]);
  await writeFile(join(source, "source.ts"), "export const value = 1;\r\n");
  await rm(join(source, ".gitignore"));
  const created = await createWorkspaceCheckout(source, workspaces);
  expect(created.included).toEqual([{ status: "deleted", path: ".gitignore" }]);
  expect(await readdir(created.checkout)).not.toContain(".gitignore");
});

it("starts at the committed baseline when the source is clean", async () => {
  const { source, workspaces, baseline } = await fixture();
  const created = await createWorkspaceCheckout(source, workspaces);
  expect(created).toMatchObject({ baseline, head: baseline, included: [] });
});

it("accepts a source worktree without changing its shared worktree registry", async () => {
  const { root, source, workspaces } = await fixture();
  const worktree = join(root, "worktree");
  git(source, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const before = git(source, ["worktree", "list", "--porcelain"]);
  const created = await createWorkspaceCheckout(worktree, workspaces);
  expect((await inspectWorkspaceCheckout(created.directory)).head).toBe(created.baseline);
  expect(git(source, ["worktree", "list", "--porcelain"])).toBe(before);
});

it("rejects overlapping storage and redirected ancestors before allocating state", async () => {
  const { root, source } = await fixture();
  await expect(createWorkspaceCheckout(source, join(source, "workspaces"))).rejects.toThrow("separate");
  const redirect = join(root, "redirect");
  await symlink(source, redirect, "junction");
  await expect(createWorkspaceCheckout(source, join(redirect, "new-state"))).rejects.toThrow("redirected");
  expect(await readdir(source)).not.toContain("new-state");
  await rm(redirect);
});

it("checks tracked symbolic links out as plain files holding the link text", async () => {
  const { source, workspaces } = await fixture();
  const blob = git(source, ["hash-object", "-w", "--stdin"], "../outside\n").trim();
  git(source, ["update-index", "--add", "--cacheinfo", "120000," + blob + ",link"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Link"]);
  git(source, ["checkout", "--", "link"]);
  const created = await createWorkspaceCheckout(source, workspaces);
  expect(created.included).toEqual([]);
  expect(await readFile(join(created.checkout, "link"), "utf8")).toBe("../outside\n");
  expect(git(created.checkout, ["ls-files", "-s", "link"])).toMatch(/^120000 /u);
});

it("rejects an empty commit before allocating a workspace", async () => {
  const { source, workspaces } = await fixture();
  git(source, ["rm", "--quiet", "-r", "--", "."]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Empty"]);
  await expect(createWorkspaceCheckout(source, workspaces)).rejects.toThrow("Workspaces require a commit");
  await expect(readdir(workspaces)).rejects.toMatchObject({ code: "ENOENT" });
});

it("ignores global checkout filters and ambient Git directory selection", async () => {
  const { root, source, workspaces } = await fixture();
  const config = join(root, "global-config");
  await writeFile(config, '[filter "trap"]\n smudge = exit 99\n required = true\n');
  await writeFile(join(source, ".gitattributes"), "source.ts filter=trap\n");
  git(source, ["add", ".gitattributes"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Filter declaration"]);
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_DIR", join(root, "nonexistent"));
  const created = await createWorkspaceCheckout(source, workspaces);
  await expect(inspectWorkspaceCheckout(created.directory)).resolves.toMatchObject({ head: created.baseline });
  expect(await readFile(join(created.checkout, "source.ts"), "utf8")).toBe("export const value = 1;\n");
});

it("rejects remotes, redirected worktree config and incomplete or oversized records", async () => {
  const { source, workspaces } = await fixture();
  const created = await createWorkspaceCheckout(source, workspaces);
  const path = join(created.directory, "checkout.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  git(created.checkout, ["remote", "add", "external", "https://example.invalid/repo"]);
  await expect(inspectWorkspaceCheckout(created.directory)).rejects.toThrow("independent");
  git(created.checkout, ["remote", "remove", "external"]);
  git(created.checkout, ["config", "core.worktree", source]);
  await expect(inspectWorkspaceCheckout(created.directory)).rejects.toThrow("independent");
  git(created.checkout, ["config", "--unset", "core.worktree"]);
  await writeFile(path, JSON.stringify({ ...record, state: "preparing" }));
  await expect(inspectWorkspaceCheckout(created.directory)).rejects.toThrow("preparing");
  await writeFile(path, "x".repeat(16_385));
  await expect(inspectWorkspaceCheckout(created.directory)).rejects.toThrow("Invalid workspace record");
});

it("rejects a recorded source that overlaps workspace storage", async () => {
  const { source, workspaces } = await fixture();
  const created = await createWorkspaceCheckout(source, workspaces);
  const path = join(created.directory, "checkout.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...record, source: workspaces }));
  await expect(inspectWorkspaceCheckout(created.directory)).rejects.toThrow("overlaps source");
});

it("retains failed creation explicitly and never treats the source as a workspace", async () => {
  const { source, workspaces } = await fixture();
  vi.mocked(spawnSync).mockImplementation((...args) => {
    const commandArgs = args[1];
    if (Array.isArray(commandArgs) && commandArgs.includes("clone")) {
      throw new Error("SYNTHETIC_PRIVATE_GIT_FAILURE");
    }
    return Reflect.apply(originalChild.spawnSync, originalChild, args);
  });
  await expect(createWorkspaceCheckout(source, workspaces)).rejects.toThrow("incomplete state retained");
  const directories = await readdir(workspaces);
  expect(directories).toHaveLength(1);
  const name = directories[0];
  if (name === undefined) throw new Error("Missing failed attempt");
  const directory = join(workspaces, name);
  const metadata = await readFile(join(directory, "checkout.json"), "utf8");
  expect(JSON.parse(metadata).state).toBe("failed");
  expect(metadata).not.toContain("SYNTHETIC_PRIVATE");
  await expect(inspectWorkspaceCheckout(directory)).rejects.toThrow("failed");
  expect(await readFile(join(source, "source.ts"), "utf8")).toBe("export const value = 1;\n");
});

it("rejects every malformed or extra metadata field", async () => {
  const { source, workspaces } = await fixture();
  const created = await createWorkspaceCheckout(source, workspaces);
  const path = join(created.directory, "checkout.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  const mutations = [
    { version: 99 }, { source: "relative" }, { baseline: "--option" }, { sourceDirty: "false" },
    { authority: "accepted" }, { state: "accepted" },
  ];
  for (const mutation of mutations) {
    await writeFile(path, JSON.stringify({ ...record, ...mutation }));
    await expect(inspectWorkspaceCheckout(created.directory), JSON.stringify(mutation))
      .rejects.toThrow("Invalid workspace record");
  }
});
