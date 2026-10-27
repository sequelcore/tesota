import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import type { FooterData, MessageRenderer, ShellAPI, ShellUI, ToolDrawing, WorkingDetail } from "../../../../src/contract.ts";
import type { HostParts } from "../../../../src/host.ts";
import manifest from "../../package.json" with { type: "json" };
import { platformShell } from "../tools/shell.ts";
import { withLockWhile } from "../session-lock.ts";
import { readSettings } from "../settings.ts";
import type { ShellTheme } from "../../../../src/theme.ts";

export type { MessageRenderer, ToolDrawing } from "../../../../src/contract.ts";

/** The key that expands a tool's output or a message, as the shell binds it. */
export const expandKey = "ctrl+o";

/**
 * What an extension draws through the shell (#446), kept until the shell
 * mounts it: its header, footer, editor and working indicator, its status
 * texts, how its messages and tool calls are drawn, and the theme. The
 * session's extensions set it as they start, before the shell has drawn
 * anything, so it is made first and the shell follows its changes.
 */
export interface Surface {
  /** `ctx.ui`, as the session's handlers see it. */
  readonly ui: ShellUI;
  readonly registerMessageRenderer: ShellAPI["registerMessageRenderer"];
  /** Records how an extension's tool is drawn, when it says. */
  readonly toolRegistered: (tool: object) => void;
  readonly theme: ShellTheme;
  header: Parameters<ShellUI["setHeader"]>[0];
  footer: Parameters<ShellUI["setFooter"]>[0];
  editor: Parameters<ShellUI["setEditorComponent"]>[0];
  indicator: { frames?: string[]; intervalMs?: number } | undefined;
  /** What the label says while the gate verifies (#590). */
  detail: WorkingDetail | undefined;
  readonly statuses: Map<string, string>;
  readonly renderers: Map<string, MessageRenderer>;
  readonly tools: Map<string, ToolDrawing>;
  /** Tells `listener` when any of these changes. */
  onChange(listener: () => void): () => void;
}

export function createSurface(theme: ShellTheme): Surface {
  const listeners = new Set<() => void>();
  const changed = (): void => { for (const listener of listeners) listener(); };
  const surface: Surface = {
    ui: {
      setHeader: (factory) => { surface.header = factory; changed(); },
      setFooter: (factory) => { surface.footer = factory; changed(); },
      setEditorComponent: (factory) => { surface.editor = factory; changed(); },
      setWorkingIndicator: (options) => { surface.indicator = options; changed(); },
      setWorkingDetail: (detail) => { surface.detail = detail; changed(); },
      setStatus: (key, text) => {
        if (text === undefined) surface.statuses.delete(key);
        else surface.statuses.set(key, text);
        changed();
      },
      get theme() { return theme; },
    },
    registerMessageRenderer: (customType, renderer) => {
      surface.renderers.set(customType, renderer);
      changed();
    },
    toolRegistered: (tool) => {
      const { name, renderCall, renderResult } = tool as ToolDrawing & { name: string };
      if (renderCall !== undefined || renderResult !== undefined) {
        surface.tools.set(name, { ...renderCall === undefined ? {} : { renderCall }, ...renderResult === undefined ? {} : { renderResult } });
      }
    },
    theme,
    header: undefined, footer: undefined, editor: undefined, indicator: undefined, detail: undefined,
    statuses: new Map(), renderers: new Map(), tools: new Map(),
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return surface;
}

/** The `.git` folder or file of the repository `cwd` is in, if any. */
function gitDirOf(cwd: string): string | undefined {
  for (let at = cwd; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return join(at, ".git");
    if (dirname(at) === at) return undefined;
  }
}

/** The branch Git's `HEAD` names, `detached` when it names a commit, or none outside a repository. */
function branchOf(gitDir: string | undefined): string | null {
  if (gitDir === undefined) return null;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "detached";
  } catch { return null; }
}

/**
 * What the footer reads besides the session (#446): the current Git branch,
 * followed as `HEAD` changes, the extensions' status texts, and how many
 * providers are logged in.
 */
export function footerData(cwd: () => string, statuses: () => ReadonlyMap<string, string>, providers: () => number): FooterData {
  // The shown session's folder, which changes when the shell shows another session: its worktree's branch, not the checkout's (#453).
  return {
    getGitBranch: () => branchOf(gitDirOf(cwd())),
    getExtensionStatuses: statuses,
    getAvailableProviderCount: providers,
    onBranchChange: (callback) => {
      const gitDir = gitDirOf(cwd());
      if (gitDir === undefined || !existsSync(join(gitDir, "HEAD"))) return () => undefined;
      try {
        const watcher = watch(join(gitDir, "HEAD"), () => { callback(); });
        return () => { watcher.close(); };
      } catch { return () => undefined; }
    },
  };
}

/** Key names for the actions Tesota names, as the shell binds them. */
const keys: Readonly<Record<string, string>> = { "app.tools.expand": expandKey };

/**
 * Git for Windows' bash, in the installation of the `git` on the PATH,
 * which may be `…\Git\cmd\git.exe`, or `…\Git\mingw64\bin\git.exe`
 * from Git's own bash: never a `bash` found on the PATH alone, which on
 * Windows may be WSL's.
 */
function gitBash(): string | undefined {
  const git = Bun.which("git");
  if (git === null) return undefined;
  const installs = [dirname(dirname(git)), dirname(dirname(dirname(git)))];
  return installs.flatMap((install) => [join(install, "bin", "bash.exe"), join(install, "usr", "bin", "bash.exe")]).find(existsSync);
}

/**
 * What the engine gives Tesota (#446): its key names, version, and the
 * shell the project's checks run in, and its asynchronous OS lock. Checks
 * are written for a POSIX shell (`inFolder`), so on Windows they run in
 * Git's bash, as Pi and Claude Code run commands there (#463); the agent's
 * own shell stays the platform's. Without Git's bash, the platform's shell
 * runs them.
 */
export function shellHost(settingsPath?: string): HostParts {
  return {
    keyText: (action) => keys[action] ?? action,
    version: manifest.version,
    verificationModels: () => readSettings(settingsPath).settings,
    withLockWhile,
    shellConfig: () => {
      const bash = process.platform === "win32" ? gitBash() : undefined;
      if (bash !== undefined) return { shell: bash, args: ["-c"] };
      const shell = platformShell();
      return { shell: shell.executable, args: shell.args("").slice(0, -1) };
    },
  };
}
