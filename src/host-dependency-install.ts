import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparationStep } from "./execution-environment.js";
import { lockfileManager } from "./toolchain.js";

/**
 * The native sandbox's preparation (decision 037): the repository's
 * dependencies, installed before the agent starts, as Docker Sandboxes,
 * Codex's setup script and Copilot's setup steps do. Package managers cannot
 * install inside the native sandbox on released Windows, Bun through a drive
 * letter at all (oven-sh/bun#39357), so the install runs on this computer, on
 * the workspace's real path, under three limits: it installs exactly what the
 * lockfile names; it runs no package's code, since lifecycle scripts are
 * turned off, which is Bun's own default for packages it does not trust; and
 * it reaches only package registries, through the sandbox's own proxy. A
 * fingerprint of the manifest and lockfile skips an install nothing changed.
 */

/** The install as a program and its arguments, and the fingerprint of what it installs. */
export interface HostInstall {
  readonly manager: "bun" | "npm";
  readonly args: readonly string[];
  readonly fingerprint: string;
}

/** An install that lasts longer is stopped; its step fails and the session goes on. */
export const INSTALL_TIME_LIMIT_MS: number = 10 * 60_000;

/** The install the checkout's lockfile calls for, or undefined when it commits none. */
export function hostInstall(checkout: string): HostInstall | undefined {
  const found = lockfileManager(checkout);
  if (found === null) return undefined;
  const args = found.manager === "bun" ? ["install", "--frozen-lockfile", "--ignore-scripts"]
    : ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  const read = (file: string): string => existsSync(join(checkout, file)) ? readFileSync(join(checkout, file), "latin1") : "";
  const fingerprint = createHash("sha256").update(JSON.stringify({ args, manifest: read("package.json"),
    lockfile: read(found.lockfile) })).digest("hex");
  return { manager: found.manager, args, fingerprint };
}

/**
 * The variables an install runs with: the operator's own, so a private
 * registry's configuration still applies, with the proxy that admits only
 * registries and the repository's own package caches.
 */
export function installVariables(host: Readonly<Record<string, string | undefined>>, proxy: string,
  cache: string): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(host).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !/^(https?_proxy|no_proxy|all_proxy)$/iu.test(entry[0])));
  return { ...inherited, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, npm_config_cache: join(cache, "npm"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun") };
}

export interface InstallOptions {
  /** Where the fingerprint of the last install that succeeded is kept. */
  readonly marker: string;
  readonly proxy: string;
  readonly cache: string;
  readonly onProgress?: (text: string) => void;
  readonly timeLimitMs?: number;
  /** Stops the install, as when its session closes; the install then rejects and records nothing. */
  readonly signal?: AbortSignal;
}

/** Run a program on this computer, keeping the end of its output, until it ends, reaches its time limit or is stopped. */
function run(program: string, args: readonly string[], cwd: string, env: Record<string, string>,
  timeLimitMs: number, signal: AbortSignal | undefined): Promise<{ ok: boolean; output: string }> {
  return new Promise((settle) => {
    // npm is a batch file on Windows, which only a shell starts; the arguments are Tesota's own, never the repository's.
    const child = spawn(program, [...args], { cwd, env, windowsHide: true, shell: program === "npm" && process.platform === "win32" });
    let output = "";
    const keep = (chunk: Buffer): void => { output = `${output}${chunk.toString()}`.slice(-4_000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { output += "\nStopped after the time limit."; child.kill(); }, timeLimitMs);
    const stop = (): void => { child.kill(); };
    signal?.addEventListener("abort", stop, { once: true });
    const finish = (result: { ok: boolean; output: string }): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      settle(result);
    };
    child.once("error", (error) => { finish({ ok: false, output: error.message }); });
    child.once("close", (code) => { finish({ ok: code === 0, output }); });
  });
}

/** Install the checkout's dependencies on this computer, unless nothing changed since the last install. */
export async function installOnHost(checkout: string, options: InstallOptions): Promise<PreparationStep[]> {
  const install = hostInstall(checkout);
  if (install === undefined) return [];
  const previous = await readFile(options.marker, "utf8").catch(() => "");
  if (previous.trim() === install.fingerprint && existsSync(join(checkout, "node_modules"))) return [];
  const description = `${install.manager} ${install.args.join(" ")} (on this computer; no package's scripts run)`;
  options.signal?.throwIfAborted();
  options.onProgress?.("Installing dependencies");
  // Tesota runs on Bun, so its own executable installs a Bun lockfile at the version it was tested with.
  const program = install.manager === "bun" && process.versions["bun"] !== undefined ? process.execPath : install.manager;
  const result = await run(program, install.args, checkout, installVariables(process.env, options.proxy, options.cache),
    options.timeLimitMs ?? INSTALL_TIME_LIMIT_MS, options.signal);
  options.signal?.throwIfAborted();
  if (result.ok) await writeFile(options.marker, install.fingerprint);
  return [{ description, outcome: result.ok ? "done" : "failed", output: result.ok ? "" : result.output.trim() }];
}
