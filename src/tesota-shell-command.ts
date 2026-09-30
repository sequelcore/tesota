import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { chooseSessionExecution, providersFor, readSandboxPreference, SANDBOX_NAMES, SANDBOX_PREFERENCES,
  type SandboxPreference, type SessionExecution } from "./execution-providers.js";
import { pendingUsage, readUsage, type RouteUsage } from "./account-usage.js";
import { allRoutes, routeStatuses, usedByRoute } from "./auth.js";
import { usageSources } from "./integrations/usage-sources.js";
import type { AccountsSource } from "./tesota-shell-accounts.js";
import { BackdropTui, FocusReportingTerminal } from "./tesota-shell-tui.js";
import { accountRoute, MODEL_ROLES, readAddedRoutes, readModelChoices } from "./model-roles.js";
import { modelCost, rolePicker, runRolesCommand } from "./models-command.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { openShellSessionStore, type ShellSessionRecord, type ShellSessionStore } from "./shell-session-store.js";
import { askingDecisions, type SessionDecisions } from "./session-decisions.js";
import { type AgentModelCommands, createSessionEngine, isAbort, type SessionSandboxCommands, sessionAgentModel,
  type SessionWork, type TurnCommands } from "./session-engine.js";
import { runTesotaShell } from "./tesota-shell.js";
import { cleanTitle } from "./session-title.js";
import { CONFIRMATION_WINDOW_MS, createTesotaShellTerminal, SessionBlockedError, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import type { TesotaShellThemeName } from "./tesota-shell-theme.js";

/** How the process shell tells the session runner about workspace-level events. */
export interface WorkspaceCallbacks {
  readonly newSession: (id: string) => void;
  readonly selectSession: (id: string) => void;
  /** The session was closed; its runner must stop without writing to it. */
  readonly closed: (id: string) => void;
  readonly quit: () => void;
}

export interface TesotaShellCommandDependencies {
  readonly surface: TesotaShellTerminal;
  readonly session: (id: string) => SessionWork;
  /** Release every session's environment; the process exits only after it settles. */
  readonly dispose?: () => Promise<void> | void;
  readonly abortActive?: () => void;
  readonly initialSessionId?: string;
  readonly blockedSessionIds?: readonly string[];
  readonly configureWorkspace: (callbacks: WorkspaceCallbacks) => void;
  /** The agent's model in a session: `/model` and `/handoff` (decision 026). */
  readonly agentModel?: AgentModelCommands;
  /** Where a session's commands run: `/sandbox` (decision 030). */
  readonly sessionSandbox?: SessionSandboxCommands;
  /** A session's turns in the operator's files: `/keep`, `/revert` and `/redo`, or none of them after `/isolate`. */
  readonly turnCommands?: TurnCommands;
}

function closeWarning(record: ShellSessionRecord, pending: number): string {
  if (record.blocked) {
    return "This session stopped with unresolved effects. Press Ctrl+W again to close it; " +
      `its workspace stays at ${record.workspace ?? "(none)"}.`;
  }
  const noun = pending === 1 ? "change" : "changes";
  // A session working in the operator's files leaves its changes there when it closes; only reverting them ends.
  if (record.workspace !== null && existsSync(join(record.workspace, "session.json"))) {
    return `This session's latest turn has ${pending} undecided ${noun} in your files. Press Ctrl+W again to close it; ` +
      `${pending === 1 ? "it stays" : "they stay"} in your files and can no longer be reverted from Tesota.`;
  }
  return `This session has ${pending} unapplied ${noun}. Press Ctrl+W again to close it and discard ${pending === 1 ? "it" : "them"}.`;
}

/** A session's decisions in the shell: the operator answers each at that session's prompt. */
function shellDecisions(surface: TesotaShellTerminal, id: string): SessionDecisions {
  return askingDecisions((prompt) => surface.askIn(id, prompt), (text, tone) => { surface.writeTo(id, text, tone); });
}

/**
 * The Accounts panel's content (decision 051): every route's usage, the
 * saved readings at once and each fresh one as it arrives; the routes'
 * sign-ins; and the route whose account each role draws on.
 */
function accountsSource(): AccountsSource {
  return {
    readUsage: async (update) => {
      const routes = allRoutes();
      let usage: RouteUsage[] = pendingUsage(routes);
      update(usage);
      await readUsage(routes, usageSources(), { onEach: (one) => {
        usage = usage.map((entry) => entry.route === one.route ? one : entry);
        update(usage);
      } });
    },
    readSignIns: async () => ({ rows: await routeStatuses(allRoutes().map((entry) => entry.route)), usedBy: usedByRoute() }),
    roles: () => {
      const choices = readModelChoices();
      const added = readAddedRoutes();
      return MODEL_ROLES.map((role) => {
        const route = accountRoute(choices[role], added);
        return { role, choice: choices[role], ...route === undefined ? {} : { route } };
      });
    },
  };
}

export function createProcessTesotaShell(cwd: string = process.cwd(),
  theme: TesotaShellThemeName = "tesota-dark",
  chooseExecution: (preference: SandboxPreference) => Promise<SessionExecution> =
    (preference) => chooseSessionExecution(providersFor(preference)),
  resumeSessionId?: string): TesotaShellCommandDependencies {
  const store: ShellSessionStore = openShellSessionStore(cwd);
  const savedSessions = store.list();
  const resumed = resumeSessionId === undefined ? undefined : savedSessions.find((session) => session.id === resumeSessionId);
  if (resumeSessionId !== undefined && resumed === undefined) {
    store.close();
    throw new Error(`Session ${resumeSessionId} was not found in this workspace.`);
  }
  const initial = resumed ?? store.create();
  const freshSessions = new Set(resumed === undefined ? [initial.id] : []);
  const firstDisplayed = savedSessions[0] ?? initial;
  let workspaceCallbacks: WorkspaceCallbacks | undefined;
  const saved = (id: string): ShellSessionRecord | undefined => store.list().find((session) => session.id === id);
  const showAgentModel = (id: string): void => {
    try { surface.setSessionModel(id, sessionAgentModel(store, id)); } catch { /* the agent reports an unreadable choice when it opens */ }
  };
  const terminal = new FocusReportingTerminal(new ProcessTerminal());
  const tui = new BackdropTui(terminal, false, undefined, { mouse: true });
  // Focus reports arrive only once the TUI has started, after the surface below exists.
  terminal.onFocusChange((focused) => { surface.setTerminalFocused(focused); });
  const surface = createTesotaShellTerminal({ cwd, tui, interrupt: (id) => { engine.interrupt(id); }, theme,
    initialSession: { ...firstDisplayed, fresh: freshSessions.has(firstDisplayed.id) },
    onEntry: (id, entry) => { store.append(id, entry); },
    onInspection: (id, inspection) => { store.inspect(id, inspection); },
    onNewSession: () => {
      const session = store.create();
      freshSessions.add(session.id);
      surface.addSession(session.id, session.title);
      showAgentModel(session.id);
      surface.selectSession(session.id);
      workspaceCallbacks?.newSession(session.id);
    },
    onCloseSession: (id) => { void closeSession(id); },
    onModel: (id, argument) => { void engine.agentModel.change(id, argument); },
    onHandoff: (id) => { void engine.agentModel.handOff(id); },
    onSandbox: (id, argument) => { void engine.sessionSandbox.change(id, argument); },
    accounts: accountsSource(),
    sandboxPicker: (id) => {
      const own = saved(id)?.sandbox;
      const preference = readSandboxPreference();
      const current = own ?? preference;
      return { title: `Sandbox: ${own === undefined ? `default (${current})` : current}`, entries: [
        { value: "default", label: "default", detail: `Follow the choice for new sessions (${preference})` },
        ...SANDBOX_PREFERENCES.map((value) => ({ value, label: value,
          detail: `${value === current ? "Current · " : ""}${value === "auto" ? "WSL, then Docker, then this computer" :
            value === "host" ? "This computer; asks before commands" :
              `${Object.values(SANDBOX_NAMES).find((entry) => entry.choice === value)?.described ?? value}; availability checked on selection`}` })),
      ] };
    },
    onRoleModel: (id, args) => {
      let text = "";
      const code = runRolesCommand(args, (written) => { text += written; }, engine.offered());
      // The agent's role sets the model new sessions start with; `/model` switches a running session's.
      const agent = code === 0 && args[0] === "agent" ? "New sessions start with it; /model switches this one's.\n" : "";
      surface.replyTo(id, `${text}${agent}`.trimEnd(), code === 0 ? "success" : "warning");
    },
    onKeep: (id) => { void engine.turnCommands.keep(id); },
    onRevert: (id, args) => { void engine.turnCommands.revert(id, args); },
    onRedo: (id) => { void engine.turnCommands.redo(id); },
    onIsolate: (id) => { void engine.turnCommands.isolate(id); },
    onChecks: (id, args) => { engine.showChecks(id, args); },
    onRename: (id, name) => {
      if (name === undefined) {
        // As Codex's /rename suggests one: a title from the session's latest requests.
        const requests = (store.list().find((session) => session.id === id)?.entries ?? [])
          .flatMap((entry) => entry.kind === "user" && !entry.text.startsWith("/") ? [entry.text] : []).slice(-8);
        if (requests.length === 0) { surface.replyTo(id, "Nothing to name yet. Use /rename <name>.", "warning"); return; }
        surface.replyTo(id, "Naming the session from its requests.");
        engine.name(id, requests, "operator");
        return;
      }
      const title = cleanTitle(name);
      try {
        if (title !== undefined && store.setTitle(id, title, "operator")) surface.setSessionTitle(id, title);
        else surface.replyTo(id, "Use /rename <name>, with some text.", "warning");
      } catch { surface.replyTo(id, "The name could not be saved.", "warning"); }
    },
    modelPicker: (id, prefix) => {
      try {
        if (prefix !== "/model ") return rolePicker(prefix, engine.offered());
        const context = engine.contextTokens(id);
        return { current: sessionAgentModel(store, id), ...(context === undefined ? {} : { contextTokens: context }), entries: engine.offered().map((model) => ({ id: model.id, detail: modelCost(model),
          reasoning: model.reasoning })) };
      } catch { return undefined; }
    },
    onSessionChange: (id) => { workspaceCallbacks?.selectSession(id); },
    onQuit: () => { workspaceCallbacks?.quit(); } });
  for (const session of savedSessions.slice(1)) surface.addSession(session.id, session.title,
    session.entries, session.inspections, false);
  if (resumed === undefined && savedSessions.length > 0) surface.addSession(initial.id, initial.title);
  surface.selectSession(initial.id);
  if (resumed === undefined) showAgentModel(initial.id);
  for (const session of savedSessions) {
    showAgentModel(session.id);
    if (session.plan !== undefined) surface.setSessionPlan(session.id, session.plan);
  }
  const engine = createSessionEngine({ cwd, store, output: surface, decisions: (id) => shellDecisions(surface, id),
    chooseExecution, fresh: freshSessions });
  /**
   * Close a session: its record, agent transcript and workspace are removed. A
   * session holding unapplied changes or unresolved effects needs a second
   * Ctrl+W; one with unresolved effects keeps its workspace as evidence.
   */
  const closeWarnings = new Map<string, number>();
  /** True when this close request must wait for a second Ctrl+W, after warning once. */
  const awaitingConfirmation = (id: string, record: ShellSessionRecord, pending: number): boolean => {
    if (pending === 0 && !record.blocked) return false;
    const warnedAt = closeWarnings.get(id);
    if (warnedAt !== undefined && Date.now() - warnedAt <= CONFIRMATION_WINDOW_MS) {
      closeWarnings.delete(id);
      return false;
    }
    closeWarnings.set(id, Date.now());
    surface.replyTo(id, closeWarning(record, pending));
    return true;
  };

  const closeSession = async (id: string): Promise<void> => {
    const record = saved(id);
    if (record === undefined) return;
    if (engine.busy(id)) {
      surface.replyTo(id, "Stop the current work with Ctrl+C before closing this session.");
      return;
    }
    if (awaitingConfirmation(id, record, await engine.pendingChanges(id))) return;
    if (store.list().length === 1) {
      const replacement = store.create();
      freshSessions.add(replacement.id);
      surface.addSession(replacement.id, replacement.title);
      showAgentModel(replacement.id);
      workspaceCallbacks?.newSession(replacement.id);
    }
    workspaceCallbacks?.closed(id);
    surface.removeSession(id);
    await engine.discard(id, record);
  };

  return {
    surface,
    session: engine.session,
    initialSessionId: initial.id,
    blockedSessionIds: savedSessions.filter((session) => session.blocked).map((session) => session.id),
    configureWorkspace: (callbacks) => { workspaceCallbacks = callbacks; },
    agentModel: engine.agentModel,
    sessionSandbox: engine.sessionSandbox,
    turnCommands: engine.turnCommands,
    abortActive: engine.abortActive,
    dispose: async () => {
      await engine.dispose();
      for (const id of freshSessions) {
        const session = saved(id);
        if (session !== undefined && session.workspace === null && !session.blocked && session.plan === undefined &&
          session.titleSource !== "operator" && !session.entries.some((entry) => entry.kind === "user")) store.remove(id);
      }
      store.close();
    },
  };
}

export async function runTesotaShellCommand(
  dependencies: TesotaShellCommandDependencies = createProcessTesotaShell(),
): Promise<number> {
  const { surface } = dependencies;
  surface.start();
  try {
    const running = new Set<Promise<void>>();
    let resolveQuit: (() => void) | undefined;
    const quit = new Promise<void>((resolveQuitPromise) => { resolveQuit = resolveQuitPromise; });
    const started = new Set<string>();
    const ended = new Set<string>();
    const closed = new Set<string>();
    let closing = false;
    const runSession = (id: string): void => {
      if (dependencies.blockedSessionIds?.includes(id) || ended.has(id) || started.has(id)) return;
      started.add(id);
      const operation = runTesotaShell({
        ...dependencies.session(id),
        decisions: shellDecisions(surface, id),
        write: (text, tone) => { surface.writeTo(id, text, tone); },
        report: (progress: TesotaShellProgress) => { surface.reportFor(id, progress); },
      }).then(() => {
        ended.add(id);
        if (!closed.has(id)) surface.endSession(id);
      }, (error: unknown) => {
        if (closed.has(id) || closing && isAbort(error)) return;
        ended.add(id);
        // A blocked session already said why and what to run; it only ends.
        if (error instanceof SessionBlockedError) { surface.endSession(id); return; }
        try {
          surface.writeTo(id, isAbort(error) ? "Session cancelled.\n" : "Session failed. Pending changes stay where the session left them.\n");
        } finally { surface.endSession(id); }
      });
      running.add(operation);
      void operation.finally(() => { running.delete(operation); started.delete(id); });
    };
    dependencies.configureWorkspace({
      newSession: (id) => { runSession(id); },
      selectSession: (id) => { runSession(id); },
      closed: (id) => { closed.add(id); ended.add(id); },
      quit: () => { resolveQuit?.(); },
    });
    runSession(dependencies.initialSessionId ?? "default");
    await quit;
    closing = true;
    dependencies.abortActive?.();
    surface.stop();
    await Promise.all(running);
    return 0;
  } catch (error) {
    surface.write(isAbort(error) ? "Tesota session cancelled.\n" : "Tesota session failed.\n");
    return isAbort(error) ? 130 : 1;
  } finally {
    // The caller exits the process on return, which would abandon a release still under way.
    await dependencies.dispose?.();
    surface.stop();
  }
}
