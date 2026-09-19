import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { bindCandidateCheckoutContent, inspectPromotionSource } from "./candidate-checkout.js";
import { CONTAINER_IMAGE, buildTypecheckContainerInvocation, containerRuntimeIsOutside, resolveContainerRuntime,
  type ContainerRuntimeIdentity, typecheckContainerPolicySha256 } from "./command-isolation.js";
import { dependencyInstallationSha256, parseRepositoryJson, readDependencyInstallationInput, readRepositoryInput,
  repositoryInputDirectory, sha256, snapshotDependencyInstallation } from "./repository-check-input.js";
import { REPOSITORY_TYPECHECK_LIMITS, executeRepositoryTypecheckContainer,
  type RepositoryTypecheckExecutor } from "./repository-typecheck-process.js";

export const REPOSITORY_TYPECHECK_PROFILE = "typescript-no-emit/v1" as const;
const REPOSITORY_TYPECHECK_SCRIPT = "tsc --noEmit -p tsconfig.json" as const;
const digestPattern = /^[a-f0-9]{64}$/u;

const packageSchema = z.object({
  scripts: z.object({ typecheck: z.literal(REPOSITORY_TYPECHECK_SCRIPT) }),
  devDependencies: z.object({ typescript: z.string().regex(/^\d+\.\d+\.\d+$/u) }),
});
const installedPackageSchema = z.object({ name: z.literal("typescript"), version: z.string().regex(/^\d+\.\d+\.\d+$/u) });
const tsconfigSchema = z.object({
  extends: z.never().optional(),
  references: z.never().optional(),
  compilerOptions: z.object({ plugins: z.never().optional() }).optional(),
});
const protectedInputs = new Set(["package.json", "tsconfig.json", "bun.lock"]);

export interface RepositoryTypecheckProfile {
  readonly profile: typeof REPOSITORY_TYPECHECK_PROFILE;
  readonly candidate: { readonly directory: string; readonly checkout: string; readonly baseline: string;
    readonly contentSha256: string };
  readonly repository: { readonly script: typeof REPOSITORY_TYPECHECK_SCRIPT; readonly packageJsonSha256: string;
    readonly tsconfigSha256: string; readonly lockfileSha256: string };
  readonly verifier: { readonly packageVersion: string; readonly installationSha256: string };
  readonly isolation: { readonly image: typeof CONTAINER_IMAGE; readonly policySha256: string;
    readonly executable: string; readonly executableSha256: string; readonly nodeModules: string };
  readonly command: readonly ["node", "/workspace/node_modules/typescript/bin/tsc", "--noEmit", "--incremental",
    "false", "--pretty", "false", "-p", "tsconfig.json"];
  readonly limits: typeof REPOSITORY_TYPECHECK_LIMITS;
  readonly authority: "local_operator_approval_required";
}

export type RepositoryTypecheckResult = Readonly<{
  profile: typeof REPOSITORY_TYPECHECK_PROFILE;
  status: "passed" | "check_failed" | "unavailable" | "execution_failed" | "timed_out" | "cancelled";
  reason: string | null;
  diagnostics: readonly string[];
  process: "not_started" | "exited" | "unconfirmed";
  container: "absent" | "unconfirmed";
  binding: Omit<RepositoryTypecheckProfile, "authority">;
  authority: "none";
  provenance: "issued";
}>;

interface PrepareOptions {
  readonly candidate: string;
  readonly source: string;
  readonly runtime?: ContainerRuntimeIdentity;
}
const issued = new WeakSet<object>();

async function candidateBinding(candidateDirectory: string): Promise<RepositoryTypecheckProfile["candidate"]> {
  return await bindCandidateCheckoutContent(candidateDirectory, (path) => protectedInputs.has(path));
}

/** Admit one concrete, shell-free typecheck profile from repository declarations and observed installed inputs. */
export async function prepareRepositoryTypecheck(options: PrepareOptions): Promise<RepositoryTypecheckProfile> {
  const candidate = await candidateBinding(options.candidate);
  const sourceIdentity = await inspectPromotionSource(candidate.directory, options.source, "package.json");
  if (sourceIdentity.head !== candidate.baseline) throw new Error("Repository typecheck source baseline changed");
  const source = sourceIdentity.source;
  const packageBytes = await readRepositoryInput(join(candidate.checkout, "package.json"), 128 * 1024);
  const tsconfigBytes = await readRepositoryInput(join(candidate.checkout, "tsconfig.json"), 128 * 1024);
  const lockfileBytes = await readRepositoryInput(join(candidate.checkout, "bun.lock"), 8 * 1024 * 1024);
  const declared = packageSchema.parse(parseRepositoryJson(packageBytes));
  tsconfigSchema.parse(parseRepositoryJson(tsconfigBytes));
  const nodeModules = await repositoryInputDirectory(join(source, "node_modules"));
  const typescriptRoot = await repositoryInputDirectory(join(nodeModules, "typescript"));
  const installed = installedPackageSchema.parse(parseRepositoryJson(await readDependencyInstallationInput(
    join(typescriptRoot, "package.json"), 128 * 1024)));
  if (installed.version !== declared.devDependencies.typescript) throw new Error("Installed TypeScript does not match repository declaration");
  const runtime = options.runtime ?? await resolveContainerRuntime([source, candidate.directory, candidate.checkout]);
  if (!digestPattern.test(runtime.executableSha256) || !containerRuntimeIsOutside(runtime, [source, candidate.directory, candidate.checkout])) {
    throw new Error("Repository typecheck runtime unavailable");
  }
  const profile: RepositoryTypecheckProfile = {
    profile: REPOSITORY_TYPECHECK_PROFILE,
    candidate,
    repository: { script: REPOSITORY_TYPECHECK_SCRIPT, packageJsonSha256: sha256(packageBytes),
      tsconfigSha256: sha256(tsconfigBytes), lockfileSha256: sha256(lockfileBytes) },
    verifier: { packageVersion: installed.version, installationSha256: await dependencyInstallationSha256(nodeModules, true) },
    isolation: { image: CONTAINER_IMAGE, policySha256: typecheckContainerPolicySha256(),
      executable: runtime.executable, executableSha256: runtime.executableSha256, nodeModules },
    command: ["node", "/workspace/node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false",
      "--pretty", "false", "-p", "tsconfig.json"],
    limits: REPOSITORY_TYPECHECK_LIMITS,
    authority: "local_operator_approval_required",
  };
  Object.freeze(profile.candidate); Object.freeze(profile.repository); Object.freeze(profile.verifier);
  Object.freeze(profile.isolation); Object.freeze(profile.command); Object.freeze(profile);
  issued.add(profile);
  return profile;
}

function diagnostics(stdout: Buffer, stderr: Buffer): readonly string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = [decoder.decode(stdout).trim(), decoder.decode(stderr).trim()].filter((value) => value !== "").join("\n");
  return text === "" ? [] : text.split(/\r?\n/u).slice(0, 200).map((line) => line.slice(0, 2_000));
}

function withoutAuthority(profile: RepositoryTypecheckProfile): Omit<RepositoryTypecheckProfile, "authority"> {
  const { authority: _authority, ...binding } = profile;
  return Object.freeze(binding);
}

function failedResult(profile: RepositoryTypecheckProfile, status: RepositoryTypecheckResult["status"], reason: string,
  processState: RepositoryTypecheckResult["process"], container: RepositoryTypecheckResult["container"]): RepositoryTypecheckResult {
  const diagnostics: readonly string[] = Object.freeze([]);
  return Object.freeze({ profile: REPOSITORY_TYPECHECK_PROFILE, status, reason, diagnostics, process: processState, container,
    binding: withoutAuthority(profile), authority: "none", provenance: "issued" });
}

interface SnapshotExecution {
  readonly result: RepositoryTypecheckResult;
  readonly snapshotSettled: boolean;
}

function snapshotSettled(process: RepositoryTypecheckResult["process"], container: RepositoryTypecheckResult["container"]): boolean {
  return process !== "unconfirmed" && container === "absent";
}

async function inputsRemainCurrent(profile: RepositoryTypecheckProfile): Promise<boolean> {
  const candidate = await candidateBinding(profile.candidate.directory);
  const packageBytes = await readRepositoryInput(join(candidate.checkout, "package.json"), 128 * 1024);
  const tsconfigBytes = await readRepositoryInput(join(candidate.checkout, "tsconfig.json"), 128 * 1024);
  const lockfileBytes = await readRepositoryInput(join(candidate.checkout, "bun.lock"), 8 * 1024 * 1024);
  const nodeModules = await repositoryInputDirectory(profile.isolation.nodeModules);
  const typescriptRoot = await repositoryInputDirectory(join(nodeModules, "typescript"));
  const installed = installedPackageSchema.parse(parseRepositoryJson(await readDependencyInstallationInput(
    join(typescriptRoot, "package.json"), 128 * 1024)));
  const executableSha256 = sha256(await readRepositoryInput(profile.isolation.executable, 128 * 1024 * 1024));
  return candidate.contentSha256 === profile.candidate.contentSha256 &&
    sha256(packageBytes) === profile.repository.packageJsonSha256 && sha256(tsconfigBytes) === profile.repository.tsconfigSha256 &&
    sha256(lockfileBytes) === profile.repository.lockfileSha256 &&
    installed.version === profile.verifier.packageVersion &&
    await dependencyInstallationSha256(nodeModules, true) === profile.verifier.installationSha256 &&
    executableSha256 === profile.isolation.executableSha256;
}

async function executeSnapshotTypecheck(profile: RepositoryTypecheckProfile, snapshotDirectory: string, name: string,
  executor: RepositoryTypecheckExecutor, signal: AbortSignal | undefined): Promise<SnapshotExecution> {
  const invocation = buildTypecheckContainerInvocation({ candidate: profile.candidate.checkout,
    nodeModules: snapshotDirectory }, profile.isolation.executable, name);
  const observed = await executor(invocation, name, signal);
  const settled = snapshotSettled(observed.process, observed.container);
  if (observed.status === "failed") {
    const status = observed.reason === "cancelled" ? "cancelled" : observed.reason === "timeout" ? "timed_out" :
      observed.reason === "spawn_failed" ? "unavailable" : "execution_failed";
    return { result: failedResult(profile, status, observed.reason, observed.process, observed.container), snapshotSettled: settled };
  }
  let output: readonly string[];
  try { output = diagnostics(observed.stdout, observed.stderr); }
  catch { return { result: failedResult(profile, "execution_failed", "invalid_output", observed.process, observed.container), snapshotSettled: settled }; }
  if (await dependencyInstallationSha256(snapshotDirectory) !== profile.verifier.installationSha256) {
    return { result: failedResult(profile, "execution_failed", "dependency_snapshot_drift", observed.process, observed.container), snapshotSettled: settled };
  }
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return { result: failedResult(profile, "execution_failed", "input_drift", observed.process, observed.container), snapshotSettled: settled };
  }
  if (observed.signal !== null || observed.exitCode === null) {
    return { result: failedResult(profile, "execution_failed", "unexpected_process_exit", observed.process, observed.container), snapshotSettled: settled };
  }
  if (observed.exitCode === 0 && output.length === 0) {
    return { result: Object.freeze({ ...failedResult(profile, "passed", "passed", observed.process, observed.container), reason: null }), snapshotSettled: settled };
  }
  if (observed.exitCode === 1 && output.some((line) => /\berror TS\d+:/u.test(line))) {
    return { result: Object.freeze({ ...failedResult(profile, "check_failed", "diagnostics", observed.process, observed.container),
      diagnostics: Object.freeze([...output]) }), snapshotSettled: settled };
  }
  if (observed.exitCode === 125) {
    return { result: failedResult(profile, "unavailable", "runtime_unavailable", observed.process, observed.container), snapshotSettled: settled };
  }
  return { result: failedResult(profile, "execution_failed", "incoherent_compiler_result", observed.process, observed.container), snapshotSettled: settled };
}

export async function runRepositoryTypecheck(profile: RepositoryTypecheckProfile,
  executor: RepositoryTypecheckExecutor = executeRepositoryTypecheckContainer,
  signal?: AbortSignal): Promise<RepositoryTypecheckResult> {
  if (!issued.has(profile)) throw new Error("Repository typecheck profile was not issued");
  if (signal?.aborted === true) return failedResult(profile, "cancelled", "cancelled", "not_started", "absent");
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return failedResult(profile, "execution_failed", "input_drift", "not_started", "absent");
  }
  const name = `tesota-typecheck-${randomUUID()}`;
  const snapshot = await snapshotDependencyInstallation(profile.isolation.nodeModules, profile.candidate.directory,
    profile.verifier.installationSha256, `.tesota-typecheck-dependencies-${randomUUID()}`);
  if (snapshot.state !== "ready") {
    return snapshot.state === "mismatch"
      ? failedResult(profile, "execution_failed", "dependency_snapshot_mismatch", "not_started", "absent")
      : failedResult(profile, "unavailable", "dependency_snapshot_unavailable", "not_started", "absent");
  }
  const execution = await executeSnapshotTypecheck(profile, snapshot.directory, name, executor, signal);
  if (execution.snapshotSettled) await rm(snapshot.directory, { recursive: true, force: true }).catch(() => {});
  return execution.result;
}

/** Compose the concrete profile; the caller remains responsible for task execution authority. */
export async function checkRepositoryTypecheck(options: PrepareOptions,
  signal?: AbortSignal): Promise<RepositoryTypecheckResult> {
  return runRepositoryTypecheck(await prepareRepositoryTypecheck(options), executeRepositoryTypecheckContainer, signal);
}

export function formatRepositoryTypecheckProfile(profile: RepositoryTypecheckProfile): string {
  return `Repository check profile\nProfile: ${profile.profile}\nCandidate: ${profile.candidate.directory}\n` +
    `Baseline: ${profile.candidate.baseline}\nCandidate content: ${profile.candidate.contentSha256}\n` +
    `Repository declaration: ${profile.repository.script}\nConfiguration: package ${profile.repository.packageJsonSha256}; ` +
    `tsconfig ${profile.repository.tsconfigSha256}; lockfile ${profile.repository.lockfileSha256}\n` +
    `Verifier: TypeScript ${profile.verifier.packageVersion}; installation ${profile.verifier.installationSha256}\n` +
    `Execution: ${profile.command.join(" ")}\nIsolation: ${profile.isolation.image}; policy ${profile.isolation.policySha256}\n` +
    `Runtime: ${profile.isolation.executable}; SHA-256 ${profile.isolation.executableSha256}\n` +
    "Effects: candidate and dependencies read-only; network denied; host credentials not mounted\n" +
    `Limits: ${profile.limits.timeoutMs} ms, ${profile.limits.maxOutputBytes} output bytes\n` +
    "Authority: pending explicit local operator approval.\n";
}
