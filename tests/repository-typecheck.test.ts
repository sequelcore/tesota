import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { REPOSITORY_TYPECHECK_PROFILE, formatRepositoryTypecheckProfile, prepareRepositoryTypecheck,
  runRepositoryTypecheck } from "../src/repository-typecheck.js";
import * as repositoryCheckInput from "../src/repository-check-input.js";
import type { RepositoryTypecheckExecutor } from "../src/repository-typecheck-process.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false", "-c", "user.name=Tesota test", "-c", "user.email=test@example.invalid",
    ...args], { cwd, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error(result.stderr || "Git fixture failed");
  return result.stdout;
}

async function fixture(script = "tsc --noEmit -p tsconfig.json"): Promise<{
  readonly root: string; readonly source: string; readonly candidate: Awaited<ReturnType<typeof createCandidateCheckout>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "tesota-typecheck-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { typecheck: script },
    devDependencies: { typescript: "7.0.2" } }, null, 2) + "\n");
  await writeFile(join(source, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true },
    include: ["src/**/*.ts"] }, null, 2) + "\n");
  await writeFile(join(source, "bun.lock"), "lockfile fixture\n");
  await writeFile(join(source, ".gitignore"), "node_modules/\n");
  await writeFile(join(source, "src/value.ts"), "export const value: string = 'ok';\n");
  git(source, ["init", "--quiet"]);
  git(source, ["add", "--", ".gitignore", "package.json", "tsconfig.json", "bun.lock", "src/value.ts"]);
  git(source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  await mkdir(join(source, "node_modules", "typescript", "bin"), { recursive: true });
  await mkdir(join(source, "node_modules", "@typescript", "typescript-linux-x64"), { recursive: true });
  await writeFile(join(source, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2" }) + "\n");
  await writeFile(join(source, "node_modules", "typescript", "bin", "tsc"), "compiler fixture\n");
  await writeFile(join(source, "node_modules", "@typescript", "typescript-linux-x64", "package.json"),
    JSON.stringify({ name: "@typescript/typescript-linux-x64", version: "7.0.2" }) + "\n");
  const candidate = await createCandidateCheckout(source, join(root, "candidates"));
  return { root, source, candidate };
}

async function runtime(root: string): Promise<{ readonly executable: string; readonly executableSha256: string }> {
  const executable = join(root, "trusted", process.platform === "win32" ? "docker.exe" : "docker");
  if (!isAbsolute(executable)) throw new Error("Fixture runtime must be absolute");
  await mkdir(join(root, "trusted"), { recursive: true });
  await writeFile(executable, "docker fixture\n");
  return { executable, executableSha256: createHash("sha256").update("docker fixture\n").digest("hex") };
}

const passed: RepositoryTypecheckExecutor = async () => ({ status: "closed", exitCode: 0, signal: null,
  stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), process: "exited", container: "absent" });

it("admits the canonical repository declaration and binds the isolated compiler inputs", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });

  expect(profile).toMatchObject({ profile: REPOSITORY_TYPECHECK_PROFILE,
    candidate: { baseline: current.candidate.baseline },
    repository: { script: "tsc --noEmit -p tsconfig.json" },
    verifier: { packageVersion: "7.0.2" },
    isolation: { image: expect.stringMatching(/^node@sha256:/u), executableSha256: expect.stringMatching(/^[a-f\d]{64}$/u) },
    command: ["node", "/dependencies/node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false",
      "--pretty", "false", "-p", "tsconfig.json"],
    authority: "local_operator_approval_required" });
  expect(profile.candidate.contentSha256).toMatch(/^[a-f\d]{64}$/u);
  expect(profile.verifier.installationSha256).toMatch(/^[a-f\d]{64}$/u);
  expect(formatRepositoryTypecheckProfile(profile)).toContain("candidate and dependencies read-only; network denied");
});

it("accepts a hardlinked Bun dependency only by mounting an exclusive copied snapshot", async () => {
  const current = await fixture();
  const compiler = join(current.source, "node_modules", "typescript", "bin", "tsc");
  const manifest = join(current.source, "node_modules", "typescript", "package.json");
  await link(compiler, join(current.source, "typescript-hardlink-source"));
  await link(manifest, join(current.source, "typescript-hardlink-manifest-source"));
  expect((await lstat(compiler)).nlink).toBeGreaterThan(1);
  expect((await lstat(manifest)).nlink).toBeGreaterThan(1);
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  expect((await readdir(current.candidate.directory)).some((name) => name.startsWith(".tesota-typecheck-dependencies-"))).toBe(false);
  const executor = vi.fn<RepositoryTypecheckExecutor>(async (invocation) => {
    const mount = invocation.args.find((argument) => argument.includes("target=/dependencies/node_modules,readonly"));
    expect(mount).toBeDefined();
    const snapshot = /source=([^,]+)/u.exec(mount ?? "")?.[1];
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toBe(profile.isolation.nodeModules);
    expect(snapshot).toMatch(new RegExp(`^${current.candidate.directory.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}`));
    expect((await lstat(join(snapshot ?? "", "typescript", "bin", "tsc"))).nlink).toBe(1);
    return { status: "closed", exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      process: "exited", container: "absent" };
  });

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "passed", reason: null });
  expect(executor).toHaveBeenCalledOnce();
  expect((await readdir(current.candidate.directory)).some((name) => name.startsWith(".tesota-typecheck-dependencies-"))).toBe(false);
});

it("retains the candidate-owned snapshot when container settlement is unconfirmed", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  let snapshot: string | undefined;
  const executor: RepositoryTypecheckExecutor = async (invocation) => {
    const mount = invocation.args.find((argument) => argument.includes("target=/dependencies/node_modules,readonly"));
    snapshot = /source=([^,]+)/u.exec(mount ?? "")?.[1];
    return { status: "failed", reason: "cleanup_unconfirmed", process: "unconfirmed", container: "unconfirmed", pid: 42 };
  };

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "execution_failed",
    reason: "cleanup_unconfirmed", process: "unconfirmed", container: "unconfirmed" });
  expect((await lstat(snapshot ?? "")).isDirectory()).toBe(true);
});

it("removes the dependency snapshot when cancellation settles before process dispatch", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  const executor: RepositoryTypecheckExecutor = async () => ({ status: "failed", reason: "cancelled",
    process: "not_started", container: "absent" });

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "cancelled",
    reason: "cancelled", process: "not_started", container: "absent" });
  expect((await readdir(current.candidate.directory))
    .some((name) => name.startsWith(".tesota-typecheck-dependencies-"))).toBe(false);
});

it("removes the dependency snapshot when process spawn fails before dispatch", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  const executor: RepositoryTypecheckExecutor = async () => ({ status: "failed", reason: "spawn_failed",
    process: "not_started", container: "absent" });

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "unavailable",
    reason: "spawn_failed", process: "not_started", container: "absent" });
  expect((await readdir(current.candidate.directory))
    .some((name) => name.startsWith(".tesota-typecheck-dependencies-"))).toBe(false);
});

it("rejects a symbolic-link dependency before approval", async () => {
  const current = await fixture();
  await symlink(join(current.source, "node_modules", "typescript", "bin", "tsc"),
    join(current.source, "node_modules", "typescript", "bin", "redirect"), "file");

  await expect(prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) })).rejects.toThrow("Unsupported dependency installation entry");
});

it("maps coherent compiler outcomes without collapsing operational failures", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  await expect(runRepositoryTypecheck(profile, passed)).resolves.toMatchObject({ status: "passed", reason: null,
    diagnostics: [], process: "exited", container: "absent", authority: "none", provenance: "issued" });
  await expect(runRepositoryTypecheck(profile, async () => ({ status: "closed", exitCode: 1, signal: null,
    stdout: Buffer.from("src/value.ts(1,14): error TS2322: invalid\n"), stderr: Buffer.alloc(0),
    process: "exited", container: "absent" }))).resolves.toMatchObject({ status: "check_failed",
    reason: "diagnostics", diagnostics: ["src/value.ts(1,14): error TS2322: invalid"] });
  await expect(runRepositoryTypecheck(profile, async () => ({ status: "failed", reason: "timeout",
    process: "unconfirmed", container: "absent", pid: 42 }))).resolves.toMatchObject({ status: "timed_out",
    reason: "timeout", process: "unconfirmed", container: "absent" });
  await expect(runRepositoryTypecheck(profile, async () => ({ status: "failed", reason: "cleanup_unconfirmed",
    process: "unconfirmed", container: "unconfirmed", pid: 42 }))).resolves.toMatchObject({
    status: "execution_failed", reason: "cleanup_unconfirmed", container: "unconfirmed" });
  await expect(runRepositoryTypecheck(profile, async () => ({ status: "closed", exitCode: 125, signal: null,
    stdout: Buffer.alloc(0), stderr: Buffer.from("runtime unavailable\n"), process: "exited",
    container: "absent" }))).resolves.toMatchObject({ status: "unavailable", reason: "runtime_unavailable" });
  await expect(runRepositoryTypecheck(profile, async () => ({ status: "closed", exitCode: 2, signal: null,
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_compiler_result" });
  await expect(runRepositoryTypecheck(profile, async () => ({ status: "closed", exitCode: 1, signal: null,
    stdout: Buffer.from("fatal runtime failure\n"), stderr: Buffer.alloc(0), process: "exited", container: "absent" })))
    .resolves.toMatchObject({ status: "execution_failed", reason: "incoherent_compiler_result" });
}, 20_000);

it("rejects unsupported scripts and does not silently select another command", async () => {
  const current = await fixture("eslint .");
  await expect(prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) })).rejects.toThrow();
});

it("rejects a Windows-only TypeScript installation before issuing the Docker profile", async () => {
  const current = await fixture();
  await rm(join(current.source, "node_modules", "@typescript", "typescript-linux-x64"),
    { recursive: true, force: true });

  await expect(prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) }))
    .rejects.toThrow("TypeScript Linux/x64 closure unavailable");
});

it("rejects candidate changes to the authoritative check definition", async () => {
  const current = await fixture();
  await writeFile(join(current.candidate.checkout, "tsconfig.json"), JSON.stringify({ include: [] }) + "\n");
  await expect(prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) })).rejects.toThrow("candidate shape unsupported");
});

it("rejects dependencies from a source revision newer than the candidate baseline", async () => {
  const current = await fixture();
  await writeFile(join(current.source, "src", "value.ts"), "export const value: string = 'new head';\n");
  git(current.source, ["add", "--", "src/value.ts"]);
  git(current.source, ["commit", "--quiet", "--no-gpg-sign", "-m", "Advance source"]);

  await expect(prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) })).rejects.toThrow("source baseline changed");
});

it("invalidates a result when candidate bytes change during execution", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  const mutating = vi.fn<RepositoryTypecheckExecutor>(async () => {
    await writeFile(join(current.candidate.checkout, "src", "value.ts"), "export const value: string = 'changed';\n");
    return { status: "closed", exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      process: "exited", container: "absent" };
  });
  await expect(runRepositoryTypecheck(profile, mutating)).resolves.toMatchObject({ status: "execution_failed",
    reason: "input_drift" });
  expect(mutating).toHaveBeenCalledOnce();
});

it("does not dispatch a stale TypeScript profile", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  await writeFile(join(current.source, "node_modules", "typescript", "bin", "tsc"), "changed compiler fixture\n");
  const executor = vi.fn<RepositoryTypecheckExecutor>(passed);

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "execution_failed",
    reason: "input_drift", process: "not_started", container: "absent" });
  expect(executor).not.toHaveBeenCalled();
});

it("does not dispatch when a hardlinked source dependency drifts", async () => {
  const current = await fixture();
  const compiler = join(current.source, "node_modules", "typescript", "bin", "tsc");
  const alias = join(current.source, "typescript-hardlink-source");
  await link(compiler, alias);
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  await writeFile(alias, "changed compiler fixture\n");
  const executor = vi.fn<RepositoryTypecheckExecutor>(passed);

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "execution_failed",
    reason: "input_drift", process: "not_started", container: "absent" });
  expect(executor).not.toHaveBeenCalled();
});

it("does not dispatch when the candidate dependency snapshot mismatches its approved installation", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  const snapshot = vi.spyOn(repositoryCheckInput, "snapshotDependencyInstallation")
    .mockResolvedValue(Object.freeze({ state: "mismatch" }));
  const executor = vi.fn<RepositoryTypecheckExecutor>(passed);

  await expect(runRepositoryTypecheck(profile, executor)).resolves.toMatchObject({ status: "execution_failed",
    reason: "dependency_snapshot_mismatch", process: "not_started", container: "absent" });
  expect(snapshot).toHaveBeenCalledOnce();
  expect(executor).not.toHaveBeenCalled();
});

it("invalidates a result when the observed compiler installation changes", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  const mutating: RepositoryTypecheckExecutor = async () => {
    await writeFile(join(current.source, "node_modules", "typescript", "bin", "tsc"), "changed compiler fixture\n");
    return { status: "closed", exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      process: "exited", container: "absent" };
  };
  await expect(runRepositoryTypecheck(profile, mutating)).resolves.toMatchObject({ status: "execution_failed",
    reason: "input_drift" });
});

it("refuses reconstructed profiles that did not cross the admission boundary", async () => {
  const current = await fixture();
  const profile = await prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) });
  await expect(runRepositoryTypecheck(structuredClone(profile), passed)).rejects.toThrow("was not issued");
});
