import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import type { ExecutionEnvironment, ExecutionProvider } from "./execution-environment.js";
import { hostProvider } from "./host-environment.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { CodingSession, type CommandApproval } from "./integrations/pi-coding-session.js";
import { LIVE_CODEX_MODEL_ID } from "./integrations/pi-live.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { openShellSessionStore, type ShellSessionRecord, type ShellSessionStore } from "./shell-session-store.js";
import { runTesotaShell, type ApplyResult, type ReviewResult, type TesotaShellDependencies,
  type WorkResult } from "./tesota-shell.js";
import { inspectReview } from "./tesota-shell-inspection.js";
import { createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import type { TesotaShellThemeName } from "./tesota-shell-theme.js";
import { UnsupportedSourceChange } from "./source-snapshot.js";
import { Workspace, type WorkspaceSnapshot, type WorkspaceUpdate } from "./workspace.js";
import { applyWorkspace, ApplyConflictError, ApplyUncertainError } from "./workspace-apply.js";
import { runChecks, suggestChecks } from "./workspace-checks.js";

export type SessionWork = Omit<TesotaShellDependencies, "write" | "ask" | "report">;

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
  readonly dispose?: () => void;
  readonly abortActive?: () => void;
  readonly initialSessionId?: string;
  readonly blockedSessionIds?: readonly string[];
  readonly configureWorkspace: (callbacks: WorkspaceCallbacks) => void;
}

/** A second Ctrl+W within this time confirms closing a session that holds work. */
const closeConfirmationMs = 5_000;

function closeWarning(record: ShellSessionRecord, pending: number): string {
  if (record.blocked) {
    return "This session stopped with unresolved effects. Press Ctrl+W again to close it; " +
      `its workspace stays at ${record.workspace ?? "(none)"}.`;
  }
  const noun = pending === 1 ? "change" : "changes";
  return `This session has ${pending} unapplied ${noun}. Press Ctrl+W again to close it and discard ${pending === 1 ? "it" : "them"}.`;
}

function parseApproval(answer: string): CommandApproval {
  const value = answer.trim().toLowerCase();
  if (value === "y" || value === "yes") return "once";
  if (value === "a" || value === "always") return "always";
  return "deny";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** One shell session's workspace, agent conversation and pending review. */
class SessionState {
  workspace: Promise<Workspace> | undefined;
  environment: Promise<ExecutionEnvironment> | undefined;
  coding: Promise<CodingSession> | undefined;
  reviewed: WorkspaceSnapshot | undefined;
  /** Context the agent needs with the next request, such as a rejected change. */
  note: string | undefined;
}

export function createProcessTesotaShell(cwd: string = process.cwd(),
  theme: TesotaShellThemeName = "tesota-dark",
  provider: ExecutionProvider = hostProvider): TesotaShellCommandDependencies {
  const activeOperations = new Map<string, AbortController>();
  const states = new Map<string, SessionState>();
  const waiters: { readonly signal: AbortSignal; readonly grant: () => void;
    readonly reject: (error: Error) => void }[] = [];
  let slotsUsed = 0;
  const releaseSlot = (): void => {
    slotsUsed -= 1;
    const next = waiters.shift();
    if (next !== undefined) { slotsUsed += 1; next.grant(); }
  };
  const acquireSlot = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(new DOMException("cancelled", "AbortError"));
    if (slotsUsed < 2) { slotsUsed += 1; return Promise.resolve(); }
    return new Promise<void>((resolveSlot, reject) => {
      const waiter = { signal, grant: () => { signal.removeEventListener("abort", abort); resolveSlot(); },
        reject: (error: Error) => { signal.removeEventListener("abort", abort); reject(error); } };
      const abort = (): void => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        waiter.reject(new DOMException("cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      waiters.push(waiter);
    });
  };
  let applicationQueue: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = applicationQueue.then(operation);
    applicationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const store: ShellSessionStore = openShellSessionStore(cwd);
  const savedSessions = store.list();
  const initial = savedSessions[0] ?? store.create();
  let workspaceCallbacks: WorkspaceCallbacks | undefined;
  const piSessionsDirectory = join(homedir(), ".tesota", "pi-sessions",
    createHash("sha256").update(resolve(cwd).toLocaleLowerCase("en-US")).digest("hex"));
  const closeWarnings = new Map<string, number>();
  /** Sessions writing to the source repository; they cannot be closed until it settles. */
  const applying = new Set<string>();
  const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
  const interrupt = (sessionId: string): void => { activeOperations.get(sessionId)?.abort(); };
  const runOperation = async <T>(sessionId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (activeOperations.has(sessionId)) throw new Error("Tesota Shell session operation already active");
    const cancellation = new AbortController();
    store.markActive(sessionId, true);
    activeOperations.set(sessionId, cancellation);
    let acquired = false;
    try {
      await acquireSlot(cancellation.signal);
      acquired = true;
      return await operation(cancellation.signal);
    } finally {
      if (acquired) releaseSlot();
      if (activeOperations.get(sessionId) === cancellation) activeOperations.delete(sessionId);
      store.markActive(sessionId, false);
    }
  };
  const surface = createTesotaShellTerminal({ cwd, tui, interrupt, theme,
    initialSession: initial, onEntry: (id, role, text) => { store.append(id, role, text); },
    onInspection: (id, inspection) => { store.inspect(id, inspection); },
    onNewSession: () => {
      const session = store.create();
      surface.addSession(session.id, session.title);
      surface.selectSession(session.id);
      workspaceCallbacks?.newSession(session.id);
    },
    onCloseSession: (id) => { void closeSession(id); },
    onSessionChange: (id) => { workspaceCallbacks?.selectSession(id); },
    onQuit: () => { workspaceCallbacks?.quit(); } });
  for (const session of savedSessions.slice(1)) surface.addSession(session.id, session.title,
    session.entries, session.inspections);
  for (const session of savedSessions) {
    if (session.interrupted) {
      surface.writeTo(session.id, "The previous shell stopped during work. Pending changes stay in the workspace.");
      store.markActive(session.id, false);
    }
    if (session.blocked) {
      surface.blockSession(session.id);
      surface.writeTo(session.id, "This session stopped with unresolved effects. Check your repository and start a new session.");
    }
  }
  const saved = (id: string): ReturnType<ShellSessionStore["list"]>[number] | undefined =>
    store.list().find((session) => session.id === id);
  const stateFor = (id: string): SessionState => {
    let state = states.get(id);
    if (state === undefined) { state = new SessionState(); states.set(id, state); }
    return state;
  };
  const workspaceFor = (id: string): Promise<Workspace> => {
    const state = stateFor(id);
    state.workspace ??= (async () => {
      const directory = saved(id)?.workspace;
      if (directory !== null && directory !== undefined) {
        try { return await Workspace.open(directory); } catch { store.rotateEngine(id); }
      }
      const workspace = await Workspace.create(cwd);
      store.setWorkspace(id, workspace.directory);
      if (workspace.included.length > 0) {
        surface.writeTo(id, `The workspace includes your ${workspace.included.length} uncommitted ` +
          `${workspace.included.length === 1 ? "change" : "changes"}. Later edits in your repository are not visible to the agent.`);
      }
      return workspace;
    })();
    state.workspace.catch(() => { state.workspace = undefined; });
    return state.workspace;
  };
  const environmentFor = (id: string): Promise<ExecutionEnvironment> => {
    const state = stateFor(id);
    state.environment ??= workspaceFor(id).then((workspace) => provider.prepare(workspace.checkout));
    state.environment.catch(() => { state.environment = undefined; });
    return state.environment;
  };
  const codingFor = (id: string, signal: AbortSignal): Promise<CodingSession> => {
    const state = stateFor(id);
    state.coding ??= (async () => {
      const workspace = await workspaceFor(id);
      const environment = await environmentFor(id);
      const runtime = await ModelRuntime.create({ credentials: new CodexCredentials(), refreshOnCreate: false,
        allowModelNetwork: false, signal });
      const model = runtime.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model === undefined) throw new Error("The Codex model is unavailable. Run tesota auth login.");
      const engineId = saved(id)?.engineId ?? store.rotateEngine(id);
      const existing = SessionManager.findById(workspace.checkout, engineId, piSessionsDirectory);
      const sessionManager = existing === undefined
        ? SessionManager.create(workspace.checkout, piSessionsDirectory, { id: engineId })
        : SessionManager.open(existing, piSessionsDirectory, workspace.checkout);
      return CodingSession.create({ cwd: workspace.checkout, modelRuntime: runtime, model, sessionManager, environment,
        approveCommand: async (command) => {
          surface.reportFor(id, { phase: "awaiting_command" });
          const answer = await surface.askIn(id, `Run \`${command}\`? [y]es, [a]lways this session, [n]o: `);
          surface.reportFor(id, { phase: "working" });
          return parseApproval(answer);
        },
        onActivity: (activity) => { surface.reportFor(id, { phase: "working", activity }); } });
    })();
    state.coding.catch(() => { state.coding = undefined; });
    return state.coding;
  };
  const blockSession = (id: string): void => { store.block(id); surface.blockSession(id); };

  /** Pending changes in a session's existing workspace; never creates one. */
  const pendingChangeCount = async (id: string): Promise<number> => {
    const directory = saved(id)?.workspace;
    const loaded = states.get(id)?.workspace;
    if (loaded === undefined && (directory === null || directory === undefined)) return 0;
    try { return (await (loaded ?? Workspace.open(directory ?? ""))).snapshot().changes.length; }
    catch { return 0; }
  };

  /** True when this close request must wait for a second Ctrl+W, after warning once. */
  const awaitingConfirmation = (id: string, record: ShellSessionRecord, pending: number): boolean => {
    if (pending === 0 && !record.blocked) return false;
    const warnedAt = closeWarnings.get(id);
    if (warnedAt !== undefined && Date.now() - warnedAt <= closeConfirmationMs) {
      closeWarnings.delete(id);
      return false;
    }
    closeWarnings.set(id, Date.now());
    surface.writeTo(id, closeWarning(record, pending));
    return true;
  };

  /** Remove a closed session's engine, transcript, workspace and record. */
  const discardSession = async (id: string, record: ShellSessionRecord): Promise<void> => {
    const state = states.get(id);
    states.delete(id);
    await state?.coding?.then((coding) => { coding.dispose(); }, () => undefined);
    await state?.environment?.then((environment) => environment.dispose(), () => undefined);
    if (record.workspace !== null) {
      const transcript = SessionManager.findById(join(record.workspace, "repo"), record.engineId, piSessionsDirectory);
      if (transcript !== undefined) await rm(transcript, { force: true });
      if (!record.blocked) await rm(record.workspace, { recursive: true, force: true, maxRetries: 3 });
    }
    store.remove(id);
  };

  /**
   * Close a session: its record, agent transcript and workspace are removed. A
   * session holding unapplied changes or unresolved effects needs a second
   * Ctrl+W; one with unresolved effects keeps its workspace as evidence.
   */
  const closeSession = async (id: string): Promise<void> => {
    const record = saved(id);
    if (record === undefined) return;
    if (activeOperations.has(id) || applying.has(id)) {
      surface.writeTo(id, "Stop the current work with Ctrl+C before closing this session.");
      return;
    }
    if (awaitingConfirmation(id, record, await pendingChangeCount(id))) return;
    if (store.list().length === 1) {
      const replacement = store.create();
      surface.addSession(replacement.id, replacement.title);
      workspaceCallbacks?.newSession(replacement.id);
    }
    workspaceCallbacks?.closed(id);
    surface.removeSession(id);
    await discardSession(id, record);
  };

  /**
   * Bring the operator's newer repository state into the workspace before a
   * request, and return what the agent should be told about it.
   */
  const updateFromSource = async (id: string): Promise<string | undefined> => {
    let update: WorkspaceUpdate;
    try { update = await (await workspaceFor(id)).update(); } catch (error) {
      surface.writeTo(id, "Could not bring your latest repository changes into the workspace" +
        `${error instanceof UnsupportedSourceChange ? `: ${error.message}` : ""}. The agent works on the earlier state.`);
      return undefined;
    }
    if (update.status === "current") return undefined;
    if (update.status === "conflict") {
      surface.writeTo(id, "Your repository changed in files that also have pending changes in this workspace:\n" +
        `${update.paths.map((path) => `  ${path}`).join("\n")}\nThe workspace was not updated; apply or reject the pending changes first.`);
      return undefined;
    }
    const files = update.changes.map((change) => `  ${change.status} ${change.path}`).join("\n");
    surface.writeTo(id, `Brought ${update.changes.length} newer ${update.changes.length === 1 ? "change" : "changes"} ` +
      `from your repository into the workspace:\n${files}`);
    return `Note: the user changed these files in their repository since your last turn; the workspace now includes them:\n${files}`;
  };

  const sessionWork = (id: string): SessionWork => ({
    work: (request) => runOperation(id, async (signal): Promise<WorkResult> => {
      try {
        const coding = await codingFor(id, signal);
        const state = stateFor(id);
        const notes = [state.note, await updateFromSource(id)].filter((note) => note !== undefined);
        const prompt = notes.length === 0 ? request : `${notes.join("\n\n")}\n\n${request}`;
        state.note = undefined;
        const result = await coding.run(prompt, signal);
        if (result.status === "unsettled") { blockSession(id); return result; }
        if (result.status !== "completed") return result;
        const workspace = await workspaceFor(id);
        return { status: "completed", reply: result.reply, changes: workspace.snapshot().changes };
      } catch (error) {
        if (signal.aborted || isAbort(error)) return { status: "cancelled" };
        return { status: "failed", reason: error instanceof Error ? error.message : "Unknown failure" };
      }
    }),
    checks: () => store.checks(),
    suggestChecks: () => {
      const directory = saved(id)?.workspace;
      return suggestChecks(directory === null || directory === undefined ? cwd : join(directory, "repo"));
    },
    setChecks: (commands) => { store.setChecks(commands); },
    review: (commands) => runOperation(id, async (signal): Promise<ReviewResult> => {
      const workspace = await workspaceFor(id);
      const state = stateFor(id);
      state.reviewed = undefined;
      const snapshot = workspace.snapshot();
      const checks = await runChecks(await environmentFor(id), workspace, snapshot, commands, signal);
      if (signal.aborted) return { status: "cancelled" };
      state.reviewed = snapshot;
      surface.inspectFor(id, inspectReview(snapshot, checks));
      return { status: "ready", changes: snapshot.changes, checks };
    }),
    apply: () => serialized(async (): Promise<ApplyResult> => {
      const state = stateFor(id);
      const reviewed = state.reviewed;
      if (reviewed === undefined) return { status: "conflict", reason: "there is no current review", paths: [] };
      state.reviewed = undefined;
      applying.add(id);
      try {
        return { status: "applied", changes: await applyWorkspace(await workspaceFor(id), reviewed) };
      } catch (error) {
        if (error instanceof ApplyConflictError) return { status: "conflict", reason: error.message, paths: error.paths };
        blockSession(id);
        return { status: "uncertain", applied: error instanceof ApplyUncertainError ? error.applied : [] };
      } finally { applying.delete(id); }
    }),
    reject: async () => {
      const state = stateFor(id);
      state.reviewed = undefined;
      (await workspaceFor(id)).revert();
      state.note = "Note: the user rejected your previous changes, and the workspace was reset to the last applied state.";
    },
  });

  return {
    surface,
    session: sessionWork,
    initialSessionId: initial.id,
    blockedSessionIds: savedSessions.filter((session) => session.blocked).map((session) => session.id),
    configureWorkspace: (callbacks) => { workspaceCallbacks = callbacks; },
    abortActive: () => { for (const controller of activeOperations.values()) controller.abort(); },
    dispose: () => {
      for (const state of states.values()) {
        void state.coding?.then((coding) => { coding.dispose(); }, () => undefined);
        void state.environment?.then((environment) => environment.dispose(), () => undefined);
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
        ask: (prompt) => surface.askIn(id, prompt),
        write: (text) => { surface.writeTo(id, text); },
        report: (progress: TesotaShellProgress) => { surface.reportFor(id, progress); },
      }).then(() => {
        ended.add(id);
        if (!closed.has(id)) surface.endSession(id);
      }, (error: unknown) => {
        if (closed.has(id) || closing && isAbort(error)) return;
        ended.add(id);
        try {
          surface.writeTo(id, isAbort(error) ? "Session cancelled.\n" : "Session failed. Pending changes stay in the workspace.\n");
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
    dependencies.dispose?.();
    surface.stop();
  }
}
