import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runRepositoryGit as git } from "./repository-git.js";
import { isGitRepository, type SourceKind } from "./source-shadow.js";
import { hidesFile } from "./verification/secret-file-rule.js";

/**
 * Files hidden from the agent by default (docs/design/workspace.md): working
 * in the source, it could otherwise read what the operator keeps beside the
 * work, as Gemini CLI hides `.env` and `.env.*` in every sandbox. Environment
 * files, private keys and package registry credentials, matched by name.
 */
const exactNames: ReadonlySet<string> = new Set([".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc",
  ".netrc", ".yarnrc.yml", "credentials", "credentials.toml"]);
/** `credentials` files count only in the folders registries keep them in. */
const credentialFolders: ReadonlySet<string> = new Set([".gem", ".cargo", ".aws"]);
const suffixes = [".key", ".p12", ".pfx"];

/**
 * Folders a secret of the operator's is not kept in, which the walk skips as
 * Gemini CLI's does: dependencies, builds, caches and Git's own data.
 */
const skipped: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target",
  ".next", ".nuxt", ".cache", ".idea", ".gradle", ".tox"]);

/** Whether a path, relative with forward slashes, names a secret file. */
export function isSecretPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (name.startsWith(".env.") || suffixes.some((suffix) => name.endsWith(suffix) && name.length > suffix.length)) return true;
  if (name === "credentials" || name === "credentials.toml") return credentialFolders.has(parts.at(-2) ?? "");
  if (name === "config.json") return parts.at(-2) === ".docker";
  return exactNames.has(name);
}

/**
 * The secret files a source holds, relative with forward slashes, that are
 * hidden from the agent: every match in a folder; in a repository, those its
 * Git does not track, since a tracked file is part of the shared work and
 * its history is readable anyway. `allowed` are paths the operator let the
 * repository's checks read.
 */
export async function hiddenFiles(source: string, kind: SourceKind, allowed: readonly string[] = []):
  Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { if (!skipped.has(entry.name)) await walk(join(directory, entry.name), path); }
      else if ((entry.isFile() || entry.isSymbolicLink()) && isSecretPath(path)) found.push(path);
    }
  };
  await walk(source, "");
  const repository = kind === "repository";
  const tracked = new Set(!repository || found.length === 0 ? []
    : git(source, ["ls-files", "-z", "--", ...found.map((path) => `:(literal)${path}`)]).split("\0").filter((entry) => entry.length > 0));
  // Every path found has a secret's name; the proved rule decides the rest.
  return found.filter((path) => hidesFile(true, repository, tracked.has(path), allowed.includes(path))).sort();
}

/** The files hidden under `root`, a repository's top level or a folder, told apart as Tesota tells sources apart. */
export function hiddenFilesIn(root: string, allowed: readonly string[] = []): Promise<readonly string[]> {
  return hiddenFiles(root, isGitRepository(root) ? "repository" : "folder", allowed);
}
