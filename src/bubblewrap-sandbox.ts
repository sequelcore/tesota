import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { constants, homedir, release } from "node:os";
import { posix } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import * as z from "zod";
import { EgressProxy } from "./egress-proxy.js";
import { PACKAGE_REGISTRY_HOSTS, type RunOutcome } from "./execution-environment.js";
import { readsToolFolder } from "./verification/tool-folder-rule.js";

// This side runs on Linux, so its paths follow Linux's rules wherever it is tested.
const { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } = posix;

/**
 * The Linux side of the WSL sandbox candidate (issue 163): one process per
 * prepared environment, run by Tesota inside its WSL distribution, that runs
 * each command in its own bubblewrap sandbox and hosts the egress proxy. A
 * command sees a root of its own: the system's programs and configuration
 * read-only, the tool folders on `PATH`, the workspace, and the session's own
 * home, temporary folder and package caches; nothing of the operator's home
 * or of Windows' drives but the workspace. Its network namespace has only a
 * loopback interface, where a relay passes connections to the proxy's socket,
 * the one path out, so a program that ignores proxy variables reaches nothing,
 * as Codex's and Anthropic's Linux sandboxes do. WSL's interop, which starts
 * Windows programs, answers on a socket under `/run/WSL`, which no command
 * sees. The host talks to this process in JSON lines over its standard input
 * and output.
 */

/** Where the relay listens inside each command's network namespace, and so where its proxy variables point. */
export const SANDBOX_PROXY_PORT = 3128;

/** The system's own folders; a merged `/usr` makes the others links, kept as links. */
const SYSTEM_FOLDERS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc"];

/** Filesystems that are Windows' drives inside WSL; their tool folders are Windows programs, which a command may not start. */
const WINDOWS_FILESYSTEMS = new Set(["9p", "drvfs", "virtiofs"]);

export interface SystemFolder {
  readonly path: string;
  /** Present when the folder is a link, such as `/bin` to `usr/bin`. */
  readonly link?: string;
}

/** Everything one command's sandbox is made of, as paths inside WSL. */
export interface SandboxLayout {
  readonly workspace: string;
  readonly home: string;
  readonly temp: string;
  readonly cache: string;
  /** A folder on WSL's own disk mounted as the workspace's `node_modules`, for a JavaScript package. */
  readonly modules?: string;
  readonly relay: string;
  readonly socket: string;
  /** The JavaScript runtime that runs the relay, which lies inside a readable folder. */
  readonly runtime: string;
  readonly system: readonly SystemFolder[];
  /** Tool folders the command may read, such as the one Node is installed in. */
  readonly tools: readonly string[];
}

/**
 * The relay each sandbox starts before its command: loopback connections to
 * the proxy port are passed to the proxy's socket, and the relay ends with the
 * command, carrying its exit status.
 */
const RELAY_SOURCE = `"use strict";
const net = require("node:net");
const { spawn } = require("node:child_process");
const { constants } = require("node:os");
const [, , socket, port, command] = process.argv;
net.createServer((client) => {
  const upstream = net.connect(socket);
  client.on("error", () => { upstream.destroy(); });
  upstream.on("error", () => { client.destroy(); });
  client.pipe(upstream).pipe(client);
}).listen(Number(port), "127.0.0.1", () => {
  const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit" });
  child.on("error", () => { process.exit(127); });
  child.on("exit", (code, signal) => { process.exit(code ?? 128 + (constants.signals[signal] ?? 0)); });
});
`;

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

/** The system folders present on this machine, links as links. */
export function systemFolders(): SystemFolder[] {
  return SYSTEM_FOLDERS.flatMap((path): SystemFolder[] => {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return [{ path, link: readlinkSync(path) }];
      return stat.isDirectory() ? [{ path }] : [];
    } catch { return []; }
  });
}

/** One line of `/proc/self/mountinfo`: where it is mounted, the filesystem, its source and its superblock options. */
function mounts(mountinfo: string): { mountPoint: string; type: string; source: string; options: string }[] {
  return mountinfo.split("\n").flatMap((line) => {
    const [before, after] = line.split(" - ");
    const mountPoint = before?.split(" ")[4];
    const [type, source, options] = after?.split(" ") ?? [];
    return mountPoint === undefined || type === undefined ? [] : [{ mountPoint, type, source: source ?? "", options: options ?? "" }];
  });
}

/**
 * Mount points of every filesystem WSL shares from Windows, drives and
 * others such as its GPU drivers, which a command's tool folders never
 * include.
 */
export function windowsMounts(mountinfo: string): string[] {
  return mounts(mountinfo).filter((mount) => WINDOWS_FILESYSTEMS.has(mount.type)).map((mount) => mount.mountPoint);
}

/** A drive's root as WSL names a mount's source: `C:`, `C:\`, `C:/` or `C:\134`, the escaped backslash of mount tables. */
const DRIVE_ROOT = /^[A-Za-z]:(?:\\134|\\|\/)?$/u;

/**
 * Mount points of Windows' drives themselves, which hold workspaces, as WSL
 * tells them apart: a 9p share of `drvfs` whose path is a drive's root, or a
 * `drvfs` mount of one.
 */
export function windowsDrives(mountinfo: string): string[] {
  return mounts(mountinfo).filter((mount) => {
    if (mount.type === "drvfs") return DRIVE_ROOT.test(mount.source);
    if (mount.type !== "9p") return false;
    const share = mount.options.split(",").find((option) => option.startsWith("aname=drvfs;"));
    const path = share?.split(";").find((part) => part.startsWith("path="))?.slice("path=".length);
    return path !== undefined && DRIVE_ROOT.test(path);
  }).map((mount) => mount.mountPoint);
}

/**
 * Whether WSL's configuration asks for what the sandbox needs at the
 * distribution's next start: interop off, and Windows' drives owned by this
 * user and group.
 */
export function settingsWritten(configuration: string, uid: number, gid: number): boolean {
  const values = new Map<string, string>();
  let section = "";
  for (const line of configuration.split(/\r?\n/u).map((text) => text.replace(/#.*$/u, "").trim())) {
    const header = /^\[(.+)\]$/u.exec(line);
    if (header !== null) { section = (header[1] ?? "").trim().toLowerCase(); continue; }
    const separator = line.indexOf("=");
    if (separator > 0) values.set(`${section}.${line.slice(0, separator).trim().toLowerCase()}`, line.slice(separator + 1).trim().replace(/^"(.*)"$/u, "$1"));
  }
  const options = (values.get("automount.options") ?? "").split(",").map((option) => option.trim());
  return values.get("interop.enabled")?.toLowerCase() === "false" && options.includes(`uid=${uid}`) && options.includes(`gid=${gid}`);
}

/**
 * The tool folders a command may read, from `PATH`: a `bin` folder's
 * installation, such as `/opt/node` for `/opt/node/bin`, so a tool finds its
 * own libraries, as `readsToolFolder` decides (proved).
 */
export function toolFolders(path: string, home: string, windows: readonly string[]): string[] {
  const candidates = path.split(delimiter).filter((entry) => isAbsolute(entry)).map((entry) => {
    const folder = normalize(entry).replace(/(.)\/+$/u, "$1");
    return basename(folder) === "bin" ? dirname(folder) : folder;
  });
  const kept = [...new Set(candidates)].filter((folder) => readsToolFolder(within(home, folder),
    windows.some((mount) => within(folder, mount)), SYSTEM_FOLDERS.some((system) => within(folder, system))));
  return kept.filter((folder) => !kept.some((other) => other !== folder && within(folder, other))).sort();
}

/** The `PATH` a command gets: the entries it can reach, in their order. */
export function commandPath(path: string, tools: readonly string[]): string {
  const reachable = ["/usr", "/bin", "/sbin", ...tools];
  return path.split(delimiter).filter((entry) => isAbsolute(entry) && reachable.some((folder) => within(normalize(entry), folder)))
    .join(delimiter);
}

/** Only what a command needs: its `PATH`, the session's own folders, the proxy, and what it was given. */
export function commandVariables(layout: SandboxLayout, path: string, given: Readonly<Record<string, string>>): Record<string, string> {
  const proxy = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
  // Servers a command starts on its own loopback are its own; nothing else answers there.
  const local = "localhost,127.0.0.1,::1";
  return { PATH: path, HOME: layout.home, TMPDIR: "/tmp", LANG: "C.UTF-8",
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: local, no_proxy: local,
    npm_config_cache: join(layout.cache, "npm"), BUN_INSTALL_CACHE_DIR: join(layout.cache, "bun"), ...given };
}

/**
 * bubblewrap's arguments for one command: new user, process, network, IPC,
 * UTS and cgroup namespaces; the system and tool folders read-only; the
 * workspace and the session's folders writable; nothing else. `--info-fd 3`
 * reports the sandbox's first process, whose end ends every process in it.
 */
export function bubblewrapArguments(layout: SandboxLayout, cwd: string, command: string): string[] {
  const system = layout.system.flatMap((folder) => folder.link === undefined ? ["--ro-bind", folder.path, folder.path]
    : ["--symlink", folder.link, folder.path]);
  const modules = layout.modules === undefined ? [] : ["--bind", layout.modules, join(layout.workspace, "node_modules")];
  return ["--unshare-all", "--die-with-parent", "--new-session", ...system,
    ...layout.tools.flatMap((folder) => ["--ro-bind-try", folder, folder]),
    "--proc", "/proc", "--dev", "/dev", "--bind", layout.temp, "/tmp",
    "--bind", layout.home, layout.home, "--bind", layout.cache, layout.cache,
    "--bind", layout.workspace, layout.workspace, ...modules,
    "--ro-bind", layout.relay, layout.relay, "--bind", layout.socket, layout.socket,
    "--chdir", cwd, "--info-fd", "3", "--", layout.runtime, layout.relay, layout.socket, String(SANDBOX_PROXY_PORT), command];
}

/** What the host asks: run a command, stop one, open the network to destinations, or report what it refused. */
export type HostMessage =
  | Readonly<{ type: "run"; id: string; command: string; cwd: string; env: Readonly<Record<string, string>>; timeoutSeconds?: number | undefined }>
  | Readonly<{ type: "stop"; id: string }>
  | Readonly<{ type: "allow"; destinations: readonly string[] }>
  | Readonly<{ type: "blocked"; id: string; since: number }>;

const hostMessage: z.ZodType<HostMessage> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run"), id: z.string(), command: z.string(), cwd: z.string(),
    env: z.record(z.string(), z.string()), timeoutSeconds: z.number().positive().optional() }),
  z.strictObject({ type: z.literal("stop"), id: z.string() }),
  z.strictObject({ type: z.literal("allow"), destinations: z.array(z.string()) }),
  z.strictObject({ type: z.literal("blocked"), id: z.string(), since: z.number() }),
]);

/** What this side answers: ready or failed once, then commands' output and ends, and refused destinations. */
export const sandboxMessage: z.ZodType<SandboxMessage> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), workspace: z.string() }),
  z.strictObject({ type: z.literal("failed"), message: z.string() }),
  z.strictObject({ type: z.literal("output"), id: z.string(), data: z.string() }),
  z.strictObject({ type: z.literal("ended"), id: z.string(),
    outcome: z.enum(["exited", "timed_out", "cancelled", "not_started", "unconfirmed"]), exitCode: z.number().nullable() }),
  z.strictObject({ type: z.literal("blocked"), id: z.string(), destinations: z.array(z.string()) }),
  z.strictObject({ type: z.literal("checked"), problems: z.array(z.string()), settings: z.array(z.string()), versions: z.string() }),
]);
export type SandboxMessage =
  | Readonly<{ type: "ready"; workspace: string }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "output"; id: string; data: string }>
  | Readonly<{ type: "ended"; id: string; outcome: RunOutcome; exitCode: number | null }>
  | Readonly<{ type: "blocked"; id: string; destinations: readonly string[] }>
  | Readonly<{ type: "checked"; problems: readonly string[]; settings: readonly string[]; versions: string }>;

/** How the host's paths become this side's: WSL's own translation of Windows paths, or the same path on Linux. */
export type PathTranslation = "wsl" | "native";

function translate(path: string, paths: PathTranslation): string {
  return paths === "wsl" ? execFileSync("wslpath", ["-a", "-u", path], { encoding: "utf8" }).trim() : resolve(path);
}

/** A workspace's own folders on WSL's disk: its home, temporary folder, `node_modules` and the proxy's socket. */
function stateFolder(workspace: string): string {
  const base = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "tesota", "sandboxes", createHash("sha256").update(workspace).digest("hex").slice(0, 16));
}

const STOP_CONFIRM_MS = 5_000;

/** Whether a process has ended; a process that has ended but not yet been collected has ended too. */
function ended(pid: number): boolean {
  try {
    return /^\d+ \(.*\) Z/su.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch { return true; }
}

/**
 * Whether the sandbox's first process is gone within a few seconds. The
 * kernel ends every other process in its namespace before it ends, so its end
 * confirms that the command and its descendants stopped.
 */
async function sandboxGone(pid: number | undefined): Promise<boolean> {
  // bubblewrap had not started the sandbox when it was stopped; the sandbox dies with it.
  if (pid === undefined) return true;
  const deadline = Date.now() + STOP_CONFIRM_MS;
  while (!ended(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  return true;
}

/** One running command: its bubblewrap process, how to stop it, and the sandbox it reported. */
interface Running {
  readonly child: ChildProcess;
  stop(reason: "cancelled" | "timed_out"): void;
  readonly done: Promise<void>;
}

class SandboxServer {
  readonly #layout: SandboxLayout;
  readonly #path: string;
  readonly #bubblewrap: string;
  readonly #proxy: EgressProxy;
  readonly #send: (message: SandboxMessage) => void;
  readonly #running = new Map<string, Running>();

  constructor(layout: SandboxLayout, path: string, bubblewrap: string, proxy: EgressProxy, send: (message: SandboxMessage) => void) {
    this.#layout = layout;
    this.#path = path;
    this.#bubblewrap = bubblewrap;
    this.#proxy = proxy;
    this.#send = send;
  }

  async handle(message: HostMessage): Promise<void> {
    switch (message.type) {
      case "run": this.#run(message); return;
      case "stop": this.#running.get(message.id)?.stop("cancelled"); return;
      case "allow": await this.#proxy.allow(message.destinations); return;
      case "blocked":
        this.#send({ type: "blocked", id: message.id, destinations: await this.#proxy.blockedSince(new Date(message.since)) });
    }
  }

  #run(message: Extract<HostMessage, { type: "run" }>): void {
    const cwd = resolve(this.#layout.workspace, message.cwd);
    if (!within(cwd, this.#layout.workspace)) {
      this.#send({ type: "ended", id: message.id, outcome: "not_started", exitCode: null });
      return;
    }
    const child = spawn(this.#bubblewrap, bubblewrapArguments(this.#layout, cwd, message.command),
      { env: commandVariables(this.#layout, this.#path, message.env), stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let info = "";
    child.stdio[3]?.on("data", (chunk: Buffer) => { info += chunk.toString("utf8"); });
    const output = (chunk: Buffer): void => { this.#send({ type: "output", id: message.id, data: chunk.toString("base64") }); };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    let stopping: "cancelled" | "timed_out" | undefined;
    const timer = message.timeoutSeconds === undefined ? undefined
      : setTimeout(() => { running.stop("timed_out"); }, message.timeoutSeconds * 1_000);
    const done = new Promise<void>((settle) => {
      const finish = (outcome: RunOutcome, exitCode: number | null): void => {
        clearTimeout(timer);
        this.#running.delete(message.id);
        this.#send({ type: "ended", id: message.id, outcome, exitCode });
        settle();
      };
      child.once("error", () => { finish("not_started", null); });
      child.once("close", (code, signal) => {
        if (stopping === undefined) { finish("exited", code ?? 128 + (signal === null ? 0 : constants.signals[signal])); return; }
        const pid = /"child-pid":\s*(\d+)/u.exec(info)?.[1];
        void sandboxGone(pid === undefined ? undefined : Number(pid)).then((gone) => { finish(gone ? stopping ?? "cancelled" : "unconfirmed", null); });
      });
    });
    const running: Running = { child, done, stop: (reason) => { if (stopping !== undefined) return; stopping = reason; child.kill("SIGKILL"); } };
    this.#running.set(message.id, running);
  }

  /** Stop every command, confirm each has ended, and close the proxy. */
  async close(): Promise<void> {
    const running = [...this.#running.values()];
    for (const command of running) command.stop("cancelled");
    await Promise.all(running.map((command) => command.done));
    await this.#proxy.close();
  }
}

/** bubblewrap on `PATH`, outside any folder a repository controls. */
function locateBubblewrap(): string | undefined {
  for (const folder of (process.env["PATH"] ?? "").split(delimiter).filter((entry) => isAbsolute(entry))) {
    const candidate = join(folder, "bwrap");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function toolsOnThisMachine(): string[] {
  let mounts: string[] = [];
  try { mounts = windowsMounts(readFileSync("/proc/self/mountinfo", "utf8")); } catch { mounts = []; }
  // The runtime running this process also runs each sandbox's relay.
  return toolFolders([dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter), homedir(), mounts);
}

export interface ServeOptions {
  readonly workspace: string;
  readonly cache?: string;
  readonly paths: PathTranslation;
}

/**
 * Prepare the workspace's sandbox, report it ready, then run what the host
 * asks until its input ends, when every command is stopped and the proxy
 * closed.
 */
export async function serve(options: ServeOptions, input: Readable, output: Writable): Promise<void> {
  const send = (message: SandboxMessage): void => { output.write(`${JSON.stringify(message)}\n`); };
  const bubblewrap = locateBubblewrap();
  if (bubblewrap === undefined) { send({ type: "failed", message: "bubblewrap (bwrap) is not installed" }); return; }
  const workspace = translate(options.workspace, options.paths);
  const state = stateFolder(workspace);
  const layout: SandboxLayout = { workspace, home: join(state, "home"), temp: join(state, "tmp"),
    cache: options.cache === undefined ? join(state, "cache") : translate(options.cache, options.paths),
    ...existsSync(join(workspace, "package.json")) ? { modules: join(state, "node_modules") } : {},
    relay: join(state, "relay.cjs"), socket: join(state, "proxy.sock"), runtime: process.execPath,
    system: systemFolders(), tools: toolsOnThisMachine() };
  for (const folder of [layout.home, layout.temp, join(layout.cache, "npm"), join(layout.cache, "bun"), layout.modules]) {
    if (folder !== undefined) await mkdir(folder, { recursive: true });
  }
  // The mount point for the workspace's own node_modules, as Docker Sandboxes makes it.
  if (layout.modules !== undefined) await mkdir(join(workspace, "node_modules"), { recursive: true });
  await writeFile(layout.relay, RELAY_SOURCE, "utf8");
  await rm(layout.socket, { force: true });
  const proxy = await EgressProxy.start({ allowed: PACKAGE_REGISTRY_HOSTS.map((host) => `${host}:443`), socket: layout.socket });
  const server = new SandboxServer(layout, commandPath(process.env["PATH"] ?? "", layout.tools), bubblewrap, proxy, send);
  send({ type: "ready", workspace });
  for await (const line of createInterface({ input })) {
    let parsed: ReturnType<typeof hostMessage.safeParse> | undefined;
    try { parsed = hostMessage.safeParse(JSON.parse(line)); } catch { parsed = undefined; }
    if (parsed?.success === true) void server.handle(parsed.data).catch(() => undefined);
  }
  await server.close();
}

/** Remove what a workspace's sandbox kept on WSL's disk. */
export async function releaseState(workspace: string, paths: PathTranslation): Promise<void> {
  await rm(stateFolder(translate(workspace, paths)), { recursive: true, force: true });
}

/**
 * What stands between this machine and a working sandbox. Problems are what
 * setup fixes: bubblewrap missing or unable to create its namespaces, and in
 * WSL a configuration that does not ask for interop off and Windows' drives
 * owned by this user. Settings are what that configuration asks for but WSL
 * applies only when the distribution starts again: interop still able to
 * start Windows programs, and a drive owned by another user, which Git refuses
 * as dubious ownership and where only the owner may change permissions. So a
 * restart is offered only for what a restart can apply. The versions are what
 * qualification depends on.
 */
export function check(paths: PathTranslation): Readonly<{ problems: string[]; settings: string[]; versions: string }> {
  const problems: string[] = [];
  const settings: string[] = [];
  const bubblewrap = locateBubblewrap();
  const version = bubblewrap === undefined ? "none" : spawnSync(bubblewrap, ["--version"], { encoding: "utf8" }).stdout.trim();
  if (bubblewrap === undefined) problems.push("bubblewrap (bwrap) is not installed");
  else {
    const system = systemFolders().flatMap((folder) => folder.link === undefined ? ["--ro-bind", folder.path, folder.path]
      : ["--symlink", folder.link, folder.path]);
    const trial = spawnSync(bubblewrap, ["--unshare-all", "--die-with-parent", ...system, "--", "/bin/sh", "-c", "true"],
      { encoding: "utf8", env: {} });
    if (trial.status !== 0) problems.push(`bubblewrap cannot create its namespaces here: ${trial.stderr.trim().slice(-300)}`);
  }
  if (paths === "wsl") {
    const [uid, gid] = [process.getuid?.() ?? -1, process.getgid?.() ?? -1];
    const configuration = existsSync("/etc/wsl.conf") ? readFileSync("/etc/wsl.conf", "utf8") : "";
    if (!settingsWritten(configuration, uid, gid)) {
      problems.push("/etc/wsl.conf does not turn interop off and give Windows' drives to this user");
    } else {
      if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) settings.push("Windows interop is still on");
      for (const drive of windowsDrives(readFileSync("/proc/self/mountinfo", "utf8"))) {
        const owner = statSync(drive).uid;
        if (owner !== uid) settings.push(`${drive} is still owned by user ${owner}, not by this user (${uid})`);
      }
    }
  }
  return { problems, settings, versions: `${version}; linux ${release()}; node ${process.version}` };
}
