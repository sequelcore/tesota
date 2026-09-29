import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants, homedir, release } from "node:os";
import { posix } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import * as z from "zod";
import { EgressProxy } from "./egress-proxy.js";
import { PACKAGE_REGISTRY_HOSTS, type PreparationStep, type RunOutcome } from "./execution-environment.js";
import { MISE_RELEASE } from "./toolchain.js";
import type { NetworkPhase } from "./verification/setup-network-rule.js";
import { readsToolFolder } from "./verification/tool-folder-rule.js";
import { countsAsDrive, settingsAsked } from "./verification/wsl-settings-rule.js";

// This side runs on Linux, so its paths follow Linux's rules wherever it is tested.
const { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve } = posix;

/**
 * The Linux side of the WSL sandbox (decision 043): one process per
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
 * sees. Before the agent's first command, setup may install the repository's
 * tools into its toolchain folder, the only time that folder is writable and
 * the proxy permits setup's destinations (decision 048). The host talks to
 * this process in JSON lines over its standard input and output.
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
  /** The session's own home, on WSL's disk. */
  readonly home: string;
  /**
   * Where that home appears to commands: the account's own home, so a program
   * that asks the system for it, as Java does, finds the same folder as
   * `HOME`, and Maven's settings and downloads persist.
   */
  readonly account: string;
  readonly temp: string;
  readonly cache: string;
  /** The repository's installed tools, on WSL's own disk: writable during setup, read-only to every other command. */
  readonly toolchains: string;
  /** A folder on WSL's own disk mounted as the workspace's `node_modules`, for a JavaScript package. */
  readonly modules?: string;
  readonly relay: string;
  readonly socket: string;
  /** An empty file mounted read-only over each file hidden from commands. */
  readonly mask: string;
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
 * Mount points of Windows' drives themselves, which hold workspaces, as
 * `countsAsDrive` decides (proved): a `drvfs` mount of a drive's root, or a 9p
 * share of `drvfs` whose path is one.
 */
export function windowsDrives(mountinfo: string): string[] {
  return mounts(mountinfo).filter((mount) => {
    const share = mount.options.split(",").find((option) => option.startsWith("aname=drvfs;"));
    const root = mount.type === "drvfs" ? mount.source : share?.split(";").find((part) => part.startsWith("path="))?.slice("path=".length);
    return countsAsDrive(mount.type === "drvfs" ? "drvfs" : mount.type === "9p" ? "plan9" : "other", share !== undefined,
      root !== undefined && DRIVE_ROOT.test(root));
  }).map((mount) => mount.mountPoint);
}

/**
 * Whether WSL's configuration asks for what the sandbox needs at the
 * distribution's next start, as `settingsAsked` decides (proved): interop off,
 * and Windows' drives owned by this user and group.
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
  return settingsAsked(values.get("interop.enabled")?.toLowerCase() === "false", options.includes(`uid=${uid}`), options.includes(`gid=${gid}`));
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
  return { PATH: path, HOME: layout.account, TMPDIR: "/tmp", LANG: "C.UTF-8",
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: local, no_proxy: local,
    npm_config_cache: join(layout.cache, "npm"), BUN_INSTALL_CACHE_DIR: join(layout.cache, "bun"), ...given };
}

/** Paths inside the workspace a command may read but not change, and files it may not read at all. */
/** Paths inside the mounted folder, relative, that a command may read but not change, and files it may not read at all. */
export interface GuardedPaths {
  readonly readOnly: readonly string[];
  readonly hidden: readonly string[];
}

/**
 * What to guard in the folder mounted as the workspace for one command: its
 * Git data read-only, so a command cannot change the repository's hooks or
 * history, and each file hidden from the agent that exists as a plain file.
 * `hidden` is relative with forward slashes; a path that leaves the folder,
 * or that is a link or folder, is not mounted over.
 */
export async function guardedPaths(folder: string, hidden: readonly string[]): Promise<GuardedPaths> {
  const readOnly = await lstat(join(folder, ".git")).then((metadata) => metadata.isSymbolicLink() ? [] : [".git"], () => []);
  const files: string[] = [];
  for (const path of hidden) {
    const target = resolve(folder, ...path.split("/"));
    if (path.length === 0 || target === folder || !within(target, folder)) continue;
    if ((await lstat(target).catch(() => undefined))?.isFile() === true) files.push(relative(folder, target));
  }
  return { readOnly, hidden: files };
}

/**
 * bubblewrap's arguments for one command: new user, process, network, IPC,
 * UTS and cgroup namespaces; the system and tool folders read-only; the
 * workspace and the session's folders writable, except the workspace's
 * guarded paths; the repository's toolchain folder writable only in setup;
 * nothing else. `--info-fd 3` reports the sandbox's first process, whose end
 * ends every process in it. `mounted` is the folder commands see at the
 * workspace's path: the workspace itself, or another, such as a checkout of
 * the tree before a turn, so a command sees the same paths either way.
 */
export function bubblewrapArguments(layout: SandboxLayout, cwd: string, command: string, phase: NetworkPhase,
  guarded: GuardedPaths = { readOnly: [], hidden: [] }, mounted: string = layout.workspace): string[] {
  const system = layout.system.flatMap((folder) => folder.link === undefined ? ["--ro-bind", folder.path, folder.path]
    : ["--symlink", folder.link, folder.path]);
  const modules = layout.modules === undefined ? [] : ["--bind", layout.modules, join(layout.workspace, "node_modules")];
  // The home comes before what lies inside the account's home, such as tool folders and Tesota's own state, which overlay it.
  return ["--unshare-all", "--die-with-parent", "--new-session", ...system, "--bind", layout.home, layout.account,
    ...layout.tools.flatMap((folder) => ["--ro-bind-try", folder, folder]),
    "--proc", "/proc", "--dev", "/dev", "--bind", layout.temp, "/tmp",
    "--bind", layout.cache, layout.cache,
    phase === "setup" ? "--bind" : "--ro-bind", layout.toolchains, layout.toolchains,
    "--bind", mounted, layout.workspace, ...modules,
    ...guarded.readOnly.flatMap((path) => ["--ro-bind", join(mounted, path), join(layout.workspace, path)]),
    ...guarded.hidden.flatMap((path) => ["--ro-bind", layout.mask, join(layout.workspace, path)]),
    "--ro-bind", layout.relay, layout.relay, "--bind", layout.socket, layout.socket,
    "--chdir", cwd, "--info-fd", "3", "--", layout.runtime, layout.relay, layout.socket, String(SANDBOX_PROXY_PORT), command];
}

/** One setup stage: its shell script, and whether its output names the installed tools' folders. */
export type SetupStageMessage = Readonly<{ description: string; script: string; toolFolders?: boolean | undefined }>;

/**
 * What the host asks: run a command, stop one, open the network to
 * destinations, or set up the environment before its first command: the
 * stages in order with the variables they need, the destinations open during
 * them, and a fingerprint of all of it, which skips a setup that already
 * succeeded here.
 */
export type HostMessage =
  | Readonly<{ type: "run"; id: string; command: string; cwd: string; env: Readonly<Record<string, string>>; timeoutSeconds?: number | undefined;
    hidden?: readonly string[] | undefined; root?: string | undefined }>
  | Readonly<{ type: "stop"; id: string }>
  | Readonly<{ type: "allow"; destinations: readonly string[] }>
  | Readonly<{ type: "setup"; id: string; fingerprint: string; destinations: readonly string[]; env: Readonly<Record<string, string>>;
    stages: readonly SetupStageMessage[]; timeoutSeconds: number }>;

const hostMessage: z.ZodType<HostMessage> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run"), id: z.string(), command: z.string(), cwd: z.string(),
    env: z.record(z.string(), z.string()), timeoutSeconds: z.number().positive().optional(), hidden: z.array(z.string()).optional(),
    root: z.string().optional() }),
  z.strictObject({ type: z.literal("stop"), id: z.string() }),
  z.strictObject({ type: z.literal("allow"), destinations: z.array(z.string()) }),
  z.strictObject({ type: z.literal("setup"), id: z.string(), fingerprint: z.string(), destinations: z.array(z.string()),
    env: z.record(z.string(), z.string()), stages: z.array(z.strictObject({ description: z.string(), script: z.string(),
      toolFolders: z.boolean().optional() })), timeoutSeconds: z.number().positive() }),
]);

/**
 * What this side answers: ready or failed once, then commands' output and
 * ends, each end with what the proxy refused while that command ran, by this
 * side's own clock, so no two clocks are compared; for setup, each stage as
 * it starts, then the steps it took, or why commands can no longer run.
 */
export const sandboxMessage: z.ZodType<SandboxMessage> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), workspace: z.string(), home: z.string(), toolchains: z.string() }),
  z.strictObject({ type: z.literal("failed"), message: z.string() }),
  z.strictObject({ type: z.literal("output"), id: z.string(), data: z.string() }),
  z.strictObject({ type: z.literal("ended"), id: z.string(),
    outcome: z.enum(["exited", "timed_out", "cancelled", "not_started", "unconfirmed"]), exitCode: z.number().nullable(),
    refused: z.array(z.string()) }),
  z.strictObject({ type: z.literal("stage"), id: z.string(), description: z.string() }),
  z.strictObject({ type: z.literal("prepared"), id: z.string(), steps: z.array(z.strictObject({ description: z.string(),
    outcome: z.enum(["done", "failed"]), output: z.string() })), error: z.string().optional() }),
  z.strictObject({ type: z.literal("checked"), problems: z.array(z.string()), settings: z.array(z.string()), versions: z.string() }),
]);
export type SandboxMessage =
  | Readonly<{ type: "ready"; workspace: string; home: string; toolchains: string }>
  | Readonly<{ type: "failed"; message: string }>
  | Readonly<{ type: "output"; id: string; data: string }>
  | Readonly<{ type: "ended"; id: string; outcome: RunOutcome; exitCode: number | null; refused: readonly string[] }>
  | Readonly<{ type: "stage"; id: string; description: string }>
  | Readonly<{ type: "prepared"; id: string; steps: readonly PreparationStep[]; error?: string | undefined }>
  | Readonly<{ type: "checked"; problems: readonly string[]; settings: readonly string[]; versions: string }>;

/** How the host's paths become this side's: WSL's own translation of Windows paths, or the same path on Linux. */
export type PathTranslation = "wsl" | "linux";

function translate(path: string, paths: PathTranslation): string {
  return paths === "wsl" ? execFileSync("wslpath", ["-a", "-u", path], { encoding: "utf8" }).trim() : resolve(path);
}

function tesotaState(): string {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "tesota");
}

const digest = (path: string): string => createHash("sha256").update(path).digest("hex").slice(0, 16);

/**
 * A workspace's own folders on WSL's disk: its home, temporary folder,
 * `node_modules`, setup record and the proxy's socket, and its package caches
 * and installed tools when no repository is named.
 */
function stateFolder(workspace: string): string {
  return join(tesotaState(), "sandboxes", digest(workspace));
}

/** A repository's key as the host sends it, a SHA-256 in hex, so it names one folder and nothing outside it. */
const REPOSITORY_KEY = /^[0-9a-f]{64}$/u;

/**
 * What one repository's sessions share on WSL's own disk, where Bun links
 * `node_modules` from the cache instead of copying each file through the
 * Windows drive: its package caches and the tools setup installed, so no other
 * repository's setup can change them.
 */
function repositoryFolder(repository: string): string {
  if (!REPOSITORY_KEY.test(repository)) throw new Error("A repository's key must be a SHA-256 in hexadecimal");
  return join(tesotaState(), "repositories", repository);
}

/** The folders a tool-folder stage printed that lie inside the repository's toolchain folder, in order, once each. */
export function installedToolFolders(output: string, toolchains: string): string[] {
  return [...new Set(output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => isAbsolute(line))
    .map((line) => normalize(line).replace(/(.)\/+$/u, "$1")).filter((folder) => folder !== toolchains && within(folder, toolchains)))];
}

const setupRecord = z.strictObject({ fingerprint: z.string(), toolFolders: z.array(z.string()) });

/** The setup that last succeeded in a workspace's sandbox, kept beside its home where no command sees it. */
async function recordedSetup(path: string): Promise<z.infer<typeof setupRecord> | undefined> {
  try {
    const parsed = setupRecord.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
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

/** A command to run in its own sandbox, from a folder relative to the workspace, in setup or for the agent. */
interface Execution {
  readonly command: string;
  /** Files hidden from the command, relative to the workspace with forward slashes. */
  readonly hidden?: readonly string[] | undefined;
  /** The folder, on this side, mounted at the workspace's path instead of the workspace. */
  readonly root?: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number | undefined;
  readonly phase: NetworkPhase;
}

interface Ended {
  readonly outcome: RunOutcome;
  readonly exitCode: number | null;
  readonly refused: readonly string[];
}

const OUTPUT_TAIL = 4 * 1024;
const TOOL_FOLDERS_OUTPUT = 64 * 1024;

interface ServerParts {
  readonly layout: SandboxLayout;
  /** How the host's paths appear here, for a folder the host asks to mount in the workspace's place. */
  readonly paths: PathTranslation;
  /** The `PATH` entries every command can reach, after the installed tools' folders. */
  readonly path: string;
  readonly bubblewrap: string;
  readonly proxy: EgressProxy;
  /** Where the setup that last succeeded is recorded, outside every command's sandbox. */
  readonly record: string;
  readonly send: (message: SandboxMessage) => void;
}

class SandboxServer {
  readonly #parts: ServerParts;
  readonly #running = new Map<string, Running>();
  /** Folders of the tools setup installed, first on `PATH` for every later command. */
  #toolFolders: readonly string[] = [];
  #settingUp = false;
  /** Why commands no longer run: setup could not confirm its destinations closed. */
  #unusable: string | undefined;
  #closing = false;

  constructor(parts: ServerParts) {
    this.#parts = parts;
  }

  async handle(message: HostMessage): Promise<void> {
    switch (message.type) {
      case "run": this.#run(message); return;
      case "stop": this.#running.get(message.id)?.stop("cancelled"); return;
      case "allow": await this.#parts.proxy.allow(message.destinations); return;
      case "setup": await this.#setup(message);
    }
  }

  #run(message: Extract<HostMessage, { type: "run" }>): void {
    const { id } = message;
    // The agent's commands never share setup's network or its writable toolchain folder.
    const ended: Promise<Ended> = this.#settingUp || this.#unusable !== undefined
      ? Promise.resolve({ outcome: "not_started", exitCode: null, refused: [] })
      : this.#execute(id, { ...message, phase: "agent",
        root: message.root === undefined ? undefined : translate(message.root, this.#parts.paths) }, (chunk) => {
        this.#parts.send({ type: "output", id, data: chunk.toString("base64") });
      });
    void ended.then((end) => { this.#parts.send({ type: "ended", id, ...end }); });
  }

  /**
   * Set up the environment unless its record shows this setup already
   * succeeded here: the stages run in order, stopping at the first that
   * fails, while the proxy also permits setup's destinations, which it
   * confirms closed afterwards. If it cannot, no command runs again. No
   * agent command starts until setup ends.
   */
  async #setup(message: Extract<HostMessage, { type: "setup" }>): Promise<void> {
    const reply = (steps: readonly PreparationStep[], error?: string): void => {
      this.#parts.send({ type: "prepared", id: message.id, steps, ...error === undefined ? {} : { error } });
    };
    if (this.#settingUp || this.#running.size > 0 || this.#unusable !== undefined) {
      reply([], "Setup runs only while no command runs");
      return;
    }
    this.#settingUp = true;
    try {
      const recorded = await recordedSetup(this.#parts.record);
      if (recorded?.fingerprint === message.fingerprint && recorded.toolFolders.every((folder) => existsSync(folder))) {
        this.#toolFolders = recorded.toolFolders;
        reply([]);
        return;
      }
      const steps = await this.#parts.proxy.during(message.destinations, () => this.#stages(message));
      if (steps.every((step) => step.outcome === "done")) {
        await writeFile(this.#parts.record, JSON.stringify({ fingerprint: message.fingerprint, toolFolders: this.#toolFolders }), "utf8")
          .catch(() => undefined);
      }
      reply(steps);
    } catch (error) {
      this.#unusable = error instanceof Error ? error.message : String(error);
      reply([], this.#unusable);
    } finally { this.#settingUp = false; }
  }

  async #stages(message: Extract<HostMessage, { type: "setup" }>): Promise<PreparationStep[]> {
    const steps: PreparationStep[] = [];
    for (const stage of message.stages) {
      if (this.#closing) break;
      this.#parts.send({ type: "stage", id: message.id, description: stage.description });
      let [tail, printed] = ["", ""];
      const end = await this.#execute(randomUUID(), { command: stage.script, cwd: ".", env: message.env,
        timeoutSeconds: message.timeoutSeconds, phase: "setup" }, (chunk, stream) => {
        const text = chunk.toString("utf8");
        tail = `${tail}${text}`.slice(-OUTPUT_TAIL);
        if (stream === "stdout" && stage.toolFolders === true) printed = `${printed}${text}`.slice(0, TOOL_FOLDERS_OUTPUT);
      });
      const done = end.outcome === "exited" && end.exitCode === 0;
      if (done && stage.toolFolders === true) this.#toolFolders = installedToolFolders(printed, this.#parts.layout.toolchains);
      const refused = end.refused.length === 0 ? [] : [`The network refused ${end.refused.join(", ")}.`];
      steps.push({ description: stage.description, outcome: done ? "done" : "failed",
        output: done ? "" : [tail.trimEnd(), ...refused].join("\n").slice(-OUTPUT_TAIL) });
      if (!done) break;
    }
    return steps;
  }

  async #execute(id: string, execution: Execution, output: (chunk: Buffer, stream: "stdout" | "stderr") => void): Promise<Ended> {
    const { layout, bubblewrap, proxy } = this.#parts;
    const cwd = resolve(layout.workspace, execution.cwd);
    if (!within(cwd, layout.workspace)) return { outcome: "not_started", exitCode: null, refused: [] };
    const mounted = execution.root ?? layout.workspace;
    if (execution.root !== undefined && layout.modules !== undefined) await mkdir(join(mounted, "node_modules"), { recursive: true });
    const guarded = await guardedPaths(mounted, execution.hidden ?? []);
    const started = new Date();
    const path = [...this.#toolFolders, this.#parts.path].filter((entry) => entry.length > 0).join(delimiter);
    const child = spawn(bubblewrap, bubblewrapArguments(layout, cwd, execution.command, execution.phase, guarded, mounted),
      { env: commandVariables(layout, path, execution.env), stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let info = "";
    child.stdio[3]?.on("data", (chunk: Buffer) => { info += chunk.toString("utf8"); });
    child.stdout?.on("data", (chunk: Buffer) => { output(chunk, "stdout"); });
    child.stderr?.on("data", (chunk: Buffer) => { output(chunk, "stderr"); });
    let stopping: "cancelled" | "timed_out" | undefined;
    const timer = execution.timeoutSeconds === undefined ? undefined
      : setTimeout(() => { running.stop("timed_out"); }, execution.timeoutSeconds * 1_000);
    let ended: (end: Ended) => void = () => undefined;
    const result = new Promise<Ended>((settle) => { ended = settle; });
    const done = new Promise<void>((settle) => {
      const finish = (outcome: RunOutcome, exitCode: number | null): void => {
        clearTimeout(timer);
        this.#running.delete(id);
        // The proxy records a refusal before its client sees it, so every refusal this command caused is in by now.
        void proxy.blockedSince(started).then((refused) => {
          ended({ outcome, exitCode, refused });
          settle();
        });
      };
      child.once("error", () => { finish("not_started", null); });
      child.once("close", (code, signal) => {
        if (stopping === undefined) { finish("exited", code ?? 128 + (signal === null ? 0 : constants.signals[signal])); return; }
        const pid = /"child-pid":\s*(\d+)/u.exec(info)?.[1];
        void sandboxGone(pid === undefined ? undefined : Number(pid)).then((gone) => { finish(gone ? stopping ?? "cancelled" : "unconfirmed", null); });
      });
    });
    const running: Running = { child, done, stop: (reason) => { if (stopping !== undefined) return; stopping = reason; child.kill("SIGKILL"); } };
    this.#running.set(id, running);
    return result;
  }

  /** Stop every command, setup's included, confirm each has ended, and close the proxy. */
  async close(): Promise<void> {
    this.#closing = true;
    const running = [...this.#running.values()];
    for (const command of running) command.stop("cancelled");
    await Promise.all(running.map((command) => command.done));
    await this.#parts.proxy.close();
  }
}

/** A program on `PATH`, outside any folder a repository controls. */
function locate(program: string): string | undefined {
  for (const folder of (process.env["PATH"] ?? "").split(delimiter).filter((entry) => isAbsolute(entry))) {
    const candidate = join(folder, program);
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
  /** The repository's key, whose sessions share its package caches and installed tools. */
  readonly repository?: string;
  readonly paths: PathTranslation;
}

/**
 * Prepare the workspace's sandbox, report it ready, then run what the host
 * asks until its input ends, when every command is stopped and the proxy
 * closed.
 */
export async function serve(options: ServeOptions, input: Readable, output: Writable): Promise<void> {
  const send = (message: SandboxMessage): void => { output.write(`${JSON.stringify(message)}\n`); };
  const bubblewrap = locate("bwrap");
  if (bubblewrap === undefined) { send({ type: "failed", message: "bubblewrap (bwrap) is not installed" }); return; }
  const workspace = translate(options.workspace, options.paths);
  const state = stateFolder(workspace);
  const shared = options.repository === undefined ? state : repositoryFolder(options.repository);
  const layout: SandboxLayout = { workspace, home: join(state, "home"), account: homedir(), temp: join(state, "tmp"),
    cache: join(shared, "cache"), toolchains: join(shared, "toolchains"),
    ...existsSync(join(workspace, "package.json")) ? { modules: join(state, "node_modules") } : {},
    relay: join(state, "relay.cjs"), socket: join(state, "proxy.sock"), mask: join(state, "hidden"), runtime: process.execPath,
    system: systemFolders(), tools: toolsOnThisMachine() };
  for (const folder of [layout.home, layout.temp, join(layout.cache, "npm"), join(layout.cache, "bun"), layout.toolchains, layout.modules]) {
    if (folder !== undefined) await mkdir(folder, { recursive: true });
  }
  // The mount point for the workspace's own node_modules, as Docker Sandboxes makes it.
  if (layout.modules !== undefined) await mkdir(join(workspace, "node_modules"), { recursive: true });
  await writeFile(layout.relay, RELAY_SOURCE, "utf8");
  // Read-only, so an earlier start left one that cannot be written again.
  await rm(layout.mask, { force: true });
  await writeFile(layout.mask, "", { mode: 0o400 });
  await rm(layout.socket, { force: true });
  const proxy = await EgressProxy.start({ allowed: PACKAGE_REGISTRY_HOSTS.map((host) => `${host}:443`), socket: layout.socket });
  const server = new SandboxServer({ layout, paths: options.paths, path: commandPath(process.env["PATH"] ?? "", layout.tools), bubblewrap, proxy,
    record: join(state, "setup.json"), send });
  send({ type: "ready", workspace, home: layout.account, toolchains: layout.toolchains });
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

/** Remove a repository's package caches and the tools setup installed for it. */
export async function releaseRepository(repository: string): Promise<void> {
  await rm(repositoryFolder(repository), { recursive: true, force: true });
}

/**
 * What stands between this machine and a working sandbox. Problems are what
 * setup fixes: bubblewrap missing or unable to create its namespaces, the
 * pinned mise missing, and in
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
  const bubblewrap = locate("bwrap");
  const version = bubblewrap === undefined ? "none" : spawnSync(bubblewrap, ["--version"], { encoding: "utf8" }).stdout.trim();
  if (bubblewrap === undefined) problems.push("bubblewrap (bwrap) is not installed");
  else {
    const system = systemFolders().flatMap((folder) => folder.link === undefined ? ["--ro-bind", folder.path, folder.path]
      : ["--symlink", folder.link, folder.path]);
    const trial = spawnSync(bubblewrap, ["--unshare-all", "--die-with-parent", ...system, "--", "/bin/sh", "-c", "true"],
      { encoding: "utf8", env: {} });
    if (trial.status !== 0) problems.push(`bubblewrap cannot create its namespaces here: ${trial.stderr.trim().slice(-300)}`);
  }
  // Setup installs a repository's tools with the pinned mise the distribution carries.
  const mise = locate("mise");
  const miseVersion = mise === undefined ? "" : spawnSync(mise, ["--version"],
    { encoding: "utf8", env: { ...process.env, MISE_HIDE_UPDATE_WARNING: "1" } }).stdout.trim().split(/\s+/u)[0] ?? "";
  if (`v${miseVersion}` !== MISE_RELEASE.version) problems.push(`mise ${MISE_RELEASE.version} is not installed`);
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
