import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateCheckout } from "../src/candidate-checkout.js";
import { REPOSITORY_TYPECHECK_PROFILE, formatRepositoryTypecheckProfile, prepareRepositoryTypecheck,
  runRepositoryTypecheck } from "../src/repository-typecheck.js";
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
  await writeFile(join(source, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2" }) + "\n");
  await writeFile(join(source, "node_modules", "typescript", "bin", "tsc"), "compiler fixture\n");
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
    command: ["node", "/workspace/node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false",
      "--pretty", "false", "-p", "tsconfig.json"],
    authority: "local_operator_approval_required" });
  expect(profile.candidate.contentSha256).toMatch(/^[a-f\d]{64}$/u);
  expect(profile.verifier.installationSha256).toMatch(/^[a-f\d]{64}$/u);
  expect(formatRepositoryTypecheckProfile(profile)).toContain("candidate and dependencies read-only; network denied");
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
});

it("rejects unsupported scripts and does not silently select another command", async () => {
  const current = await fixture("eslint .");
  await expect(prepareRepositoryTypecheck({ candidate: current.candidate.directory,
    source: current.source, runtime: await runtime(current.root) })).rejects.toThrow();
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
