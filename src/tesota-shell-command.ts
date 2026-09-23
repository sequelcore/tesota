import { homedir } from "node:os";
import { resolve } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { createLiveRepositoryConversationForShell, type ConversationCommandResult,
  type RepositoryConversationForShell } from "./conversation-turn.js";
import type { ConversationInput } from "./conversation-turn-contract.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { runTesotaShell } from "./tesota-shell.js";
import { inspectConversationTurn, inspectTaskReview } from "./tesota-shell-inspection.js";
import { createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import type { TesotaShellThemeName } from "./tesota-shell-theme.js";
import { startTask, type TaskStartProgress, type TaskStartResult } from "./task-start.js";
import { promoteTask } from "./task-promotion.js";
import { runProposalTask } from "./task-run.js";
import { openShellSessionStore } from "./shell-session-store.js";
import { loadProposalTaskOutcome } from "./task-outcome.js";
import { loadTaskProposal } from "./task-proposal.js";

export interface TesotaShellCommandDependencies {
  readonly surface: TesotaShellTerminal;
  readonly discover: (input: ConversationInput, sessionId?: string) => Promise<ConversationCommandResult>;
  readonly start: (proposalId: string, report: (progress: TaskStartProgress) => void,
    sessionId?: string) => Promise<TaskStartResult>;
  readonly dispose?: () => void;
  readonly abortActive?: () => void;
  readonly initialSessionId?: string;
  readonly blockedSessionIds?: readonly string[];
  readonly restore?: () => Promise<void>;
  readonly configureWorkspace?: (callbacks: { readonly newSession: (id: string) => void;
    readonly selectSession: (id: string) => void; readonly quit: () => void }) => void;
}

export function createProcessTesotaShell(cwd: string = process.cwd(),
  theme: TesotaShellThemeName = "tesota-dark"): TesotaShellCommandDependencies {
  const activeOperations = new Map<string, AbortController>();
  const conversations = new Map<string, Promise<RepositoryConversationForShell>>();
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
    return new Promise<void>((resolve, reject) => {
      const waiter = { signal, grant: () => { signal.removeEventListener("abort", abort); resolve(); },
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
  let promotionQueue: Promise<void> = Promise.resolve();
  const promote: typeof promoteTask = (...args) => {
    const result = promotionQueue.then(() => promoteTask(...args));
    promotionQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const store = openShellSessionStore(cwd);
  const savedSessions = store.list();
  for (const session of savedSessions) if (session.interrupted) {
    store.rotateEngine(session.id);
    store.block(session.id);
  }
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
    }
    finally {
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
      surface.writeTo(session.id, "The previous shell stopped during work. Inspect retained evidence before continuing; no approval was restored.");
      store.markActive(session.id, false);
    }
    if (session.blocked) {
      surface.blockSession(session.id);
      surface.writeTo(session.id,
        "This session has unresolved effects. Inspect retained task evidence; this conversation cannot start more work.");
    }
  }
  return {
    surface,
    initialSessionId: initial.id,
    blockedSessionIds: savedSessions.filter((session) => session.blocked).map((session) => session.id),
    restore: async () => {
      for (const session of savedSessions) {
        const proposalId = session.proposalIds.at(-1);
        if (proposalId === undefined) continue;
        try {
          const outcome = await loadProposalTaskOutcome(resolve(homedir(), ".tesota", "proposals"), proposalId);
          surface.recoverFor(session.id, { title: "Recorded task outcome",
            summary: `Recorded work: ${outcome.status}`,
            detail: `State: ${outcome.status}\nFirst check: ${outcome.firstCheck}\n` +
              `Candidate retained: ${outcome.candidate === null ? "No" : "Yes"}\n` +
              `Decision: ${outcome.operator.decision}\n` +
              `Application: ${outcome.promotion}\n\nThis is the task's recorded outcome. ` +
              "Recheck current candidate evidence before relying on an earlier review. No approval was restored." });
        } catch {
          try {
            const proposal = await loadTaskProposal(resolve(homedir(), ".tesota", "proposals"), proposalId);
            surface.recoverFor(session.id, { title: "Recorded proposal",
              summary: "A proposal was recorded; no completed task outcome is available.",
              detail: `Objective: ${proposal.record.proposal.objective}\n` +
                "No task outcome could be reconstructed. No approval was restored." });
          } catch {
            surface.recoverFor(session.id, { title: "Task record unavailable",
              summary: "The recorded task could not be reconstructed.",
              detail: "Inspect the retained proposal and candidate records. No approval was restored." });
          }
        }
      }
    },
    configureWorkspace: (callbacks) => { workspaceCallbacks = callbacks; },
    abortActive: () => { for (const controller of activeOperations.values()) controller.abort(); },
    discover: (input, sessionId = "default") => runOperation(sessionId, async (signal) => {
      let conversation = conversations.get(sessionId);
      if (conversation === undefined) {
        const saved = store.list().find((session) => session.id === sessionId);
        conversation = createLiveRepositoryConversationForShell(cwd, signal, saved?.engineId, saved?.budget);
        conversations.set(sessionId, conversation);
      }
      try {
        let owner = await conversation;
        let result = await owner.discover(input, signal);
        store.recordBudget(sessionId, owner.budget());
        if (result.status === "unavailable" && result.reason === "baseline_changed" &&
            input.clarification === undefined && !signal.aborted) {
          owner.dispose();
          conversations.delete(sessionId);
          const engineId = store.rotateEngine(sessionId);
          surface.writeTo(sessionId,
            "Repository state changed. Refreshing the model context and checking this request again.");
          conversation = createLiveRepositoryConversationForShell(cwd, signal, engineId,
            store.list().find((session) => session.id === sessionId)?.budget);
          conversations.set(sessionId, conversation);
          owner = await conversation;
          result = await owner.discover(input, signal);
          store.recordBudget(sessionId, owner.budget());
        }
        if (result.status === "unsettled") { store.block(sessionId); surface.blockSession(sessionId); }
        if (result.status === "completed" && result.turn.kind === "task_proposal") {
          store.linkProposal(sessionId, result.turn.proposedTask.record.id);
        }
        return result;
      }
      catch (error) {
        const broken = conversations.get(sessionId);
        conversations.delete(sessionId);
        void broken?.then((owner) => { owner.dispose(); }, () => undefined);
        if (signal.aborted || error instanceof Error && error.name === "AbortError") {
          return { status: "cancelled", exitCode: 130, settlement: "observed" };
        }
        surface.writeTo(sessionId, "Repository discovery unavailable or failed; nothing changed and no authority was created.\n");
        return { status: "unavailable", exitCode: 1, reason: "unavailable" };
      }
    }),
    start: (proposalId, report, sessionId = "default") => runOperation(sessionId, async (signal) => {
      const owner = await conversations.get(sessionId);
      if (owner === undefined) throw new Error("Tesota conversation unavailable for approved task");
      const result = await startTask({
        proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
        sourceDirectory: cwd,
        reference: proposalId,
        ask: (prompt) => surface.askIn(sessionId, prompt),
        write: (text) => { surface.writeTo(sessionId, text); },
        report,
        promote,
        onReview: (review) => { surface.inspectFor(sessionId, inspectTaskReview(review)); },
        execute: (grant) => runProposalTask(grant, {
          signal,
          session: owner.taskHost(),
          write: (text) => { surface.writeTo(sessionId, text); },
          writeError: (text) => { surface.writeTo(sessionId, text); },
        }),
      });
      store.recordBudget(sessionId, owner.budget());
      if (result.status === "unsettled") { store.block(sessionId); surface.blockSession(sessionId); }
      return result;
    }),
    dispose: () => { for (const conversation of conversations.values()) {
      void conversation.then((owner) => { owner.dispose(); }, () => undefined);
    } store.close(); },
  };
}

export async function runTesotaShellCommand(
  dependencies: TesotaShellCommandDependencies = createProcessTesotaShell(),
): Promise<number> {
  const { surface } = dependencies;
  surface.start();
  try {
    await dependencies.restore?.();
    const running = new Set<Promise<void>>();
    let resolveQuit: (() => void) | undefined;
    const quit = new Promise<void>((resolve) => { resolveQuit = resolve; });
    const started = new Set<string>();
    const ended = new Set<string>();
    let closing = false;
    const runSession = (id: string): void => {
      if (dependencies.blockedSessionIds?.includes(id)) return;
      if (ended.has(id)) return;
      if (started.has(id)) return;
      started.add(id);
      const operation = runTesotaShell({
        ask: (prompt) => surface.askIn(id, prompt),
        write: (text) => { surface.writeTo(id, text); },
        discover: (input) => dependencies.discover(input, id),
        start: (proposalId, report) => dependencies.start(proposalId, report, id),
        report: (progress: TesotaShellProgress) => { surface.reportFor(id, progress); },
        onTurn: (turn) => { surface.inspectFor(id, inspectConversationTurn(turn)); },
      }).then(() => {
        ended.add(id);
        surface.endSession(id);
      }, (error: unknown) => {
        const cancelled = error instanceof Error && error.name === "AbortError";
        if (closing && cancelled) return;
        ended.add(id);
        try {
          surface.writeTo(id, cancelled ? "Session cancelled. Inspect retained evidence before retrying.\n" :
              "Session failed. Inspect retained evidence before retrying.\n");
        } finally { surface.endSession(id); }
      });
      running.add(operation);
      void operation.finally(() => { running.delete(operation); started.delete(id); });
    };
    if (dependencies.configureWorkspace !== undefined) {
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
    }
    return await runTesotaShell({
      ask: (prompt) => surface.ask(prompt), write: (text) => { surface.write(text); },
      discover: dependencies.discover, start: dependencies.start,
      report: (progress) => { surface.report(progress); },
      onTurn: (turn) => { surface.inspect(inspectConversationTurn(turn)); },
    });
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    surface.write(cancelled
      ? "Tesota session cancelled. Inspect retained evidence before retrying.\n"
      : "Tesota session failed. Inspect retained evidence before retrying.\n");
    return cancelled ? 130 : 1;
  } finally {
    dependencies.dispose?.();
    surface.stop();
  }
}
