import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { confinesCommands, type ExecutionEnvironment, type PreparationStep } from "./execution-environment.js";
import { chooseSessionExecution, packageCacheDirectory, releaseWorkspace, SANDBOX_NAMES,
  type SessionExecution } from "./execution-providers.js";
import type { CommandApproval, NetworkDecision } from "./integrations/pi-coding-session.js";
import { type ModelAccess, type ModelTarget, openModelTarget, startWorkingAgent,
  type WorkingAgent } from "./integrations/model-session.js";
import { ROLE_OFF, type ModelRole, parseModelChoice, readModelChoices, ROUTE_ENGINE } from "./model-roles.js";
import { modelCost, offeredChoices, offeredModels, type OfferedModel, routeListing } from "./models-command.js";
import { handoffBrief, hasHistory, openFindings, type SessionHistory } from "./handoff-brief.js";
import { describeJudgeWarnings, judgeWarnings } from "./judge-warnings.js";
import { modelSwitch, needsBrief } from "./verification/model-switch.js";
import { currentBranch } from "./repository-git.js";
import { askExplorer, askPageReader } from "./integrations/pi-explorer.js";
import type { WebAccess } from "./integrations/web-tools.js";
import { fetchPage, pinnedGet, resolveHost } from "./web-fetch.js";
import { readWebSearch, type WebSearch } from "./web-search.js";
import { ExplorerPool } from "./integrations/pi-explore.js";
import { Advisor } from "./integrations/advisor.js";
import { consultAdvisor } from "./integrations/advisor-session.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { openShellSessionStore, type ShellSessionRecord, type ShellSessionStore } from "./shell-session-store.js";
import { runTesotaShell, type ApplyResult, type ReviewResult, type TesotaShellDependencies,
  type WorkResult } from "./tesota-shell.js";
import { inspectReview } from "./tesota-shell-inspection.js";
import { CONFIRMATION_WINDOW_MS, createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import type { TesotaShellThemeName } from "./tesota-shell-theme.js";
import { UnsupportedSourceChange } from "./source-snapshot.js";
import { Workspace, type WorkspaceSnapshot, type WorkspaceUpdate } from "./workspace.js";
import { applyWorkspace, ApplyConflictError, ApplyUncertainError } from "./workspace-apply.js";
import { runChecks, suggestChecks } from "./workspace-checks.js";
import { flagVerificationChanges } from "./verification-changes.js";
import { runLemmaScriptVerifier } from "./verification/lemmascript-verifier.js";
import { runOxlintVerifier } from "./verification/oxlint-verifier.js";
import { applicableLenses, createPiReviewer } from "./integrations/pi-reviewer.js";
import { reviewDepth, type DepthDecision } from "./review-depth.js";
import { createClaimCheckReviewer } from "./integrations/pi-claimcheck.js";
import { applyRefutation, refuteFindings } from "./integrations/pi-refuter.js";
import { attributeOrigins } from "./finding-origin.js";
import { forecastLine, type ReviewMeasurement, type ReviewModels, type ReviewPlan } from "./review-forecast.js";
import { countsAsMeasurement } from "./verification/review-estimate.js";
import { formatTokens, type TokenUsage, totalTokens } from "./token-usage.js";
import { validateFixes, validationReport } from "./integrations/pi-fix-validator.js";
import type { ReviewInput, ReviewReport, Reviewer } from "./review.js";
import { appendAssurance, decisionEntry, lastOpenReview, reviewEntry, type AssuranceEntry } from "./assurance-journal.js";

export type SessionWork = Omit<TesotaShellDependencies, "write" | "ask" | "report">;

/** One review step of a session: what is reviewed, against which candidate, and where its tokens are counted. */
interface ReviewRun {
  readonly id: string;
  readonly input: ReviewInput;
  /** The whole candidate, base to tree, which origins are checked against even in a correction round. */
  readonly candidate: WorkspaceSnapshot;
  readonly depth: DepthDecision;
  /** Reads a file from the candidate's tree. */
  readonly read: (path: string) => string | undefined;
  readonly onUsage: (usage: TokenUsage) => void;
  /** The models the review step's roles use, read once when the step starts. */
  readonly models: ReviewModels;
  readonly signal: AbortSignal;
}

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
  /** The agent's model in a session: `/model` and `/handoff` (decision 026). */
  readonly agentModel?: AgentModelCommands;
}

export interface AgentModelCommands {
  /** Show the agent's model and the offered ones, or switch to `route:model`, or `default`. */
  change(id: string, argument: string | undefined): Promise<void>;
  /** Start the agent's conversation afresh on the same model. */
  handOff(id: string): Promise<void>;
}

/** Where commands run, in the operator's words: the host is "this computer". */
/** Where commands run, in the operator's words: which sandbox, or "this computer" for the host. */
function executionLabel(execution: SessionExecution): string {
  if (execution.commands === "host") return "this computer · asks first";
  return `sandbox · ${SANDBOX_NAMES[execution.provider.name]?.label ?? execution.provider.name}`;
}

function describePreparation(steps: readonly PreparationStep[]): string | undefined {
  if (steps.length === 0) return undefined;
  const failed = steps.find((step) => step.outcome === "failed");
  const done = steps.filter((step) => step.outcome === "done").map((step) => `  ${step.description}`).join("\n");
  if (failed === undefined) return `The sandbox was prepared for this repository:\n${done}`;
  return `Preparing the sandbox stopped at "${failed.description}"; later steps did not run.` +
    `${done.length > 0 ? `\nCompleted:\n${done}` : ""}\n${failed.output.trim()}`;
}


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

function parseNetworkDecision(answer: string): NetworkDecision {
  const value = answer.trim().toLowerCase();
  if (value === "y" || value === "yes") return "session";
  if (value === "a" || value === "always") return "repository";
  return "deny";
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** One shell session's workspace, agent conversation and pending review. */
class SessionState {
  workspace: Promise<Workspace> | undefined;
  environment: Promise<ExecutionEnvironment> | undefined;
  coding: Promise<WorkingAgent> | undefined;
  /** The agent's read-only explorers (decision 019); absent when explorers are off. */
  explorers: ExplorerPool | undefined;
  /** The advisor the agent consults (decision 027); absent when it is off. */
  advisor: Advisor | undefined;
  /** The agent once it has started, for what can be read without waiting: the size of its conversation. */
  agent: WorkingAgent | undefined;
  /** Sites the operator allowed or refused for this session's page reading (decision 024). */
  readonly webAllowed: Set<string> = new Set();
  readonly webDenied: Set<string> = new Set();
  reviewed: WorkspaceSnapshot | undefined;
  /** Context the agent needs with the next request, such as a rejected change. */
  note: string | undefined;
}

export function createProcessTesotaShell(cwd: string = process.cwd(),
  theme: TesotaShellThemeName = "tesota-dark",
  chooseExecution: () => Promise<SessionExecution> = chooseSessionExecution): TesotaShellCommandDependencies {
  let executionChoice: Promise<SessionExecution> | undefined;
  const sessionExecution = (): Promise<SessionExecution> => {
    executionChoice ??= chooseExecution();
    return executionChoice;
  };
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
  /** The session's agent model: the one its conversation runs on, or for a new agent the operator's choice for the role. */
  const agentChoice = (id: string): string => store.list().find((session) => session.id === id)?.agent ?? readModelChoices().agent;
  let offeredCache: readonly OfferedModel[] | undefined;
  /** The routes' models, read once: the catalogues ship with Tesota and do not change while it runs. */
  const offered = (): readonly OfferedModel[] => { offeredCache ??= offeredModels(); return offeredCache; };
  const showAgentModel = (id: string): void => {
    try { surface.setSessionModel(id, agentChoice(id)); } catch { /* the agent reports an unreadable choice when it opens */ }
  };
  const surface = createTesotaShellTerminal({ cwd, tui, interrupt, theme,
    initialSession: initial, onEntry: (id, entry) => { store.append(id, entry); },
    onInspection: (id, inspection) => { store.inspect(id, inspection); },
    onNewSession: () => {
      const session = store.create();
      surface.addSession(session.id, session.title);
      showAgentModel(session.id);
      surface.selectSession(session.id);
      workspaceCallbacks?.newSession(session.id);
    },
    onCloseSession: (id) => { void closeSession(id); },
    onModel: (id, argument) => { void agentModel.change(id, argument); },
    onHandoff: (id) => { void agentModel.handOff(id); },
    modelPicker: (id) => {
      try {
        const context = states.get(id)?.agent?.contextTokens();
        return { current: agentChoice(id), ...(context === undefined ? {} : { contextTokens: context }), entries: offered().map((model) => ({ id: model.id, detail: modelCost(model),
          reasoning: model.reasoning })) };
      } catch { return undefined; }
    },
    onSessionChange: (id) => { workspaceCallbacks?.selectSession(id); },
    onQuit: () => { workspaceCallbacks?.quit(); } });
  for (const session of savedSessions.slice(1)) surface.addSession(session.id, session.title,
    session.entries, session.inspections);
  for (const session of savedSessions) showAgentModel(session.id);
  surface.setBranch(currentBranch(cwd));
  for (const session of savedSessions) {
    if (session.interrupted) {
      surface.writeTo(session.id, "The previous shell stopped during work. Pending changes stay in the workspace.");
      store.markActive(session.id, false);
    }
    if (session.blocked) {
      surface.blockSession(session.id);
      surface.writeTo(session.id, "This session stopped with unresolved effects. Check your repository and start a new session.", "warning");
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
    state.environment ??= (async () => {
      // The first choice on a machine qualifies the native sandbox there, which takes some seconds.
      surface.reportFor(id, { phase: "preparing", activity: "Choosing where commands run" });
      const [workspace, execution] = await Promise.all([workspaceFor(id), sessionExecution()]);
      surface.setExecution(executionLabel(execution));
      if (execution.commands === "host") {
        surface.writeTo(id, "Commands ask before running and run on this computer without isolation. " +
          "Run tesota setup to see what sandboxed sessions need.", "warning");
      }
      let environment: ExecutionEnvironment;
      surface.reportFor(id, { phase: "preparing" });
      try {
        environment = await execution.provider.prepare(workspace.checkout,
          { onProgress: (activity) => { surface.reportFor(id, { phase: "preparing", activity }); },
            cacheDirectory: packageCacheDirectory(cwd) });
      } catch (error) {
        throw new Error(`The ${execution.provider.name} environment could not start` +
          `${error instanceof Error ? `: ${error.message}` : ""}. Run tesota setup to check it.`);
      } finally { surface.clearProgressFor(id, "preparing"); }
      const remembered = store.allowedNetwork();
      if (remembered.length > 0 && environment.network !== undefined) {
        await environment.network.allow(remembered);
        surface.writeTo(id, `Also allowed for this repository: ${remembered.join(", ")}.`);
      }
      const summary = describePreparation(environment.preparation);
      if (summary !== undefined) {
        const failed = environment.preparation.some((step) => step.outcome === "failed");
        surface.writeTo(id, summary, failed ? "warning" : "info");
        if (failed) state.note = [state.note, `Note: ${summary}`].filter((note) => note !== undefined).join("\n\n");
      }
      return environment;
    })();
    state.environment.catch(() => { state.environment = undefined; });
    return state.environment;
  };
  /** The route and model the operator chose for a role (decisions 020 and 021), read when the role starts work. */
  const openModel = (signal: AbortSignal, role: ModelRole): Promise<ModelTarget> => openModelTarget(readModelChoices()[role], signal);
  /** The model for one of the review step's sessions, counting its tokens toward the step. */
  const modelFor = async (run: ReviewRun, role: ModelRole): Promise<ModelAccess> =>
    ({ target: await openModel(run.signal, role), onUsage: run.onUsage });
  /** In a correction round, whether each finding sent back is resolved; a validator that cannot run settles nothing. */
  const validateCorrection = async (run: ReviewRun): Promise<ReviewReport | undefined> => {
    const sentBack = run.input.correction?.sentBack ?? [];
    if (sentBack.length === 0) return undefined;
    surface.reportFor(run.id, { phase: "reviewing", activity: "Checking each fix" });
    try {
      return await validateFixes(await modelFor(run, "validator"), run.input, sentBack, run.signal);
    } catch {
      return validationReport(run.input.snapshot.tree, sentBack, { status: "cancelled" }, undefined);
    }
  };
  /**
   * The review of a candidate, or in a correction round the validation of what
   * was sent back followed by the review of the correction's own diff. A deep
   * review first says what it will run and what such reviews have cost here.
   */
  const reviewCandidate = async (run: ReviewRun): Promise<ReviewReport[]> => {
    const plan: ReviewPlan = { depth: run.depth.depth, correction: run.input.correction !== undefined, models: run.models,
      lenses: run.depth.depth === "deep" ? applicableLenses(run.input.checkout).map((lens) => lens.name) : [],
      claimcheck: run.input.checks.some((check) => check.verifier === "lemmascript" && check.outcome === "passed") };
    if (plan.depth === "deep") surface.writeTo(run.id, forecastLine(plan, store.reviewMeasurements()));
    const validation = await validateCorrection(run);
    const reports = await reviewAndRefute(run, plan);
    return validation === undefined ? reports : [validation, ...reports];
  };
  /**
   * The reviewers for this plan, run in parallel; then Tesota checks each
   * origin against the whole candidate's diff, and one refuter tests all their findings.
   */
  const reviewAndRefute = async (run: ReviewRun, plan: ReviewPlan): Promise<ReviewReport[]> => {
    const { id, input, signal } = run;
    surface.reportFor(id, { phase: "reviewing", activity: plan.depth === "deep" ? "Deep review" : "Reviewing" });
    const reviewers: Reviewer[] = [];
    try {
      const access = await modelFor(run, "reviewer");
      reviewers.push(createPiReviewer(access));
      for (const lens of applicableLenses(input.checkout).filter((entry) => plan.lenses.includes(entry.name))) {
        reviewers.push(createPiReviewer({ ...access, lens }));
      }
      if (plan.claimcheck) reviewers.push(createClaimCheckReviewer({ ...access, read: run.read }));
    } catch (error) {
      return [{ reviewer: "Tesota reviewer", tree: input.snapshot.tree, status: "incomplete",
        reason: error instanceof Error ? error.message : "the reviewer could not start" }];
    }
    const reports = attributeOrigins(await Promise.all(reviewers.map((reviewer) => reviewer.review(input, signal)
      .catch((error: unknown): ReviewReport => ({ reviewer: reviewer.name, tree: input.snapshot.tree, status: "incomplete",
        reason: error instanceof Error ? error.message : "the reviewer failed" })))), run.candidate);
    if (signal.aborted || !reports.some((report) => report.status === "completed" && report.findings.length > 0)) return reports;
    surface.reportFor(id, { phase: "reviewing", activity: "Testing each finding" });
    try {
      return await refuteFindings(await modelFor(run, "refuter"), input, reports, signal);
    } catch {
      // A refuter that could not run leaves every finding unsettled, never confirmed.
      return applyRefutation(reports, undefined);
    }
  };
  /**
   * A session's web access (decision 024): each site is allowed for the
   * session or the repository, in the list the sandbox's network uses, or
   * refused, with the same question; the page reader runs on the explorers'
   * model when they are on, and the agent's otherwise.
   */
  const webFor = (id: string): WebAccess => {
    const state = stateFor(id);
    const permit = async (host: string): Promise<"allowed" | "denied"> => {
      const destination = `${host}:443`;
      if (state.webAllowed.has(host) || store.allowedNetwork().includes(destination)) return "allowed";
      if (state.webDenied.has(host)) return "denied";
      surface.reportFor(id, { phase: "awaiting_command" });
      const answer = await surface.askIn(id, `Read pages from ${host}? [y]es this session, [a]lways for this repository, [n]o: `);
      surface.reportFor(id, { phase: "working" });
      const decision = parseNetworkDecision(answer);
      if (decision === "deny") { state.webDenied.add(host); return "denied"; }
      if (decision === "repository") store.allowNetwork([destination]);
      state.webAllowed.add(host);
      return "allowed";
    };
    let search: WebSearch;
    try { search = readWebSearch(); } catch (error) {
      const detail = error instanceof Error ? error.message : "~/.tesota/web.json cannot be read";
      search = { search: async () => ({ status: "failed", error: "provider_not_configured", detail }) };
    }
    return {
      search,
      fetch: (url, signal) => fetchPage(url, { permit, resolve: resolveHost, get: pinnedGet }, signal),
      read: async (page, question, signal, onUsage) => askPageReader({ target: await openModel(signal,
        readModelChoices().explorer === ROLE_OFF ? "agent" : "explorer"), onUsage }, page, question, signal),
    };
  };
  /** What this session has recorded, for a brief to an agent that starts a new conversation (decision 026). */
  const sessionHistory = async (id: string, workspace: Workspace): Promise<SessionHistory> => {
    const snapshot = workspace.snapshot();
    let review: SessionHistory["review"];
    try {
      const open = await lastOpenReview(workspace.directory);
      if (open !== undefined) review = { current: open.tree === snapshot.tree, findings: openFindings(open.reviews) };
    } catch {
      surface.writeTo(id, "Tesota could not read the last review from the workspace's journal; the brief leaves its findings out.", "warning");
    }
    const lastReply = saved(id)?.entries.findLast((entry) => entry.kind === "agent")?.text;
    return { requests: await workspace.requests(), changes: snapshot.changes, review, lastReply };
  };
  /** An agent that starts a new conversation in a session with history gets the brief with the next request, shown whole. */
  const briefNewConversation = async (id: string, agent: WorkingAgent, workspace: Workspace): Promise<void> => {
    if (agent.resumed) return;
    const history = await sessionHistory(id, workspace);
    const brief = handoffBrief(history);
    if (!needsBrief(agent.resumed, hasHistory(history)) || brief === undefined) return;
    const state = stateFor(id);
    state.note = [brief, state.note].filter((note) => note !== undefined).join("\n\n");
    surface.writeTo(id, `The agent starts a new conversation and does not have the earlier one. Tesota sends it this brief with your request:\n${brief}`);
  };
  const codingFor = (id: string, signal: AbortSignal): Promise<WorkingAgent> => {
    const state = stateFor(id);
    state.coding ??= (async () => {
      const workspace = await workspaceFor(id);
      const environment = await environmentFor(id);
      // A session keeps the model its conversation runs on; the footer names it.
      const choice = agentChoice(id);
      if (saved(id)?.agent === undefined) store.setAgentModel(id, choice);
      surface.setSessionModel(id, choice);
      const target = await openModelTarget(choice, signal);
      const engineId = saved(id)?.engineId ?? store.rotateEngine(id);
      const existing = SessionManager.findById(workspace.checkout, engineId, piSessionsDirectory);
      const sessionManager = existing === undefined
        ? SessionManager.create(workspace.checkout, piSessionsDirectory, { id: engineId })
        : SessionManager.open(existing, piSessionsDirectory, workspace.checkout);
      const web = webFor(id);
      // Whether explorers are on is decided when the agent starts; which model they use, when each one starts.
      const explorers = readModelChoices().explorer === ROLE_OFF ? undefined
        : new ExplorerPool(async (brief, explorerSignal, onLine, onUsage) => {
          return askExplorer({ target: await openModel(explorerSignal, "explorer"), onUsage, web,
            // Saved beside the checkout, where the agent's tools cannot reach, for the operator to read.
            sessionManager: SessionManager.create(workspace.checkout, join(workspace.directory, "explorers")),
            onActivity: (activity) => { if (activity.type === "tool_started") onLine(`${activity.tool} ${activity.subject}`.trim()); } },
          workspace.checkout, brief, explorerSignal);
        });
      state.explorers = explorers;
      // The advisor reads the agent's conversation as it stands when consulted; which model it uses is read then.
      let consulted: WorkingAgent | undefined;
      const advisor = readModelChoices().advisor === ROLE_OFF ? undefined
        : new Advisor(async (question, advisorSignal, onUsage) => {
          if (consulted === undefined) throw new Error("the agent is not ready");
          return consultAdvisor({ target: await openModel(advisorSignal, "advisor"), onUsage },
            await consulted.conversation(), question, advisorSignal);
        });
      state.advisor = advisor;
      const agent = await startWorkingAgent({ target }, { cwd: workspace.checkout, environment, web,
        ...(explorers === undefined ? {} : { explorers }), ...(advisor === undefined ? {} : { advisor }),
        sandboxed: confinesCommands(environment.guarantees),
        approveCommand: async (command) => {
          surface.reportFor(id, { phase: "awaiting_command" });
          const answer = await surface.askIn(id, `Run \`${command}\`? [y]es, [a]lways this session, [n]o: `);
          surface.reportFor(id, { phase: "working" });
          return parseApproval(answer);
        },
        decideNetwork: async (destinations) => {
          surface.reportFor(id, { phase: "awaiting_command" });
          const answer = await surface.askIn(id, `The sandbox refused network access to ${destinations.join(", ")}. ` +
            "Allow it? [y]es this session, [a]lways for this repository, [n]o: ");
          surface.reportFor(id, { phase: "working" });
          const decision = parseNetworkDecision(answer);
          if (decision === "repository") store.allowNetwork(destinations);
          return decision;
        },
        onActivity: (activity) => { surface.showActivity(id, activity); } }, { sessionManager, conversationId: engineId });
      consulted = agent;
      state.agent = agent;
      await briefNewConversation(id, agent, workspace);
      return agent;
    })();
    state.coding.catch(() => { state.coding = undefined; });
    return state.coding;
  };

  /** The session's agent when it is running; never starts one. */
  const liveAgent = async (id: string): Promise<WorkingAgent | undefined> =>
    states.get(id)?.coding?.catch(() => undefined);
  /** End the agent's conversation; its next request starts a new one on `choice`, which gets the brief. */
  const newConversation = async (id: string, choice: string): Promise<void> => {
    const state = stateFor(id);
    const live = state.coding;
    state.coding = undefined;
    state.explorers = undefined;
    state.advisor = undefined;
    state.agent = undefined;
    await live?.then((coding) => { coding.dispose(); }, () => undefined);
    store.rotateEngine(id);
    store.setAgentModel(id, choice);
    surface.setSessionModel(id, choice);
  };
  const newConversationNote = "It starts a new conversation with your next request and will not have this conversation. " +
    "Tesota sends it a brief of this session: your requests for the pending changes, the changes, open findings " +
    "and the agent's last reply.";
  /** Judges of this session's agent that share its model or lab (decision 028), after a switch. */
  const warnJudges = (id: string, choice: string): void => {
    const warnings = judgeWarnings({ ...readModelChoices(), agent: choice }).filter((warning) => warning.author === "agent");
    // The same model is a warning, colored; a shared lab is a note, dimmed like Tesota's other notes.
    const same = describeJudgeWarnings(warnings.filter((warning) => warning.level === "same_model"));
    const lab = describeJudgeWarnings(warnings.filter((warning) => warning.level === "same_lab"));
    if (same !== "") surface.writeTo(id, same, "warning");
    if (lab !== "") surface.writeTo(id, lab, "info");
  };
  const agentModel: AgentModelCommands = {
    change: async (id, argument) => {
      let current: string;
      let role: string;
      try { current = agentChoice(id); role = readModelChoices().agent; } catch (error) {
        surface.writeTo(id, `${error instanceof Error ? error.message : "The model choices could not be read"}.`, "warning");
        return;
      }
      const models = offered();
      if (argument === undefined) {
        surface.writeTo(id, `The agent uses ${current} in this session; new sessions use ${role} (tesota models agent).\n` +
          "/model <route:model> switches it: on the same engine its conversation continues, on another it starts a new one. " +
          `/model default returns to ${role}. Add @low, @medium, @high, @xhigh or @max for a reasoning level the model ` +
          `accepts. Offered:\n${routeListing(models)}`);
        return;
      }
      const choice = argument === "default" ? role : argument;
      const from = parseModelChoice(current);
      const to = parseModelChoice(choice);
      if (from === undefined || to === undefined || !offeredChoices(models).includes(choice)) {
        surface.writeTo(id, `${choice} is not offered. /model lists the models.`, "warning");
        return;
      }
      switch (modelSwitch(choice === current, ROUTE_ENGINE[from.route] === ROUTE_ENGINE[to.route])) {
        case "unchanged": surface.writeTo(id, `The agent already uses ${current}.`); return;
        case "in_place": {
          try {
            const target = await openModelTarget(choice);
            await (await liveAgent(id))?.switchModel(target);
          } catch (error) {
            surface.writeTo(id, `The agent could not switch to ${choice}: ${error instanceof Error ? error.message : "unknown error"}. ` +
              `It still uses ${current}.`, "warning");
            return;
          }
          store.setAgentModel(id, choice);
          surface.setSessionModel(id, choice);
          surface.writeTo(id, `The agent now uses ${choice}; its conversation continues.`);
          const context = states.get(id)?.agent?.contextTokens();
          // A prompt cache belongs to one model and level; measured on both engines, the next call reads everything anew.
          if (context !== undefined) {
            surface.writeTo(id, `The next request re-reads this conversation, about ${formatTokens(context)}, without the ` +
              "prompt cache, which belongs to one model and level; later requests use the cache again. /handoff instead " +
              "starts a new conversation with a short brief.");
          }
          warnJudges(id, choice);
          return;
        }
        case "new_conversation":
          await newConversation(id, choice);
          surface.writeTo(id, `The agent now uses ${choice}, which runs on another engine. ${newConversationNote}`);
          warnJudges(id, choice);
      }
    },
    handOff: async (id) => {
      let current: string;
      try { current = agentChoice(id); } catch (error) {
        surface.writeTo(id, `${error instanceof Error ? error.message : "The model choices could not be read"}.`, "warning");
        return;
      }
      await newConversation(id, current);
      surface.writeTo(id, `The agent stays on ${current}. ${newConversationNote}`);
    },
  };
  const blockSession = (id: string): void => { store.block(id); surface.blockSession(id); };
  /** Evidence that could not be recorded is reported, never dropped silently. */
  const journal = async (id: string, workspace: Workspace, entry: AssuranceEntry): Promise<void> => {
    try { await appendAssurance(workspace.directory, entry); } catch (error) {
      surface.writeTo(id, `Tesota could not record this in the workspace's assurance journal: ${error instanceof Error ? error.message : "unknown error"}.`, "warning");
    }
  };

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
    if (warnedAt !== undefined && Date.now() - warnedAt <= CONFIRMATION_WINDOW_MS) {
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
      await releaseWorkspace(join(record.workspace, "repo"));
      // The conversation and those it left behind at a handoff (decision 026).
      for (const engineId of [record.engineId, ...record.retiredEngineIds ?? []]) {
        const transcript = SessionManager.findById(join(record.workspace, "repo"), engineId, piSessionsDirectory);
        if (transcript !== undefined) await rm(transcript, { force: true });
      }
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
      showAgentModel(replacement.id);
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
        `${error instanceof UnsupportedSourceChange ? `: ${error.message}` : ""}. The agent works on the earlier state.`, "warning");
      return undefined;
    }
    if (update.status === "current") return undefined;
    if (update.status === "conflict") {
      surface.writeTo(id, "Your repository changed in files that also have pending changes in this workspace:\n" +
        `${update.paths.map((path) => `  ${path}`).join("\n")}\nThe workspace was not updated; apply or reject the pending changes first.`, "warning");
      return undefined;
    }
    const files = update.changes.map((change) => `  ${change.status} ${change.path}`).join("\n");
    surface.writeTo(id, `Brought ${update.changes.length} newer ${update.changes.length === 1 ? "change" : "changes"} ` +
      `from your repository into the workspace:\n${files}`);
    return `Note: the user changed these files in their repository since your last turn; the workspace now includes them:\n${files}`;
  };

  const sessionWork = (id: string): SessionWork => ({
    prepare: () => {
      environmentFor(id).catch((error: unknown) => {
        // The first request prepares again and reports its own outcome.
        if (states.has(id)) surface.writeTo(id, `${error instanceof Error ? error.message : "The environment could not start."}`, "warning");
      });
    },
    work: (request, origin = "operator") => runOperation(id, async (signal): Promise<WorkResult> => {
      surface.setBranch(currentBranch(cwd));
      try {
        const coding = await codingFor(id, signal);
        const state = stateFor(id);
        const notes = [state.note, await updateFromSource(id)].filter((note) => note !== undefined);
        // A new request makes any earlier review stale, whether or not the work finishes.
        stateFor(id).reviewed = undefined;
        if (origin === "operator") await (await workspaceFor(id)).recordRequest(request);
        const prompt = notes.length === 0 ? request
          : `Tesota context (not written by the user):\n${notes.join("\n\n")}\n\nUser request:\n${request}`;
        state.note = undefined;
        state.explorers?.startTurn();
        state.advisor?.startTurn();
        const result = await coding.run(prompt, signal);
        if (result.status === "unsettled") { blockSession(id); return result; }
        if (result.status !== "completed") return result;
        const workspace = await workspaceFor(id);
        return { status: "completed", changes: workspace.snapshot().changes };
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
    review: (commands, correction) => runOperation(id, async (signal): Promise<ReviewResult> => {
      const workspace = await workspaceFor(id);
      const state = stateFor(id);
      state.reviewed = undefined;
      const snapshot = workspace.snapshot();
      const read = (revision: string, path: string): string | undefined => workspace.contentAt(revision, path);
      const checks = [...await runChecks(await environmentFor(id), workspace, snapshot, commands, signal),
        ...await runOxlintVerifier(snapshot, read), ...await runLemmaScriptVerifier(snapshot, read, signal)];
      if (signal.aborted) return { status: "cancelled" };
      const flags = flagVerificationChanges(snapshot, read);
      const requests = await workspace.requests();
      // A correction round reviews only the correction; the verifiers above always cover the whole candidate.
      const scope = correction === undefined ? snapshot
        : { ...snapshot, base: correction.previousTree, ...workspace.compare(correction.previousTree, snapshot.tree) };
      const depth = reviewDepth(scope, flags, checks);
      const started = Date.now();
      let tokens = 0;
      const { reviewer, refuter, validator } = readModelChoices();
      const models: ReviewModels = { reviewer, refuter, validator };
      const reports = await reviewCandidate({ id, signal, depth, candidate: snapshot, models,
        input: { checkout: workspace.checkout, requests, snapshot: scope, checks, flags,
          ...(correction === undefined ? {} : { correction: { sentBack: correction.sentBack } }) },
        read: (path) => read(snapshot.tree, path), onUsage: (usage) => { tokens += totalTokens(usage); } });
      if (signal.aborted) return { status: "cancelled" };
      const measurement: ReviewMeasurement = { at: new Date().toISOString(), depth: depth.depth,
        correction: correction !== undefined, durationMs: Date.now() - started, tokens, models };
      if (countsAsMeasurement(reports.map((report) => report.status))) {
        try { store.recordReviewMeasurement(measurement); } catch {
          surface.writeTo(id, "Tesota could not record what this review cost; later forecasts leave it out.", "warning");
        }
      }
      // Reviewers have no tool that writes, but only an unchanged candidate may be applied.
      const unchanged = workspace.snapshot().tree === snapshot.tree;
      const reviews: ReviewReport[] = unchanged ? reports : reports.map((report) => ({ reviewer: report.reviewer,
        tree: snapshot.tree, status: "incomplete", reason: "the candidate changed during review" }));
      if (unchanged) state.reviewed = snapshot;
      surface.inspectFor(id, inspectReview({ snapshot, checks, flags, requests, reviews, depth, measurement }));
      await journal(id, workspace, reviewEntry(snapshot, requests, checks, flags, reviews, depth, measurement));
      return { status: "ready", tree: snapshot.tree, changes: snapshot.changes, checks, reviews, requests };
    }),
    apply: () => serialized(async (): Promise<ApplyResult> => {
      const state = stateFor(id);
      const reviewed = state.reviewed;
      if (reviewed === undefined) return { status: "conflict", reason: "there is no current review", paths: [] };
      state.reviewed = undefined;
      applying.add(id);
      const workspace = await workspaceFor(id);
      try {
        const changes = await applyWorkspace(workspace, reviewed);
        await journal(id, workspace, decisionEntry(reviewed.tree, "applied"));
        return { status: "applied", changes };
      } catch (error) {
        if (error instanceof ApplyConflictError) {
          await journal(id, workspace, decisionEntry(reviewed.tree, "application_conflict"));
          return { status: "conflict", reason: error.message, paths: error.paths };
        }
        blockSession(id);
        await journal(id, workspace, decisionEntry(reviewed.tree, "application_uncertain"));
        return { status: "uncertain", applied: error instanceof ApplyUncertainError ? error.applied : [] };
      } finally { applying.delete(id); }
    }),
    reject: async () => {
      const state = stateFor(id);
      const rejected = state.reviewed;
      state.reviewed = undefined;
      const workspace = await workspaceFor(id);
      if (rejected !== undefined) await journal(id, workspace, decisionEntry(rejected.tree, "rejected"));
      workspace.revert();
      state.note = "Note: the user rejected your previous changes, and the workspace was reset to the last applied state.";
    },
  });

  return {
    surface,
    session: sessionWork,
    initialSessionId: initial.id,
    blockedSessionIds: savedSessions.filter((session) => session.blocked).map((session) => session.id),
    configureWorkspace: (callbacks) => { workspaceCallbacks = callbacks; },
    agentModel,
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
        write: (text, tone) => { surface.writeTo(id, text, tone); },
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
