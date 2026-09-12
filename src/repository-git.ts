import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

const gitLimit = 8 * 1024 * 1024;
const gitTimeoutMs = 60_000;

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

function repositoryGitEnvironment(source: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = key.toUpperCase() === "PATH" ? value.split(delimiter)
      .filter((entry) => isAbsolute(entry) && !contains(source, resolve(entry))).join(delimiter) : value;
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" });
  return env;
}

function gitExecutionDirectory(source: string): string {
  if (process.platform !== "win32") return "/";
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined || !isAbsolute(systemRoot)) throw new Error("Cannot locate Windows system directory");
  const systemDirectory = resolve(systemRoot, "System32");
  const metadata = lstatSync(systemDirectory);
  const actual = realpathSync(systemDirectory);
  const runtime = realpathSync(process.execPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(systemDirectory, actual) !== "" ||
      contains(source, actual) || contains(source, runtime)) {
    throw new Error("Git execution environment cannot be repository-owned");
  }
  return actual;
}

function repositoryGitArguments(args: readonly string[]): string[] {
  return ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false",
    "-c", "core.autocrlf=false", ...args];
}

/** Reject repository-local Git programs before any operation that may inspect working-tree bytes. */
export function assertNoRepositoryGitPrograms(cwd: string): void {
  const source = resolve(cwd);
  const result = spawnSync("git", ["-C", source, ...repositoryGitArguments(["config", "--includes", "--null",
    "--name-only", "--get-regexp", "^(filter\\..*\\.(clean|process)|diff\\.(external|.*\\.(command|textconv)))$"])], {
    cwd: gitExecutionDirectory(source), env: repositoryGitEnvironment(source), windowsHide: true, shell: false,
    encoding: "utf8", timeout: gitTimeoutMs, maxBuffer: gitLimit,
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 1 || result.stdout.length !== 0) {
    throw new Error("Repository-local Git programs are not allowed");
  }
}

/** Run a fixed, shell-free local Git text operation without ambient config, hooks, credentials or network protocols. */
export function runRepositoryGit(cwd: string, args: readonly string[]): string {
  const source = resolve(cwd);
  const result = spawnSync("git", ["-C", source, ...repositoryGitArguments(args)], {
    cwd: gitExecutionDirectory(source), env: repositoryGitEnvironment(source), windowsHide: true, shell: false, encoding: "utf8",
    timeout: gitTimeoutMs, maxBuffer: gitLimit,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error("Repository Git operation failed");
  }
  return result.stdout;
}

/** Preserve exact blob bytes for callers that perform their own bounded decoding. */
export function runRepositoryGitBytes(cwd: string, args: readonly string[]): Buffer {
  const source = resolve(cwd);
  const result = spawnSync("git", ["-C", source, ...repositoryGitArguments(args)], {
    cwd: gitExecutionDirectory(source), env: repositoryGitEnvironment(source), windowsHide: true, shell: false, encoding: "buffer",
    timeout: gitTimeoutMs, maxBuffer: gitLimit,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error("Repository Git operation failed");
  }
  return result.stdout;
}

export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
