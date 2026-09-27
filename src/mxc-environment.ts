import { type ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { win32 } from "node:path";
// MXC sandboxes run on Windows, so their paths follow Windows' rules whatever the host running the tests.
const { join, relative, resolve, sep } = win32;
import { createConfigFromPolicy, getAvailableToolsPolicy, getPlatformSupport, spawnSandboxFromConfig } from "@microsoft/mxc-sdk";
import { EgressProxy } from "./egress-proxy.js";
import { type EnvironmentGuarantees, type ExecutionEnvironment, type ExecutionProvider, PACKAGE_REGISTRY_HOSTS,
  type PrepareOptions, type ProviderReadiness, type RunOptions, type RunResult } from "./execution-environment.js";

/**
 * The native Windows sandbox (decision 030), on Microsoft's MXC: each command
 * runs in its own `processcontainer`, writing only the workspace and the
 * session's own folders, reading those and the host's installed tools, and
 * reaching the network only through Tesota's egress proxy, which Windows'
 * filtering platform enforces. Git Bash cannot start in MXC's container, so
 * commands run in Windows PowerShell 5.1; and since a command there cannot
 * query the workspace's parent folders, which Git, npm and Node walk, the
 * workspace becomes a drive of its own with `subst`, so nothing lies above
 * it. This is the only module that names MXC. MXC is a preview that Microsoft does not yet call a security boundary;
 * a provider's guarantees stand only as far as the execution controls show.
 */

export const MXC_GUARANTEES: EnvironmentGuarantees = { filesystem: "workspace", network: "allowlist", secrets: "none", resources: "unbounded" };

/** MXC's policy schema, pinned with the SDK version so the contract does not move under Tesota. */
const POLICY_VERSION = "0.8.0-alpha";

function normalized(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, "").toLowerCase();
}

/** Host tool folders a command may read: never the operator's home, nor a folder that holds it. */
export function sandboxToolPaths(paths: readonly string[], home: string): string[] {
  const own = normalized(home);
  return paths.filter((path) => {
    const candidate = normalized(path);
    return candidate !== own && !own.startsWith(candidate.endsWith(sep) ? candidate : `${candidate}${sep}`);
  });
}

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * A command as a PowerShell script: in its folder on the workspace's drive,
 * with UTF-8 output, and ending with the command's own status: success, a
 * native program's non-zero exit, or 1 for a failed cmdlet.
 */
export function powershellScript(cwd: string, command: string): string {
  return ["$ProgressPreference = 'SilentlyContinue'", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `Set-Location -LiteralPath ${literal(cwd)}`, command, "$tesotaOk = $?",
    "exit $(if ($tesotaOk) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 })"].join("\n");
}

/** The drives `subst` maps, by letter, from its listing: `T:\\: => C:\\path`. */
export function substitutedDrives(listing: string): Map<string, string> {
  return new Map([...listing.matchAll(/^([A-Za-z]):\\: => (.+?)\r?$/gmu)].map((match) => [(match[1] ?? "").toUpperCase(), match[2] ?? ""]));
}

/** A folder of the workspace as a command on its drive names it. */
export function onDrive(letter: string, workspace: string, path: string): string {
  const within = relative(workspace, path);
  if (within.startsWith("..") || resolve(workspace, within) !== resolve(path)) throw new Error(`${path} is outside the workspace`);
  return `${letter}:\\${within}`;
}

function subst(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((settle) => {
    execFile("subst", [...args], { windowsHide: true }, (error, stdout) => { settle({ ok: error === null, output: String(stdout) }); });
  });
}

/** Remove every drive `subst` maps to this folder, such as one a crash left behind. */
async function unmapDrives(target: string): Promise<void> {
  for (const [letter, mapped] of substitutedDrives((await subst([])).output)) {
    if (normalized(mapped) === normalized(target)) await subst([`${letter}:`, "/d"]);
  }
}

/** Map the workspace to a free drive letter, trying from Z down so the operator's own letters stay free. */
async function mapDrive(workspace: string): Promise<string> {
  await unmapDrives(workspace);
  const taken = new Set((substitutedDrives((await subst([])).output)).keys());
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    if (taken.has(letter) || existsSync(`${letter}:\\`)) continue;
    if ((await subst([`${letter}:`, workspace])).ok) return letter;
  }
  throw new Error("No drive letter is free for the native sandbox's workspace");
}

/** Run a script file: `-File` reports errors as text, where an encoded command serializes them as CLIXML. */
function powershellCommandLine(script: string, systemRoot: string): string {
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return `"${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`;
}

/** The session's own folders, as a command's environment names them. */
export interface SandboxFolders {
  readonly home: string;
  readonly temp: string;
  readonly cache: string;
  readonly proxy: string;
}

/** System names Windows and common tools look up; they describe the machine, not the operator. */
const systemVariables = ["SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS"];

/**
 * Only what a command needs: system names, the session's own home, temporary
 * folder and package caches, the proxy, and what it was given. Nothing else of
 * the operator's environment passes, so tokens held in variables stay out.
 * Windows requires `LOCALAPPDATA` to exist before it starts a contained process
 * and never reads its value, so it names the sandbox's own folder.
 */
export function sandboxVariables(host: Readonly<Record<string, string | undefined>>, folders: SandboxFolders,
  given: Readonly<Record<string, string>> = {}): Record<string, string> {
  const system = Object.fromEntries(Object.entries(host).filter(([name, value]) =>
    value !== undefined && systemVariables.includes(name.toUpperCase())).map(([name, value]) => [name.toUpperCase(), value ?? ""]));
  const proxy = folders.proxy;
  // Node would otherwise walk the folders above its own install folder, which the sandbox cannot query.
  const nodeOptions = ["--preserve-symlinks --preserve-symlinks-main", given["NODE_OPTIONS"]].filter(Boolean).join(" ");
  return { ...system, USERPROFILE: folders.home, HOME: folders.home,
    LOCALAPPDATA: join(folders.home, "AppData", "Local"), APPDATA: join(folders.home, "AppData", "Roaming"),
    TEMP: folders.temp, TMP: folders.temp, npm_config_cache: join(folders.cache, "npm"), BUN_INSTALL_CACHE_DIR: join(folders.cache, "bun"),
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    // Git uses its own TLS here: Windows' checks revocation on servers the allowlist does not reach.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.sslBackend", GIT_CONFIG_VALUE_0: "openssl",
    ...given, NODE_OPTIONS: nodeOptions };
}

/** Where a workspace's sandbox keeps its own folders, beside the workspace so it is released with it. */
function sandboxRoot(workspace: string): string {
  return `${resolve(workspace)}.sandbox`;
}

function prepare(workspace: string, options: PrepareOptions = {}): Promise<ExecutionEnvironment> {
  return (async () => {
    const root = sandboxRoot(workspace);
    const folders = { home: join(root, "home"), temp: join(root, "tmp"), cache: options.cacheDirectory ?? join(root, "cache") };
    for (const folder of [folders.home, join(folders.home, "AppData", "Local"), join(folders.home, "AppData", "Roaming"),
      folders.temp, join(folders.cache, "npm"), join(folders.cache, "bun")]) await mkdir(folder, { recursive: true });
    const proxy = await EgressProxy.start({ allowed: PACKAGE_REGISTRY_HOSTS.map((host) => `${host}:443`) });
    const readable = sandboxToolPaths(getAvailableToolsPolicy(process.env).readonlyPaths ?? [], homedir());
    const writable = [resolve(workspace), root, ...options.cacheDirectory === undefined ? [] : [folders.cache]];
    const drive = await mapDrive(resolve(workspace)).catch(async (error: unknown) => { await proxy.close(); throw error; });
    const sandbox: Sandbox = { workspace: resolve(workspace), drive, scripts: join(root, "commands"), readable, writable,
      folders: { ...folders, proxy: proxy.url }, systemRoot: process.env["SYSTEMROOT"] ?? "C:\\Windows" };
    await mkdir(sandbox.scripts, { recursive: true });
    return { provider: "mxc", shell: "powershell", javascriptRuntime: process.execPath, commandRoot: `${drive}:\\`,
      guarantees: MXC_GUARANTEES, preparation: [], network: proxy,
      run: (command, runOptions) => runCommand(sandbox, command, runOptions),
      dispose: async () => {
        await proxy.close();
        await subst([`${drive}:`, "/d"]);
      } };
  })();
}

/** What every command of one prepared sandbox shares. */
interface Sandbox {
  readonly workspace: string;
  /** The drive letter `subst` maps to the workspace, where commands run. */
  readonly drive: string;
  /** Where each command's script is written, inside the sandbox's own folder. */
  readonly scripts: string;
  readonly readable: readonly string[];
  readonly writable: readonly string[];
  readonly folders: SandboxFolders;
  readonly systemRoot: string;
}

/** One command in its own container, as a PowerShell script file that is removed when it ends. */
async function runCommand(sandbox: Sandbox, command: string, runOptions: RunOptions): Promise<RunResult> {
  const script = join(sandbox.scripts, `${randomUUID()}.ps1`);
  // Windows PowerShell 5.1 reads a script without a byte-order mark in the system's code page.
  const cwd = onDrive(sandbox.drive, sandbox.workspace, runOptions.cwd);
  await writeFile(script, `\uFEFF${powershellScript(cwd, command)}`, "utf8");
  try {
    const config = createConfigFromPolicy({ version: POLICY_VERSION,
      filesystem: { readonlyPaths: [...sandbox.readable], readwritePaths: [...sandbox.writable] },
      // Proxy-only egress: Windows' filtering platform lets the container reach only the proxy's loopback port.
      network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } },
      runtimeConfig: { networkProxy: sandbox.folders.proxy } });
    if (config.process === undefined) throw new Error("MXC gave no process configuration");
    config.process.commandLine = powershellCommandLine(script, sandbox.systemRoot);
    config.process.cwd = cwd;
    // Console tools such as node and git need Win32k to start; clipboard, input and desktop controls stay denied.
    config.ui = { disable: false, clipboard: "none", injection: false };
    return await supervise(spawnSandboxFromConfig(config, { usePty: false }, undefined,
      sandboxVariables(process.env, sandbox.folders, runOptions.env)), runOptions);
  } finally { await rm(script, { force: true }); }
}

/** Follow one sandboxed command to its end, stopping it on cancellation or at its time limit. */
function supervise(child: ChildProcess, runOptions: RunOptions): Promise<RunResult> {
  return new Promise((settle) => {
    let stopped: "cancelled" | "timed_out" | undefined;
    const stop = (reason: "cancelled" | "timed_out"): void => { stopped ??= reason; child.kill(); };
    const onAbort = (): void => { stop("cancelled"); };
    runOptions.signal?.addEventListener("abort", onAbort, { once: true });
    if (runOptions.signal?.aborted === true) stop("cancelled");
    const timer = runOptions.timeoutSeconds === undefined ? undefined
      : setTimeout(() => { stop("timed_out"); }, runOptions.timeoutSeconds * 1_000);
    child.stdout?.on("data", (chunk: Buffer) => { runOptions.onOutput(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { runOptions.onOutput(chunk); });
    const finish = (result: RunResult): void => {
      clearTimeout(timer);
      runOptions.signal?.removeEventListener("abort", onAbort);
      settle(result);
    };
    child.once("error", () => { finish({ outcome: "not_started", exitCode: null }); });
    // MXC ends a command's whole job with it, children included.
    child.once("close", (code) => { finish(stopped === undefined ? { outcome: "exited", exitCode: code } : { outcome: stopped, exitCode: null }); });
  });
}

function readiness(): Promise<ProviderReadiness> {
  if (process.platform !== "win32") {
    return Promise.resolve({ ready: false, steps: [{ description: "The native sandbox is qualified on Windows 11 only so far" }] });
  }
  const support = getPlatformSupport();
  if (support.isSupported && support.availableMethods.includes("processcontainer")) return Promise.resolve({ ready: true });
  return Promise.resolve({ ready: false, steps: [{ description: "The native sandbox needs Windows 11 24H2 or later" +
    `${support.reason === "" ? "" : ` (${support.reason})`}` }] });
}

/** Qualification holds for one Windows build and one MXC release: either can change what the sandbox enforces. */
async function fingerprint(): Promise<string> {
  const sdk: unknown = createRequire(import.meta.url)("@microsoft/mxc-sdk/package.json");
  const version = typeof sdk === "object" && sdk !== null ? String(Reflect.get(sdk, "version")) : "unknown";
  return `windows ${release()}; mxc-sdk ${version}`;
}

export const mxcProvider: ExecutionProvider = {
  name: "mxc",
  guarantees: MXC_GUARANTEES,
  readiness,
  prepare,
  fingerprint,
  release: async (workspace) => {
    await unmapDrives(resolve(workspace));
    await rm(sandboxRoot(workspace), { recursive: true, force: true, maxRetries: 3 });
  },
};
