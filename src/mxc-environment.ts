import { type ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { win32 } from "node:path";
// MXC sandboxes run on Windows, so their paths follow Windows' rules whatever the host running the tests.
const { basename, dirname, join, relative, resolve, sep } = win32;
import { createConfigFromPolicy, getAvailableToolsPolicy, getPlatformSupport, spawnSandboxFromConfig } from "@microsoft/mxc-sdk";
import { EgressProxy } from "./egress-proxy.js";
import { installOnHost } from "./host-dependency-install.js";
import { releasesDrive } from "./verification/drive-release-rule.js";
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
 * native program's non-zero exit, or 1 for a failed cmdlet. MXC replaces the
 * temporary folder a command is given with one of its own, deep inside the
 * sandbox's home, where temporary folders that tests make pass Windows' path
 * limit; so the script sets it again, to the sandbox's own on the drive.
 */
export function powershellScript(cwd: string, command: string, temp?: string): string {
  const temporary = temp === undefined ? [] : [`$env:TEMP = ${literal(temp)}`, "$env:TMP = $env:TEMP"];
  return ["$ProgressPreference = 'SilentlyContinue'", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8", ...temporary,
    `Set-Location -LiteralPath ${literal(cwd)}`, command, "$tesotaOk = $?",
    "exit $(if ($tesotaOk) { 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 })"].join("\n");
}

/** The drives `subst` maps, by letter, from its listing: `T:\\: => C:\\path`. */
export function substitutedDrives(listing: string): Map<string, string> {
  return new Map([...listing.matchAll(/^([A-Za-z]):\\: => (.+?)\r?$/gmu)].map((match) => [(match[1] ?? "").toUpperCase(), match[2] ?? ""]));
}

/**
 * The folder the drive maps: the one that holds the workspace (decision 037).
 * With the workspace one level below the drive's root, Bun's scripts run,
 * which fail at a drive's root (`bunsh: No such file or directory: X:\X:`),
 * and nothing lies above the drive for tools to walk.
 */
export function driveTarget(workspace: string): string {
  return dirname(resolve(workspace));
}

/** A folder of the workspace as a command on its drive names it: under the workspace's own name on that drive. */
export function onDrive(letter: string, workspace: string, path: string): string {
  const within = relative(workspace, path);
  if (within.startsWith("..") || resolve(workspace, within) !== resolve(path)) throw new Error(`${path} is outside the workspace`);
  return `${letter}:\\${join(basename(resolve(workspace)), within)}`;
}

/**
 * What else the drive's folder holds, which a command may not read: Tesota's
 * records of the session, such as its review journal and source snapshot.
 * Read before each command, so records written since are denied too; only
 * their names can be listed.
 */
export async function deniedBeside(workspace: string): Promise<string[]> {
  const kept = new Set([basename(resolve(workspace)), basename(sandboxRoot(workspace))].map((name) => name.toLowerCase()));
  const target = driveTarget(workspace);
  return (await readdir(target)).filter((name) => !kept.has(name.toLowerCase())).map((name) => join(target, name));
}

function subst(args: readonly string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((settle) => {
    execFile("subst", [...args], { windowsHide: true }, (error, stdout) => { settle({ ok: error === null, output: String(stdout) }); });
  });
}

/** Remove every drive `subst` maps to this folder, such as one a crash left behind. */
async function unmapDrives(target: string): Promise<void> {
  for (const [letter, mapped] of substitutedDrives((await subst([])).output)) {
    if (normalized(mapped) === normalized(target) && (await subst([`${letter}:`, "/d"])).ok) await rm(leaseFile(letter), { force: true });
  }
}

/**
 * Which process mapped a drive, and to what. A drive lasts until the operator
 * signs out, whatever becomes of the process that mapped it, so a session that
 * ends without cleaning up, such as one whose terminal is closed, leaves its
 * drive behind; the lease lets a later session tell such a drive from one
 * still in use. Leases are kept by letter in Tesota's own folder.
 */
export interface DriveLease {
  readonly drive: string;
  readonly pid: number;
}

const LEASES = join(homedir(), ".tesota", "drives");

function leaseFile(letter: string): string {
  return join(LEASES, `${letter.toUpperCase()}.json`);
}

/** A drive mapped before leases were kept by letter kept its lease in the sandbox folder beside the workspace it mapped. */
function legacyLeaseFile(mapped: string): string {
  return join(sandboxRoot(mapped), "drive.json");
}

async function leaseAt(file: string): Promise<{ drive: string; pid: number; target?: string } | undefined> {
  try {
    const lease: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof lease !== "object" || lease === null) return undefined;
    const [drive, pid, target] = [Reflect.get(lease, "drive"), Reflect.get(lease, "pid"), Reflect.get(lease, "target")];
    if (typeof drive !== "string" || !Number.isSafeInteger(pid)) return undefined;
    return { drive, pid: pid as number, ...typeof target === "string" ? { target } : {} };
  } catch { return undefined; }
}

/** The lease of the drive at this letter, when it names the folder the drive maps. */
async function readLease(letter: string, mapped: string): Promise<DriveLease | undefined> {
  const lease = await leaseAt(leaseFile(letter));
  if (lease?.target !== undefined && normalized(lease.target) === normalized(mapped)) return lease;
  return leaseAt(legacyLeaseFile(mapped));
}

/** Whether a process is running; one Tesota may not signal counts as running, so its drive is kept. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, "code") === "EPERM";
  }
}

/** The drives a session that has ended left behind: leased to their letter by a process no longer running. */
export async function staleDrives(listing: string, lease: (letter: string, mapped: string) => Promise<DriveLease | undefined>,
  running: (pid: number) => boolean): Promise<string[]> {
  const stale: string[] = [];
  for (const [letter, mapped] of substitutedDrives(listing)) {
    const held = await lease(letter, mapped);
    const leased = held !== undefined && held.drive.toUpperCase() === letter;
    if (releasesDrive(leased, leased && running(held.pid))) stale.push(letter);
  }
  return stale;
}

/** Remove the drives sessions that have ended left behind, and their leases. */
async function releaseStaleDrives(): Promise<void> {
  const listing = (await subst([])).output;
  const mapped = substitutedDrives(listing);
  for (const letter of await staleDrives(listing, readLease, isRunning)) {
    if (!(await subst([`${letter}:`, "/d"])).ok) continue;
    await rm(leaseFile(letter), { force: true });
    await rm(legacyLeaseFile(mapped.get(letter) ?? ""), { force: true });
  }
}

/** Map the folder that holds the workspace to a free drive letter, trying from Z down so the operator's own letters stay free. */
async function mapDrive(workspace: string): Promise<string> {
  await releaseStaleDrives();
  const target = driveTarget(workspace);
  // A drive this workspace had before, including one over the workspace itself as earlier versions mapped it.
  await unmapDrives(target);
  await unmapDrives(workspace);
  const taken = new Set((substitutedDrives((await subst([])).output)).keys());
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    if (taken.has(letter) || existsSync(`${letter}:\\`)) continue;
    if ((await subst([`${letter}:`, target])).ok) {
      await mkdir(LEASES, { recursive: true });
      await writeFile(leaseFile(letter), JSON.stringify({ drive: letter, pid: process.pid, target }));
      return letter;
    }
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
 * and never reads its value, so it names the sandbox's own folder. `PATH`
 * keeps a folder of the operator's home only when it is one of the tool
 * folders the sandbox may read, such as Bun's: a program found first in one it
 * cannot read, such as a global npm in `AppData\Roaming\npm`, would hang
 * instead of falling through to the installed one. PowerShell writes its module cache
 * into the current folder when it cannot resolve its own, so it is given the
 * sandbox's temporary folder.
 */
export function sandboxVariables(host: Readonly<Record<string, string | undefined>>, folders: SandboxFolders,
  given: Readonly<Record<string, string>> = {}, operatorHome: string = homedir(), tools: readonly string[] = []): Record<string, string> {
  const system = Object.fromEntries(Object.entries(host).filter(([name, value]) =>
    value !== undefined && systemVariables.includes(name.toUpperCase())).map(([name, value]) => [name.toUpperCase(), value ?? ""]));
  const home = normalized(operatorHome);
  const within = (folder: string, parent: string): boolean => folder === parent || folder.startsWith(`${parent}${sep}`);
  const readableTools = tools.map(normalized);
  if (system["PATH"] !== undefined) {
    system["PATH"] = system["PATH"].split(";").filter((entry) => {
      if (entry.trim() === "") return false;
      const folder = normalized(entry);
      return !within(folder, home) || readableTools.some((tool) => within(folder, tool));
    }).join(";");
  }
  const proxy = folders.proxy;
  // Node would otherwise walk the folders above its own install folder, which the sandbox cannot query.
  const nodeOptions = ["--preserve-symlinks --preserve-symlinks-main", given["NODE_OPTIONS"]].filter(Boolean).join(" ");
  return { ...system, USERPROFILE: folders.home, HOME: folders.home,
    LOCALAPPDATA: join(folders.home, "AppData", "Local"), APPDATA: join(folders.home, "AppData", "Roaming"),
    TEMP: folders.temp, TMP: folders.temp, PSModuleAnalysisCachePath: join(folders.temp, "PowerShell", "ModuleAnalysisCache"),
    npm_config_cache: join(folders.cache, "npm"), BUN_INSTALL_CACHE_DIR: join(folders.cache, "bun"),
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
    // The drive's folder is readable so tools can resolve the workspace's parent; what else it holds is denied per command.
    const readable = [...sandboxToolPaths(getAvailableToolsPolicy(process.env).readonlyPaths ?? [], homedir()), driveTarget(workspace)];
    const writable = [resolve(workspace), root, ...options.cacheDirectory === undefined ? [] : [folders.cache]];
    const drive = await mapDrive(resolve(workspace)).catch(async (error: unknown) => { await proxy.close(); throw error; });
    const sandbox: Sandbox = { workspace: resolve(workspace), drive, scripts: join(root, "commands"), readable, writable,
      folders: { ...folders, proxy: proxy.url }, systemRoot: process.env["SYSTEMROOT"] ?? "C:\\Windows" };
    await mkdir(sandbox.scripts, { recursive: true });
    const preparation = await installOnHost(resolve(workspace), { marker: join(root, "dependencies.sha256"), proxy: proxy.url,
      cache: folders.cache, ...options.onProgress === undefined ? {} : { onProgress: options.onProgress } });
    return { provider: "mxc", shell: "powershell", javascriptRuntime: process.execPath,
      commandRoot: onDrive(drive, sandbox.workspace, sandbox.workspace), guarantees: MXC_GUARANTEES, preparation, network: proxy,
      run: (command, runOptions) => runCommand(sandbox, command, runOptions),
      dispose: async () => {
        await proxy.close();
        if ((await subst([`${drive}:`, "/d"])).ok) await rm(leaseFile(drive), { force: true });
      } };
  })();
}

/** What every command of one prepared sandbox shares. */
interface Sandbox {
  readonly workspace: string;
  /** The drive letter `subst` maps to the folder that holds the workspace; commands run in the workspace on it. */
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
  const temp = `${sandbox.drive}:\\${relative(driveTarget(sandbox.workspace), sandbox.folders.temp)}`;
  await writeFile(script, `\uFEFF${powershellScript(cwd, command, temp)}`, "utf8");
  try {
    const config = createConfigFromPolicy({ version: POLICY_VERSION,
      filesystem: { readonlyPaths: [...sandbox.readable], readwritePaths: [...sandbox.writable],
        deniedPaths: await deniedBeside(sandbox.workspace) },
      // Proxy-only egress: Windows' filtering platform lets the container reach only the proxy's loopback port.
      network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } },
      runtimeConfig: { networkProxy: sandbox.folders.proxy } });
    if (config.process === undefined) throw new Error("MXC gave no process configuration");
    config.process.commandLine = powershellCommandLine(script, sandbox.systemRoot);
    config.process.cwd = cwd;
    // Console tools such as node and git need Win32k to start; clipboard, input and desktop controls stay denied.
    config.ui = { disable: false, clipboard: "none", injection: false };
    return await supervise(spawnSandboxFromConfig(config, { usePty: false }, undefined,
      sandboxVariables(process.env, sandbox.folders, runOptions.env, homedir(), sandbox.readable)), runOptions);
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
    await unmapDrives(driveTarget(workspace));
    await unmapDrives(resolve(workspace));
    await rm(sandboxRoot(workspace), { recursive: true, force: true, maxRetries: 3 });
  },
};
