import { expect, it, vi } from "vitest";
import { startRepositoryTypecheck } from "../src/repository-typecheck-command.js";
import { CONTAINER_IMAGE } from "../src/command-isolation.js";
import { REPOSITORY_TYPECHECK_PROFILE, type RepositoryTypecheckProfile,
  type RepositoryTypecheckResult } from "../src/repository-typecheck.js";

const profile: RepositoryTypecheckProfile = {
  profile: REPOSITORY_TYPECHECK_PROFILE,
  candidate: { directory: "C:\\candidate", checkout: "C:\\candidate\\repo", baseline: "b".repeat(40),
    contentSha256: "c".repeat(64) },
  repository: { script: "tsc --noEmit -p tsconfig.json", packageJsonSha256: "d".repeat(64),
    tsconfigSha256: "e".repeat(64), lockfileSha256: "f".repeat(64) },
  verifier: { packageVersion: "7.0.2", installationSha256: "1".repeat(64) },
  isolation: { image: CONTAINER_IMAGE, policySha256: "2".repeat(64), executable: "C:\\docker.exe",
    executableSha256: "3".repeat(64), nodeModules: "C:\\source\\node_modules" },
  command: ["node", "/dependencies/node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false",
    "--pretty", "false", "-p", "tsconfig.json"],
  limits: { timeoutMs: 30_000, maxOutputBytes: 262_144, terminationWaitMs: 2_000 },
  authority: "local_operator_approval_required",
};

const passed: RepositoryTypecheckResult = {
  profile: REPOSITORY_TYPECHECK_PROFILE, status: "passed", reason: null, diagnostics: [], process: "exited",
  container: "absent", binding: { profile: profile.profile, candidate: profile.candidate,
    repository: profile.repository, verifier: profile.verifier, isolation: profile.isolation,
    command: profile.command, limits: profile.limits }, authority: "none", provenance: "issued",
};

it("does not execute a prepared repository check without explicit approval", async () => {
  const execute = vi.fn(async () => passed);
  const output: string[] = [];
  await expect(startRepositoryTypecheck({ candidate: "candidate", source: "source", ask: async () => "no",
    write: (text) => { output.push(text); }, prepare: async () => profile, execute })).resolves.toBe(0);
  expect(execute).not.toHaveBeenCalled();
  expect(output.join("")).toContain("Repository check not started. Nothing changed.");
});

it("consumes approval for one issued check and maps its typed result", async () => {
  const execute = vi.fn(async () => passed);
  const output: string[] = [];
  await expect(startRepositoryTypecheck({ candidate: "candidate", source: "source", ask: async () => "yes",
    write: (text) => { output.push(text); }, prepare: async () => profile, execute })).resolves.toBe(0);
  expect(execute).toHaveBeenCalledOnce();
  expect(output.join("")).toContain('"status": "passed"');
});
