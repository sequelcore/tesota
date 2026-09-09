import { createHash } from "node:crypto";
import { open, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

export const fixedConfiguration: string = JSON.stringify({
  plugins: [], categories: { correctness: "off" },
  rules: { "no-debugger": "error", "no-unused-vars": "error" },
});

export interface InputBinding {
  readonly source: { readonly file: string; readonly sha256: string };
  readonly check: {
    readonly profile: "oxlint-basic/v1";
    readonly configuration: string;
    readonly arguments: readonly string[];
    readonly limits: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly terminationWaitMs: number;
    };
  };
  readonly verifier: {
    readonly packageVersion: string;
    readonly executable: string;
    readonly executableSha256: string | null;
    readonly entry: string;
    readonly installationSha256: string;
  };
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Bound the read itself, including when the original grows after stat. */
export async function sourceBytes(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === buffer.length) throw new Error("Source exceeds 1 MiB");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Paths are relative to the private execution directory, never its random name. */
export function semanticArguments(file: string): readonly string[] {
  return ["--config", "profile.json", "--disable-nested-config", "--no-ignore",
    "--threads", "1", "--format", "json", "--deny-warnings", "--", basename(file)];
}

// Observe the installed producer and its installed native optional packages.
// This is content identity, not authentication or loaded-image attestation.
export async function observeVerifier(executable: string, entry: string): Promise<InputBinding["verifier"]> {
  const root = dirname(dirname(entry));
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (typeof metadata !== "object" || metadata === null ||
      !("version" in metadata) || typeof metadata.version !== "string") throw new Error("Missing version");
  const contents: [string, string][] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === "node_modules") continue;
      const path = join(directory, item.name);
      const name = `${prefix}/${item.name}`;
      if (item.isDirectory()) await visit(path, name);
      else if (item.isFile()) contents.push([name, digest(await readFile(path))]);
      else throw new Error("Unsupported installation entry");
    }
  };
  await visit(root, "oxlint");
  if ("optionalDependencies" in metadata && typeof metadata.optionalDependencies === "object" &&
      metadata.optionalDependencies !== null) {
    const require = createRequire(entry);
    for (const name of Object.keys(metadata.optionalDependencies).sort()) {
      if (!name.startsWith("@oxlint/binding-")) continue;
      let native: string;
      try { native = require.resolve(name); } catch { continue; }
      await visit(dirname(native), name);
    }
  }
  let executableSha256: string | null;
  try { executableSha256 = digest(await readFile(executable)); } catch { executableSha256 = null; }
  return { packageVersion: metadata.version, executable, executableSha256, entry,
    installationSha256: digest(Buffer.from(JSON.stringify(contents))) };
}
