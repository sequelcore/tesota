import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { candidateDiff, inspectCandidateCheckout, inspectPromotionSource } from "./candidate-checkout.js";
import { CONTAINER_IMAGE, buildTypecheckContainerInvocation, typecheckContainerPolicySha256 } from "./command-isolation.js";
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

interface RuntimeIdentity { readonly executable: string; readonly executableSha256: string }
interface PrepareOptions {
  readonly candidate: string;
  readonly source: string;
  readonly runtime?: RuntimeIdentity;
}
const issued = new WeakSet<object>();

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function readRegular(path: string, maximumBytes: number): Promise<Buffer> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes ||
      relative(absolute, await realpath(absolute)) !== "") throw new Error("Repository typecheck input unavailable");
  const file = await open(absolute, "r");
  try {
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maximumBytes) throw new Error("Repository typecheck input unavailable");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

async function plainDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(absolute, actual) !== "") {
    throw new Error("Repository typecheck directory redirected");
  }
  return actual;
}

async function dependencyInstallationSha256(root: string): Promise<string> {
  const contents: [string, string][] = [];
  let bytes = 0;
  let entriesObserved = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesObserved += 1;
      if (entriesObserved > 100_000) throw new Error("Dependency installation exceeds bound");
      const path = join(directory, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, name);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        const content = await readRegular(path, 128 * 1024 * 1024);
        bytes += content.length;
        if (bytes > 512 * 1024 * 1024) throw new Error("Dependency installation exceeds bound");
        contents.push([name, digest(content)]);
      } else throw new Error("Unsupported dependency installation entry");
    }
  };
  await visit(root, "node_modules");
  return digest(JSON.stringify(contents));
}

function safeJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function systemExecutable(name: string, protectedPaths: readonly string[]): Promise<string> {
  if (process.platform !== "win32") throw new Error("Repository typecheck currently requires Windows Docker Desktop");
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined || !isAbsolute(systemRoot)) throw new Error("Windows system directory unavailable");
  const where = resolve(systemRoot, "System32", "where.exe");
  const whereMetadata = await lstat(where);
  if (!whereMetadata.isFile() || whereMetadata.isSymbolicLink() || relative(where, await realpath(where)) !== "" ||
      protectedPaths.some((path) => contains(path, where))) throw new Error("Windows executable resolver unavailable");
  const result = execFileSync(where, [name], { encoding: "utf8", windowsHide: true, timeout: 5_000,
    maxBuffer: 16 * 1024 }).split(/\r?\n/u).filter(Boolean);
  const executable = resolve(result[0] ?? "");
  if (!isAbsolute(result[0] ?? "") || protectedPaths.some((path) => contains(path, executable))) {
    throw new Error("Repository typecheck runtime unavailable");
  }
  return executable;
}

async function runtimeIdentity(protectedPaths: readonly string[]): Promise<RuntimeIdentity> {
  const executable = await systemExecutable("docker.exe", protectedPaths);
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink() || relative(executable, await realpath(executable)) !== "") {
    throw new Error("Repository typecheck runtime unavailable");
  }
  return { executable, executableSha256: digest(await readRegular(executable, 128 * 1024 * 1024)) };
}

async function candidateBinding(candidateDirectory: string): Promise<RepositoryTypecheckProfile["candidate"]> {
  const inspection = await inspectCandidateCheckout(candidateDirectory);
  if (inspection.headChanged || inspection.changes.some((change) =>
    change.status !== "M" || protectedInputs.has(change.path))) {
    throw new Error("Repository typecheck candidate shape unsupported");
  }
  return { directory: inspection.directory, checkout: inspection.checkout, baseline: inspection.baseline,
    contentSha256: digest(JSON.stringify({ baseline: inspection.baseline, diff: await candidateDiff(inspection.directory) })) };
}

/** Admit one concrete, shell-free typecheck profile from repository declarations and observed installed inputs. */
export async function prepareRepositoryTypecheck(options: PrepareOptions): Promise<RepositoryTypecheckProfile> {
  const candidate = await candidateBinding(options.candidate);
  const sourceIdentity = await inspectPromotionSource(candidate.directory, options.source, "package.json");
  if (sourceIdentity.head !== candidate.baseline) throw new Error("Repository typecheck source baseline changed");
  const source = sourceIdentity.source;
  const packageBytes = await readRegular(join(candidate.checkout, "package.json"), 128 * 1024);
  const tsconfigBytes = await readRegular(join(candidate.checkout, "tsconfig.json"), 128 * 1024);
  const lockfileBytes = await readRegular(join(candidate.checkout, "bun.lock"), 8 * 1024 * 1024);
  const declared = packageSchema.parse(safeJson(packageBytes));
  tsconfigSchema.parse(safeJson(tsconfigBytes));
  const nodeModules = await plainDirectory(join(source, "node_modules"));
  const typescriptRoot = await plainDirectory(join(nodeModules, "typescript"));
  const installed = installedPackageSchema.parse(safeJson(await readRegular(join(typescriptRoot, "package.json"), 128 * 1024)));
  if (installed.version !== declared.devDependencies.typescript) throw new Error("Installed TypeScript does not match repository declaration");
  const runtime = options.runtime ?? await runtimeIdentity([source, candidate.directory, candidate.checkout]);
  if (!isAbsolute(runtime.executable) || !digestPattern.test(runtime.executableSha256) ||
      [source, candidate.directory, candidate.checkout].some((path) => contains(path, runtime.executable))) {
    throw new Error("Repository typecheck runtime unavailable");
  }
  const profile: RepositoryTypecheckProfile = {
    profile: REPOSITORY_TYPECHECK_PROFILE,
    candidate,
    repository: { script: REPOSITORY_TYPECHECK_SCRIPT, packageJsonSha256: digest(packageBytes),
      tsconfigSha256: digest(tsconfigBytes), lockfileSha256: digest(lockfileBytes) },
    verifier: { packageVersion: installed.version, installationSha256: await dependencyInstallationSha256(nodeModules) },
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

async function inputsRemainCurrent(profile: RepositoryTypecheckProfile): Promise<boolean> {
  const candidate = await candidateBinding(profile.candidate.directory);
  const packageBytes = await readRegular(join(candidate.checkout, "package.json"), 128 * 1024);
  const tsconfigBytes = await readRegular(join(candidate.checkout, "tsconfig.json"), 128 * 1024);
  const lockfileBytes = await readRegular(join(candidate.checkout, "bun.lock"), 8 * 1024 * 1024);
  const nodeModules = await plainDirectory(profile.isolation.nodeModules);
  const typescriptRoot = await plainDirectory(join(nodeModules, "typescript"));
  const installed = installedPackageSchema.parse(safeJson(await readRegular(join(typescriptRoot, "package.json"), 128 * 1024)));
  const executableSha256 = digest(await readRegular(profile.isolation.executable, 128 * 1024 * 1024));
  return candidate.contentSha256 === profile.candidate.contentSha256 &&
    digest(packageBytes) === profile.repository.packageJsonSha256 && digest(tsconfigBytes) === profile.repository.tsconfigSha256 &&
    digest(lockfileBytes) === profile.repository.lockfileSha256 &&
    installed.version === profile.verifier.packageVersion &&
    await dependencyInstallationSha256(nodeModules) === profile.verifier.installationSha256 &&
    executableSha256 === profile.isolation.executableSha256;
}

export async function runRepositoryTypecheck(profile: RepositoryTypecheckProfile,
  executor: RepositoryTypecheckExecutor = executeRepositoryTypecheckContainer,
  signal?: AbortSignal): Promise<RepositoryTypecheckResult> {
  if (!issued.has(profile)) throw new Error("Repository typecheck profile was not issued");
  const name = `tesota-typecheck-${randomUUID()}`;
  const invocation = buildTypecheckContainerInvocation({ candidate: profile.candidate.checkout,
    nodeModules: profile.isolation.nodeModules }, profile.isolation.executable, name);
  const observed = await executor(invocation, name, signal);
  if (observed.status === "failed") {
    const status = observed.reason === "cancelled" ? "cancelled" : observed.reason === "timeout" ? "timed_out" :
      observed.reason === "spawn_failed" ? "unavailable" : "execution_failed";
    return failedResult(profile, status, observed.reason, observed.process, observed.container);
  }
  let output: readonly string[];
  try { output = diagnostics(observed.stdout, observed.stderr); }
  catch { return failedResult(profile, "execution_failed", "invalid_output", observed.process, observed.container); }
  if (!await inputsRemainCurrent(profile).catch(() => false)) {
    return failedResult(profile, "execution_failed", "input_drift", observed.process, observed.container);
  }
  if (observed.signal !== null || observed.exitCode === null) {
    return failedResult(profile, "execution_failed", "unexpected_process_exit", observed.process, observed.container);
  }
  if (observed.exitCode === 0 && output.length === 0) {
    return Object.freeze({ ...failedResult(profile, "passed", "passed", observed.process, observed.container), reason: null });
  }
  if (observed.exitCode === 1 && output.some((line) => /\berror TS\d+:/u.test(line))) {
    return Object.freeze({ ...failedResult(profile, "check_failed", "diagnostics", observed.process, observed.container),
      diagnostics: Object.freeze([...output]) });
  }
  if (observed.exitCode === 125) {
    return failedResult(profile, "unavailable", "runtime_unavailable", observed.process, observed.container);
  }
  return failedResult(profile, "execution_failed", "incoherent_compiler_result", observed.process, observed.container);
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
