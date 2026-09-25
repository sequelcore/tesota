import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { CodingSession, type CommandApproval } from "./integrations/pi-coding-session.js";
import { LIVE_CODEX_MODEL_ID } from "./integrations/pi-live.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { openShellSessionStore, type ShellSessionStore } from "./shell-session-store.js";
import { runTesotaShell, type ApplyResult, type ReviewResult, type TesotaShellDependencies,
  type WorkResult } from "./tesota-shell.js";
import { inspectReview } from "./tesota-shell-inspection.js";
import { createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import type { TesotaShellThemeName } from "./tesota-shell-theme.js";
import { Workspace, type WorkspaceSnapshot } from "./workspace.js";
import { applyWorkspace, ApplyConflictError, ApplyUncertainError } from "./workspace-apply.js";
import { runChecks, suggestChecks } from "./workspace-checks.js";

export type SessionWork = Omit<TesotaShellDependencies, "write" | "ask" | "report">;

export interface TesotaShellCommandDependencies {
  readonly surface: TesotaShellTerminal;
  readonly session: (id: string) => SessionWork;
  readonly dispose?: () => void;
  readonly abortActive?: () => void;
  readonly initialSessionId?: string;
  readonly blockedSessionIds?: readonly string[];
  readonly configureWorkspace: (callbacks: { readonly newSession: (id: string) => void;
    readonly selectSession: (id: string) => void; readonly quit: () => void }) => void;
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
  coding: Promise<CodingSession> | undefined;
  reviewed: WorkspaceSnapshot | undefined;
  /** Context the agent needs with the next request, such as a rejected change. */
  note: string | undefined;
}

export function createProcessTesotaShell(cwd: string = process.cwd(),
  theme: TesotaShellThemeName = "tesota-dark"): TesotaShellCommandDependencies {
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
  let workspaceCallbacks: { readonly newSession: (id: string) => void;
    readonly selectSession: (id: string) => void; readonly quit: () => void } | undefined;
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
      return workspace;
    })();
    state.workspace.catch(() => { state.workspace = undefined; });
    return state.workspace;
  };
  const codingFor = (id: string, signal: AbortSignal): Promise<CodingSession> => {
    const state = stateFor(id);
    state.coding ??= (async () => {
      const workspace = await workspaceFor(id);
      const runtime = await ModelRuntime.create({ credentials: new CodexCredentials(), refreshOnCreate: false,
        allowModelNetwork: false, signal });
      const model = runtime.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model === undefined) throw new Error("The Codex model is unavailable. Run tesota auth login.");
      const engineId = saved(id)?.engineId ?? store.rotateEngine(id);
      const sessions = join(homedir(), ".tesota", "pi-sessions",
        createHash("sha256").update(resolve(cwd).toLocaleLowerCase("en-US")).digest("hex"));
      const existing = SessionManager.findById(workspace.checkout, engineId, sessions);
      const sessionManager = existing === undefined
        ? SessionManager.create(workspace.checkout, sessions, { id: engineId })
        : SessionManager.open(existing, sessions, workspace.checkout);
      return CodingSession.create({ cwd: workspace.checkout, modelRuntime: runtime, model, sessionManager,
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

  const sessionWork = (id: string): SessionWork => ({
    work: (request) => runOperation(id, async (signal): Promise<WorkResult> => {
      try {
        const coding = await codingFor(id, signal);
        const state = stateFor(id);
        const prompt = state.note === undefined ? request : `${state.note}\n\n${request}`;
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
    checks: () => saved(id)?.checks ?? null,
    suggestChecks: () => {
      const directory = saved(id)?.workspace;
      return suggestChecks(directory === null || directory === undefined ? cwd : join(directory, "repo"));
    },
    setChecks: (commands) => { store.setChecks(id, commands); },
    review: (commands) => runOperation(id, async (signal): Promise<ReviewResult> => {
      const workspace = await workspaceFor(id);
      const state = stateFor(id);
      state.reviewed = undefined;
      const snapshot = workspace.snapshot();
      const checks = await runChecks(workspace, snapshot, commands, signal);
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
      try {
        return { status: "applied", changes: await applyWorkspace(await workspaceFor(id), reviewed) };
      } catch (error) {
        if (error instanceof ApplyConflictError) return { status: "conflict", reason: error.message, paths: error.paths };
        blockSession(id);
        return { status: "uncertain", applied: error instanceof ApplyUncertainError ? error.applied : [] };
      }
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
      for (const state of states.values()) void state.coding?.then((coding) => { coding.dispose(); }, () => undefined);
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
        surface.endSession(id);
      }, (error: unknown) => {
        if (closing && isAbort(error)) return;
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
