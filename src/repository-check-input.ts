import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read one bounded, non-redirected input used by a repository check profile. */
export async function readRepositoryInput(path: string, maximumBytes: number): Promise<Buffer> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes ||
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

/** Bind the complete mounted dependency installation for the concrete check consumers. */
export async function dependencyInstallationSha256(root: string): Promise<string> {
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
        const content = await readRepositoryInput(path, 128 * 1024 * 1024);
        bytes += content.length;
        if (bytes > 512 * 1024 * 1024) throw new Error("Dependency installation exceeds bound");
        contents.push([name, sha256(content)]);
      } else throw new Error("Unsupported dependency installation entry");
    }
  };
  await visit(root, "node_modules");
  return sha256(JSON.stringify(contents));
}

export function parseRepositoryJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
