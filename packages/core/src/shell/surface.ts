import type {
  ExtensionAPI as PiExtensionAPI, ReadonlyFooterDataProvider, Theme as PiTheme, ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import type { ShellAPI, ShellUI } from "../../../../src/contract.ts";
import type { HostParts } from "../../../../src/host.ts";
import manifest from "../../package.json" with { type: "json" };
import { platformShell } from "../tools/shell.ts";
import type { ShellTheme } from "./theme.ts";

type Factories = Parameters<ShellUI["setHeader"]>[0] | Parameters<ShellUI["setFooter"]>[0] | Parameters<ShellUI["setEditorComponent"]>[0];

/** How the shell draws a message an extension added, and a call to an extension's tool. */
export type MessageRenderer = Parameters<PiExtensionAPI["registerMessageRenderer"]>[1];
export type ToolDrawing = Pick<PiToolDefinition, "renderCall" | "renderResult">;

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
      setHeader: (factory: Factories) => { surface.header = factory as Surface["header"]; changed(); },
      setFooter: (factory: Factories) => { surface.footer = factory as Surface["footer"]; changed(); },
      setEditorComponent: (factory: Factories) => { surface.editor = factory as Surface["editor"]; changed(); },
      setWorkingIndicator: (options) => { surface.indicator = options; changed(); },
      setStatus: (key, text) => {
        if (text === undefined) surface.statuses.delete(key);
        else surface.statuses.set(key, text);
        changed();
      },
      // Tesota's interface reads the shell's theme as Pi's: the members it uses are checked in `theme.test.ts`.
      get theme() { return theme as unknown as PiTheme; },
    } as ShellUI,
    registerMessageRenderer: ((customType: string, renderer: MessageRenderer) => {
      surface.renderers.set(customType, renderer);
      changed();
    }) as ShellAPI["registerMessageRenderer"],
    toolRegistered: (tool) => {
      const { name, renderCall, renderResult } = tool as ToolDrawing & { name: string };
      if (renderCall !== undefined || renderResult !== undefined) {
        surface.tools.set(name, { ...renderCall === undefined ? {} : { renderCall }, ...renderResult === undefined ? {} : { renderResult } });
      }
    },
    theme,
    header: undefined, footer: undefined, editor: undefined, indicator: undefined,
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
 * What the footer reads besides the session (#446), as Pi's footer data:
 * the current Git branch, followed as `HEAD` changes, the extensions'
 * status texts, and how many providers are logged in.
 */
export function footerData(cwd: () => string, statuses: () => ReadonlyMap<string, string>, providers: () => number): ReadonlyFooterDataProvider {
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

/** pi-tui's editor, made as Pi's editor is, from a keybindings manager the shell's own keys need not. */
class ShellEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme, _keybindings: never, options?: { paddingX?: number }) {
    super(tui, theme, options);
  }
}

/** Key names for the actions Tesota names, as the shell binds them. */
const keys: Readonly<Record<string, string>> = { "app.tools.expand": expandKey };

/** What the engine's shell gives Tesota in place of Pi's editor, key names, version and shell (#446). */
export function shellHost(): HostParts {
  return {
    EditorBase: ShellEditor,
    keyText: (action) => keys[action] ?? action,
    version: `@tesota/core ${manifest.version}`,
    shellConfig: () => {
      const shell = platformShell();
      return { shell: shell.executable, args: shell.args("").slice(0, -1) };
    },
  };
}
