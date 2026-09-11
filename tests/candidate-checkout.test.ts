import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { abandonCandidate, cleanCandidateCheckouts, createCandidateCheckout, inspectCandidateCheckout, listCandidateCheckouts } from "../src/candidate-checkout.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const originalChild = await vi.importActual<typeof childProcess>("node:child_process");

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(spawnSync).mockImplementation(originalChild.spawnSync);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, input, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error !== undefined) throw new Error(result.stderr || "Test Git failed");
  return result.stdout;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tesota-checkout-test-"));
  roots.push(root);
  const source = join(root, "source with spaces");
  await mkdir(source);
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.name", "Tesota test"]);
  git(source, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(source, "source.ts"), "export const value = 1;\n");
  await writeFile(join(source, ".gitignore"), "ignored/\n");
  git(source, ["add", "--", "source.ts", ".gitignore"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  return { root, source, candidates: join(root, "candidates"), baseline: git(source, ["rev-parse", "HEAD"]).trim() };
}

it("creates an independent detached checkout and preserves dirty source files, refs, index and config", async () => {
  const { source, candidates, baseline } = await fixture();
  await writeFile(join(source, "source.ts"), "operator work\n");
  git(source, ["add", "source.ts"]);
  await writeFile(join(source, "untracked.txt"), "private\n");
  await mkdir(join(source, "ignored"));
  await writeFile(join(source, "ignored/private.txt"), "private\n");
  const beforeStatus = git(source, ["status", "--porcelain=v1", "-z", "--ignored"]);
  const beforeRefs = git(source, ["show-ref"]);
  const beforeIndex = await readFile(join(source, ".git/index"));
  const beforeConfig = await readFile(join(source, ".git/config"));
  const created = await createCandidateCheckout(source, candidates);
  expect(created).toMatchObject({ baseline, sourceDirty: true });
  expect(await readFile(join(created.checkout, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  expect(await readdir(created.checkout)).not.toContain("untracked.txt");
  expect(await readdir(created.checkout)).not.toContain("ignored");
  expect(git(created.checkout, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD");
  expect(git(created.checkout, ["remote"])).toBe("");
  expect((await inspectCandidateCheckout(created.directory)).changes).toEqual([]);
  expect(await readFile(join(source, ".git/index"))).toEqual(beforeIndex);
  expect(await readFile(join(source, ".git/config"))).toEqual(beforeConfig);
  expect(git(source, ["show-ref"])).toBe(beforeRefs);
  expect(git(source, ["status", "--porcelain=v1", "-z", "--ignored"])).toBe(beforeStatus);
  await writeFile(join(created.checkout, "source.ts"), "candidate change\n");
  expect(await readFile(join(source, "source.ts"), "utf8")).toBe("operator work\n");
  await rm(join(source, ".git"), { recursive: true, force: true });
  expect((await inspectCandidateCheckout(created.directory)).head).toBe(baseline);
});

it("reports staged, untracked and ignored files plus a changed candidate HEAD", async () => {
  const { source, candidates } = await fixture();
  const created = await createCandidateCheckout(source, candidates);
  await writeFile(join(created.checkout, "source.ts"), "export const value = 2;\n");
  git(created.checkout, ["add", "source.ts"]);
  await writeFile(join(created.checkout, "new file.txt"), "untracked");
  await mkdir(join(created.checkout, "ignored"));
  await writeFile(join(created.checkout, "ignored/state"), "ignored");
  expect((await inspectCandidateCheckout(created.directory)).changes).toEqual(expect.arrayContaining([
    { status: "M", path: "source.ts" }, { status: "?", path: "new file.txt" }, { status: "!", path: "ignored/" },
  ]));
  git(created.checkout, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Candidate"]);
  expect((await inspectCandidateCheckout(created.directory)).headChanged).toBe(true);
  expect(git(source, ["rev-parse", "HEAD"]).trim()).toBe(created.baseline);
});

it("accepts a source worktree without changing its shared worktree registry", async () => {
  const { root, source, candidates } = await fixture();
  const worktree = join(root, "worktree");
  git(source, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const before = git(source, ["worktree", "list", "--porcelain"]);
  const created = await createCandidateCheckout(worktree, candidates);
  expect((await inspectCandidateCheckout(created.directory)).headChanged).toBe(false);
  expect(git(source, ["worktree", "list", "--porcelain"])).toBe(before);
});

it("rejects overlapping storage and redirected ancestors before allocating state", async () => {
  const { root, source } = await fixture();
  await expect(createCandidateCheckout(source, join(source, "candidates"))).rejects.toThrow("separate");
  const redirect = join(root, "redirect");
  await symlink(source, redirect, "junction");
  await expect(createCandidateCheckout(source, join(redirect, "new-state"))).rejects.toThrow("redirected");
  expect(await readdir(source)).not.toContain("new-state");
  await rm(redirect);
});

it("rejects tracked symbolic links before allocating a candidate", async () => {
  const { source, candidates } = await fixture();
  const blob = git(source, ["hash-object", "-w", "--stdin"], "../outside\n").trim();
  git(source, ["update-index", "--add", "--cacheinfo", "120000," + blob + ",link"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Unsupported link"]);
  await expect(createCandidateCheckout(source, candidates)).rejects.toThrow("regular tracked files");
  await expect(readdir(candidates)).rejects.toMatchObject({ code: "ENOENT" });
});

it("ignores global checkout filters and ambient Git directory selection", async () => {
  const { root, source, candidates } = await fixture();
  const config = join(root, "global-config");
  await writeFile(config, '[filter "trap"]\n smudge = exit 99\n required = true\n');
  await writeFile(join(source, ".gitattributes"), "source.ts filter=trap\n");
  git(source, ["add", ".gitattributes"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Filter declaration"]);
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_DIR", join(root, "nonexistent"));
  const created = await createCandidateCheckout(source, candidates);
  expect((await inspectCandidateCheckout(created.directory)).changes).toEqual([]);
  expect(await readFile(join(created.checkout, "source.ts"), "utf8")).toBe("export const value = 1;\n");
});

it("rejects remotes, redirected worktree config and incomplete or oversized records", async () => {
  const { source, candidates } = await fixture();
  const created = await createCandidateCheckout(source, candidates);
  const path = join(created.directory, "checkout.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  git(created.checkout, ["remote", "add", "external", "https://example.invalid/repo"]);
  await expect(inspectCandidateCheckout(created.directory)).rejects.toThrow("independent");
  git(created.checkout, ["remote", "remove", "external"]);
  git(created.checkout, ["config", "core.worktree", source]);
  await expect(inspectCandidateCheckout(created.directory)).rejects.toThrow("independent");
  git(created.checkout, ["config", "--unset", "core.worktree"]);
  await writeFile(path, JSON.stringify({ ...record, state: "preparing" }));
  await expect(inspectCandidateCheckout(created.directory)).rejects.toThrow("preparing");
  await writeFile(path, "x".repeat(16_385));
  await expect(inspectCandidateCheckout(created.directory)).rejects.toThrow("Invalid candidate record");
});

it("supports compiled inspection and rejects extra creation arguments", async () => {
  const { source, candidates } = await fixture();
  const created = await createCandidateCheckout(source, candidates);
  const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const inspected = spawnSync("bun", ["--no-env-file", entry, "candidate", "inspect", created.directory], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  expect(inspected.status).toBe(0);
  expect(JSON.parse(inspected.stdout)).toMatchObject({ baseline: created.baseline, changes: [], provenance: "recorded_untrusted" });
  const invalid = spawnSync("bun", ["--no-env-file", entry, "candidate", "create", "--force"], {
    encoding: "utf8", windowsHide: true, timeout: 5_000,
  });
  expect(invalid.status).toBe(2);
});

it("retains failed creation explicitly and never calls the source checkout a candidate", async () => {
  const { source, candidates } = await fixture();
  vi.mocked(spawnSync).mockImplementation((...args) => {
    const commandArgs = args[1];
    if (Array.isArray(commandArgs) && commandArgs.includes("clone")) {
      throw new Error("SYNTHETIC_PRIVATE_GIT_FAILURE");
    }
    return Reflect.apply(originalChild.spawnSync, originalChild, args);
  });
  await expect(createCandidateCheckout(source, candidates)).rejects.toThrow("incomplete state retained");
  const directories = await readdir(candidates);
  expect(directories).toHaveLength(1);
  const name = directories[0];
  if (name === undefined) throw new Error("Missing failed attempt");
  const directory = join(candidates, name);
  const metadata = await readFile(join(directory, "checkout.json"), "utf8");
  expect(JSON.parse(metadata).state).toBe("failed");
  expect(metadata).not.toContain("SYNTHETIC_PRIVATE");
  await expect(inspectCandidateCheckout(directory)).rejects.toThrow("failed");
  expect(await readFile(join(source, "source.ts"), "utf8")).toBe("export const value = 1;\n");
});

it("lists lifecycle states and cleans only old rejected or failed checkouts", async () => {
  const { source, candidates } = await fixture();
  const active = await createCandidateCheckout(source, candidates);
  await writeFile(join(active.directory, "candidate.diff"), "diff\n");
  const rejected = await createCandidateCheckout(source, candidates);
  await writeFile(join(rejected.directory, "decision.json"), JSON.stringify({ decision: "reject" }));
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await utimes(rejected.directory, old, old);
  await expect(listCandidateCheckouts(candidates)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: active.directory.split(/[\\/]/).pop(), status: "awaiting-review", checkoutPresent: true }),
    expect.objectContaining({ id: rejected.directory.split(/[\\/]/).pop(), status: "rejected", checkoutPresent: true }),
  ]));
  await expect(cleanCandidateCheckouts(candidates, 30 * 24 * 60 * 60 * 1000)).resolves.toEqual([rejected.directory.split(/[\\/]/).pop()]);
  await expect(readdir(join(rejected.directory, "repo"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(rejected.directory, "checkout.json"), "utf8")).resolves.toContain("tesota-candidate-checkout");
  await expect(readdir(join(active.directory, "repo"))).resolves.toContain("source.ts");
});

it("preserves lifecycle precedence and treats malformed terminal records as invalid", async () => {
  const { source, candidates } = await fixture();
  const created = await createCandidateCheckout(source, candidates);
  const id = created.directory.split(/[\\/]/).pop();
  if (id === undefined) throw new Error("Missing candidate ID");
  const status = async () => (await listCandidateCheckouts(candidates)).find((candidate) => candidate.id === id)?.status;

  await expect(status()).resolves.toBe("active");
  await writeFile(join(created.directory, "attempt.jsonl"), "attempt\n");
  await expect(status()).resolves.toBe("awaiting-review");
  await writeFile(join(created.directory, "decision.json"), JSON.stringify({ decision: "accept" }));
  await expect(status()).resolves.toBe("accepted");
  await writeFile(join(created.directory, "decision.json"), JSON.stringify({ decision: "other" }));
  await expect(status()).resolves.toBe("invalid");
  await writeFile(join(created.directory, "decision.json"), JSON.stringify({ decision: "accept" }));
  await writeFile(join(created.directory, "abandoned.json"), JSON.stringify({
    format: "tesota-candidate-abandonment", version: 1,
    recordedAt: "2026-09-11T00:00:00.000Z", authority: "local_operator_assertion",
  }));
  await expect(status()).resolves.toBe("abandoned");
  await writeFile(join(created.directory, "abandoned.json"), "{}");
  await expect(status()).resolves.toBe("invalid");

  await rm(join(created.directory, "abandoned.json"));
  await rm(join(created.directory, "decision.json"));
  const recordPath = join(created.directory, "checkout.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, JSON.stringify({ ...record, state: "preparing" }));
  await expect(status()).resolves.toBe("invalid");
  await writeFile(recordPath, JSON.stringify({ ...record, state: "failed" }));
  await expect(status()).resolves.toBe("failed");
});

it("resolves candidate IDs and records explicit abandonment", async () => {
  const { source, candidates } = await fixture();
  const created = await createCandidateCheckout(source, candidates);
  const id = created.directory.split(/[\\/]/).pop();
  if (id === undefined) throw new Error("Missing candidate ID");
  expect((await inspectCandidateCheckout(id, candidates)).directory).toBe(created.directory);
  await expect(abandonCandidate(id, candidates)).resolves.toMatchObject({ id, status: "abandoned" });
  await expect(inspectCandidateCheckout(id, candidates)).resolves.toMatchObject({ directory: created.directory });
  await expect(abandonCandidate(id, candidates)).rejects.toThrow("cannot be abandoned");
});

it.each([
  { version: 99 }, { source: "relative" }, { baseline: "--option" }, { sourceDirty: "false" },
  { authority: "accepted" }, { state: "accepted" },
])("rejects malformed or extra metadata fields: %j", async (mutation) => {
  const { source, candidates } = await fixture();
  const created = await createCandidateCheckout(source, candidates);
  const path = join(created.directory, "checkout.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...record, ...mutation }));
  await expect(inspectCandidateCheckout(created.directory)).rejects.toThrow("Invalid candidate record");
});
