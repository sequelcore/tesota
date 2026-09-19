import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const MAXIMUM_DEPENDENCY_ENTRIES = 100_000;
const MAXIMUM_DEPENDENCY_BYTES = 512 * 1024 * 1024;
const MAXIMUM_DEPENDENCY_FILE_BYTES = 128 * 1024 * 1024;

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedRegularFile(path: string, maximumBytes: number, allowHardlinks: boolean): Promise<Buffer> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (!allowHardlinks && metadata.nlink !== 1) || metadata.size > maximumBytes ||
      relative(absolute, await realpath(absolute)) !== "") throw new Error("Repository check input unavailable");
  const file = await open(absolute, "r");
  try {
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maximumBytes) throw new Error("Repository check input unavailable");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Read one bounded, non-redirected input used by a repository check profile. */
export async function readRepositoryInput(path: string, maximumBytes: number): Promise<Buffer> {
  return await readBoundedRegularFile(path, maximumBytes, false);
}

/** Read one dependency file while permitting Bun's content-addressed hardlinks. */
export async function readDependencyInstallationInput(path: string, maximumBytes: number): Promise<Buffer> {
  return await readBoundedRegularFile(path, maximumBytes, true);
}

/** Resolve a non-symlinked directory before it becomes a profile input. */
export async function repositoryInputDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(absolute, actual) !== "") {
    throw new Error("Repository check directory redirected");
  }
  return actual;
}

interface DependencyWalkLimits {
  entries: number;
  bytes: number;
}

interface DependencyInstallationVisitor {
  readonly onDirectory?: (directory: string, name: string) => Promise<void>;
  readonly onFile: (source: string, name: string, content: Buffer) => Promise<void>;
}

async function walkDependencyInstallation(root: string, visitor: DependencyInstallationVisitor, allowHardlinks: boolean): Promise<void> {
  const limits: DependencyWalkLimits = { entries: 0, bytes: 0 };
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const verified = await repositoryInputDirectory(directory);
    await visitor.onDirectory?.(verified, prefix);
    const entries = (await readdir(verified, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      limits.entries += 1;
      if (limits.entries > MAXIMUM_DEPENDENCY_ENTRIES) throw new Error("Dependency installation exceeds bound");
      const path = join(verified, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, name);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        const content = await readBoundedRegularFile(path, MAXIMUM_DEPENDENCY_FILE_BYTES, allowHardlinks);
        limits.bytes += content.length;
        if (limits.bytes > MAXIMUM_DEPENDENCY_BYTES) throw new Error("Dependency installation exceeds bound");
        await visitor.onFile(path, name, content);
      } else throw new Error("Unsupported dependency installation entry");
    }
  };
  await visit(root, "node_modules");
}

/** Bind the complete mounted dependency installation for the concrete check consumers. */
export async function dependencyInstallationSha256(root: string, allowHardlinks = false): Promise<string> {
  const contents: [string, string][] = [];
  await walkDependencyInstallation(root, { onFile: async (_path, name, content) => {
    contents.push([name, sha256(content)]);
  } }, allowHardlinks);
  return sha256(JSON.stringify(contents));
}

export type DependencyInstallationSnapshot =
  | Readonly<{ readonly state: "ready"; readonly directory: string }>
  | Readonly<{ readonly state: "mismatch" | "unavailable" }>;

async function copyDependencyFile(destination: string, content: Buffer): Promise<void> {
  const file = await open(destination, "wx", 0o444);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
  await readRepositoryInput(destination, MAXIMUM_DEPENDENCY_FILE_BYTES);
}

async function copyDependencyInstallation(source: string, destination: string): Promise<void> {
  await walkDependencyInstallation(source, {
    onDirectory: async (_path, name) => {
      const relativeName = name.slice("node_modules".length).replace(/^[\\/]/u, "");
      if (relativeName !== "") await mkdir(join(destination, relativeName), { mode: 0o755 });
    },
    onFile: async (_path, name, content) => {
      const relativeName = name.slice("node_modules/".length);
      const target = join(destination, relativeName);
      const parent = dirname(target);
      await mkdir(parent, { recursive: true, mode: 0o755 });
      await copyDependencyFile(target, content);
    },
  }, true);
}

/** Copy an approved dependency input into an exclusive candidate-owned regular-file snapshot. */
export async function snapshotDependencyInstallation(source: string, candidateDirectory: string,
  expectedSha256: string, name: string): Promise<DependencyInstallationSnapshot> {
  let directory: string | undefined;
  try {
    if (!/^\.tesota-typecheck-dependencies-[0-9a-f-]+$/iu.test(name)) throw new Error("Invalid dependency snapshot name");
    const candidate = await repositoryInputDirectory(candidateDirectory);
    await repositoryInputDirectory(source);
    directory = join(candidate, name);
    await mkdir(directory, { mode: 0o755 });
    await repositoryInputDirectory(directory);
    await copyDependencyInstallation(source, directory);
    if (await dependencyInstallationSha256(directory) !== expectedSha256) {
      await rm(directory, { recursive: true, force: true });
      return Object.freeze({ state: "mismatch" });
    }
    return Object.freeze({ state: "ready", directory });
  } catch {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => {});
    return Object.freeze({ state: "unavailable" });
  }
}

export function parseRepositoryJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
