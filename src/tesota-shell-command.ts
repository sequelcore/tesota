import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { confinesCommands, type ExecutionEnvironment, type PreparationStep } from "./execution-environment.js";
import { chooseSessionExecution, packageCacheDirectory, providersFor, readSandboxPreference, releaseWorkspace,
  SANDBOX_NAMES, SANDBOX_PREFERENCES, type SandboxPreference, type SessionExecution } from "./execution-providers.js";
import type { CommandApproval, NetworkDecision } from "./integrations/pi-coding-session.js";
import { type ModelAccess, type ModelTarget, openModelTarget, startWorkingAgent,
  type WorkingAgent } from "./integrations/model-session.js";
import { isDecisionModel, ROLE_OFF, type ModelRole, parseModelChoice, readModelChoices, ROUTE_ENGINE } from "./model-roles.js";
import { type WorkPlan, withReview } from "./work-plan.js";
import { isGitRepository } from "./folder-source.js";
import { dataNotice, modelCost, offeredChoices, offeredModels, type OfferedModel, rolePicker, routeListing,
  runRolesCommand } from "./models-command.js";
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
import { Semaphore } from "./semaphore.js";
import type { TesotaShellProgress } from "./shell-progress.js";
import { openShellSessionStore, type ShellSessionRecord, type ShellSessionStore } from "./shell-session-store.js";
import { runTesotaShell, type AnswerResult, type ApplyResult, type ReviewResult, type TesotaShellDependencies,
  type WorkResult } from "./tesota-shell.js";
import { inspectAnswer, inspectReview } from "./tesota-shell-inspection.js";
import { obligationOutcome } from "./verification/obligation-outcome.js";
import { runsAnswerCheck } from "./verification/answer-check-rule.js";
import { triageAnswer, type TriageDecision } from "./integrations/answer-triage.js";
import { jevTriage, typesafeKey } from "./integrations/jev-triage.js";
import { nameSession } from "./integrations/session-namer.js";
import { cleanTitle, seedTitle } from "./session-title.js";
import { CONFIRMATION_WINDOW_MS, createTesotaShellTerminal, type TesotaShellTerminal } from "./tesota-shell-terminal.js";
import type { TesotaShellThemeName } from "./tesota-shell-theme.js";
import { UnsupportedSourceChange } from "./source-snapshot.js";
import { Workspace, type WorkspaceSnapshot, type WorkspaceUpdate } from "./workspace.js";
import { applyWorkspace, ApplyConflictError, ApplyUncertainError } from "./workspace-apply.js";
import { type BaseRuns, runChecks, suggestChecks } from "./workspace-checks.js";
import { flagVerificationChanges } from "./verification-changes.js";
import { runLemmaScriptVerifier } from "./verification/lemmascript-verifier.js";
import { runOxlintVerifier } from "./verification/oxlint-verifier.js";
import { applicableLenses, createPiReviewer } from "./integrations/pi-reviewer.js";
import { reviewDepth, type DepthDecision } from "./review-depth.js";
import { createClaimCheckReviewer } from "./integrations/pi-claimcheck.js";
import { applyRefutation, hasClaimsToTest, refuteFindings } from "./integrations/pi-refuter.js";
import { attributeOrigins } from "./finding-origin.js";
import { forecastLine, type ReviewMeasurement, type ReviewModels, type ReviewPlan } from "./review-forecast.js";
import { countsAsMeasurement } from "./verification/review-estimate.js";
import { formatTokens, type TokenUsage, totalTokens } from "./token-usage.js";
import { validateFixes, validationReport } from "./integrations/pi-fix-validator.js";
import type { ReviewInput, ReviewReport, Reviewer } from "./review.js";
import { appendAssurance, decisionEntry, lastOpenReview, reviewEntry, type AssuranceEntry } from "./assurance-journal.js";

export type SessionWork = Omit<TesotaShellDependencies, "write" | "ask" | "report">;

/** How long quitting waits for the sessions' environments to be released, such as the native sandbox's drive. */
const RELEASE_TIME_LIMIT_MS = 5_000;

/** How many sessions' operations run at once; the rest wait their turn. */
const OPERATIONS_AT_ONCE = 2;

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
}

export interface SessionSandboxCommands {
  /** Show where the session's commands run, or switch it to a sandbox choice, or `default`. */
  change(id: string, argument: string | undefined): Promise<void>;
}

export interface AgentModelCommands {
  /** Show the agent's model and the offered ones, or switch to `route:model`, or `default`. */
  change(id: string, argument: string | undefined): Promise<void>;
  /** Start the agent's conversation afresh on the same model. */
  handOff(id: string): Promise<void>;
}

/** Where commands run, in the operator's words: which sandbox, or "this computer" for the host. */
function executionLabel(execution: SessionExecution): string {
  if (execution.commands === "host") return "this computer · asks first";
  return `sandbox · ${SANDBOX_NAMES[execution.provider.name]?.label ?? execution.provider.name}`;
}

/** Where commands run, as a phrase: "in the native sandbox", or "on this computer" for the host. */
function executionPlace(execution: SessionExecution): string {
  if (execution.commands === "host") return "on this computer, which asks before each command";
  return `in ${SANDBOX_NAMES[execution.provider.name]?.described ?? execution.provider.name}`;
}

/** Why a named sandbox is not in use here: its missing steps, or the controls that failed on this computer. */
function unavailableReason(execution: SessionExecution): string {
  if (execution.commands === "sandbox") return "";
  return execution.missing.flatMap((entry) => {
    const failed = entry.qualification?.results.filter((result) => !result.passed) ?? [];
    if (failed.length > 0) return failed.map((result) => `its controls failed on this computer (${result.detail})`);
    return entry.readiness.ready ? [] : entry.readiness.steps.map((step) => step.description);
  }).join("; ");
}

const sandboxUsage = `Use /sandbox or /sandbox <${SANDBOX_PREFERENCES.join("|")}|default>.`;

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

/**
 * Keep a session's resource while it is being acquired, and forget it if
 * acquiring fails, so the next request tries again. A resource replaced in
 * the meantime, as a sandbox switch replaces the environment, stays.
 */
function remember<T>(pending: Promise<T>, current: () => Promise<T> | undefined,
  set: (value: Promise<T> | undefined) => void): Promise<T> {
  set(pending);
  pending.catch(() => { if (current() === pending) set(undefined); });
  return pending;
}

/**
 * End what a session holds: stop a preparation still under way, then end the
 * agent and release the environment; one that never came leaves nothing.
 */
async function release(held: Pick<SessionState, "coding" | "environment" | "preparation">): Promise<void> {
  held.preparation?.abort();
  await held.coding?.then((coding) => { coding.dispose(); }, () => undefined);
  await held.environment?.then((environment) => environment.dispose(), () => undefined);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** One shell session's workspace, agent conversation and pending review. */
class SessionState {
  workspace: Promise<Workspace> | undefined;
  environment: Promise<ExecutionEnvironment> | undefined;
  /** Stops the environment's preparation when the session closes, switches sandbox or the shell quits. */
  preparation: AbortController | undefined;
  /** Where the environment's commands run, once chosen. */
  execution: SessionExecution | undefined;
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
  /** How failing checks ended on the base, so correction rounds on the same base do not run it again (decision 039). */
  readonly baseRuns: BaseRuns = new Map();
  /** Context the agent needs with the next request, such as a rejected change. */
  note: string | undefined;
  /** The agent's last reply, which the answer check reads when a turn changes no files (decision 034). */
  lastReply: string | undefined;
}

export function createProcessTesotaShell(cwd: string = process.cwd(),
  theme: TesotaShellThemeName = "tesota-dark",
  chooseExecution: (preference: SandboxPreference) => Promise<SessionExecution> =
    (preference) => chooseSessionExecution(providersFor(preference)),
  resumeSessionId?: string): TesotaShellCommandDependencies {
  // Each choice is made once per shell: the first on a machine qualifies the native sandbox, which takes some seconds.
  const executionChoices = new Map<SandboxPreference, Promise<SessionExecution>>();
  const executionFor = (preference: SandboxPreference): Promise<SessionExecution> => {
    let choice = executionChoices.get(preference);
    if (choice === undefined) {
      choice = chooseExecution(preference);
      choice.catch(() => { executionChoices.delete(preference); });
      executionChoices.set(preference, choice);
    }
    return choice;
  };
  /** A session's own choice from `/sandbox`, or else the operator's choice for new sessions. */
  const sandboxPreference = (id: string): SandboxPreference => saved(id)?.sandbox ?? readSandboxPreference();
  const activeOperations = new Map<string, AbortController>();
  const states = new Map<string, SessionState>();
  const operations = new Semaphore(OPERATIONS_AT_ONCE);
  let applicationQueue: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = applicationQueue.then(operation);
    applicationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
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
      acquired = await operations.acquire(cancellation.signal);
      if (!acquired) throw new DOMException("cancelled", "AbortError");
      return await operation(cancellation.signal);
    } finally {
      if (acquired) operations.release();
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
    initialSession: firstDisplayed, onEntry: (id, entry) => { store.append(id, entry); },
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
    onModel: (id, argument) => { void agentModel.change(id, argument); },
    onHandoff: (id) => { void agentModel.handOff(id); },
    onSandbox: (id, argument) => { void sessionSandbox.change(id, argument); },
    sandboxPicker: (id) => {
      const own = saved(id)?.sandbox;
      const preference = readSandboxPreference();
      const current = own ?? preference;
      return { title: `Sandbox: ${own === undefined ? `default (${current})` : current}`, entries: [
        { value: "default", label: "default", detail: `Follow the choice for new sessions (${preference})` },
        ...SANDBOX_PREFERENCES.map((value) => ({ value, label: value,
          detail: `${value === current ? "Current · " : ""}${value === "auto" ? "Native, then Docker, then this computer" :
            value === "host" ? "This computer; asks before commands" :
              `${Object.values(SANDBOX_NAMES).find((entry) => entry.choice === value)?.described ?? value}; availability checked on selection`}` })),
      ] };
    },
    onRoleModel: (id, args) => {
      let text = "";
      const code = runRolesCommand(args, (written) => { text += written; }, offered());
      // The agent's role sets the model new sessions start with; `/model` switches a running session's.
      const agent = code === 0 && args[0] === "agent" ? "New sessions start with it; /model switches this one's.\n" : "";
      surface.writeTo(id, `${text}${agent}`.trimEnd(), code === 0 ? "success" : "warning");
    },
    onRename: (id, name) => {
      if (name === undefined) {
        // As Codex's /rename suggests one: a title from the session's latest requests.
        const requests = (store.list().find((session) => session.id === id)?.entries ?? [])
          .flatMap((entry) => entry.kind === "user" && !entry.text.startsWith("/") ? [entry.text] : []).slice(-8);
        if (requests.length === 0) { surface.writeTo(id, "Nothing to name yet. Use /rename <name>.", "warning"); return; }
        surface.writeTo(id, "Naming the session from its requests.");
        nameInBackground(id, requests, "operator");
        return;
      }
      const title = cleanTitle(name);
      try {
        if (title !== undefined && store.setTitle(id, title, "operator")) surface.setSessionTitle(id, title);
        else surface.writeTo(id, "Use /rename <name>, with some text.", "warning");
      } catch { surface.writeTo(id, "The name could not be saved.", "warning"); }
    },
    modelPicker: (id, prefix) => {
      try {
        if (prefix !== "/model ") return rolePicker(prefix, offered());
        const context = states.get(id)?.agent?.contextTokens();
        return { current: agentChoice(id), ...(context === undefined ? {} : { contextTokens: context }), entries: offered().map((model) => ({ id: model.id, detail: modelCost(model),
          reasoning: model.reasoning })) };
      } catch { return undefined; }
    },
    onSessionChange: (id) => { workspaceCallbacks?.selectSession(id); },
    onQuit: () => { workspaceCallbacks?.quit(); } });
  for (const session of savedSessions.slice(1)) surface.addSession(session.id, session.title,
    session.entries, session.inspections);
  if (resumed === undefined && savedSessions.length > 0) surface.addSession(initial.id, initial.title);
  surface.selectSession(initial.id);
  if (resumed === undefined) showAgentModel(initial.id);
  for (const session of savedSessions) {
    showAgentModel(session.id);
    if (session.plan !== undefined) surface.setSessionPlan(session.id, session.plan);
  }
  /** The agent's plan (decision 033), shown and saved; undefined when the work it planned ends. */
  const showPlan = (id: string, plan: WorkPlan | undefined): void => {
    store.setPlan(id, plan);
    surface.setSessionPlan(id, plan);
  };
  /** Whether the shell works on a Git repository or a plain folder, decided once (decision 032). */
  const sourceKind = isGitRepository(cwd) ? "repository" as const : "folder" as const;
  /** The source repository's branch; a plain folder has none. */
  const sourceBranch = (): string | undefined => sourceKind === "repository" ? currentBranch(cwd) : undefined;
  surface.setBranch(sourceBranch());
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
    if (state.workspace !== undefined) return state.workspace;
    const pending = (async () => {
      const directory = saved(id)?.workspace;
      if (directory !== null && directory !== undefined) {
        try { return await Workspace.open(directory); } catch { store.rotateEngine(id); }
      }
      const workspace = await Workspace.create(cwd, undefined, { kind: sourceKind });
      store.setWorkspace(id, workspace.directory);
      if (workspace.included.length > 0) {
        surface.writeTo(id, `The workspace includes your ${workspace.included.length} uncommitted ` +
          `${workspace.included.length === 1 ? "change" : "changes"}. Later edits in your repository are not visible to the agent.`);
      }
      return workspace;
    })();
    return remember(pending, () => state.workspace, (value) => { state.workspace = value; });
  };
  const environmentFor = (id: string): Promise<ExecutionEnvironment> => {
    const state = stateFor(id);
    if (state.environment !== undefined) return state.environment;
    const preparation = new AbortController();
    state.preparation = preparation;
    const pending = (async () => {
      // The first choice on a machine qualifies the native sandbox there, which takes some seconds.
      surface.reportFor(id, { phase: "preparing", activity: "Choosing where commands run" });
      const [workspace, execution] = await Promise.all([workspaceFor(id), executionFor(sandboxPreference(id))]);
      state.execution = execution;
      surface.setSessionExecution(id, executionLabel(execution));
      if (execution.commands === "host") {
        surface.writeTo(id, "Commands ask before running and run on this computer without isolation. " +
          "Run tesota setup to see what sandboxed sessions need.", "warning");
      }
      let environment: ExecutionEnvironment;
      surface.reportFor(id, { phase: "preparing" });
      try {
        environment = await execution.provider.prepare(workspace.checkout,
          { onProgress: (activity) => { surface.reportFor(id, { phase: "preparing", activity }); },
            cacheDirectory: packageCacheDirectory(cwd), signal: preparation.signal });
      } catch (error) {
        if (preparation.signal.aborted) throw new DOMException("preparation stopped", "AbortError");
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
    return remember(pending, () => state.environment, (value) => { state.environment = value; });
  };
  /** The route and model the operator chose for a role (decisions 020 and 021), read when the role starts work. */
  const openModel = (signal: AbortSignal, role: ModelRole): Promise<ModelTarget> => openModelTarget(readModelChoices()[role], signal);
  /** Stops titles still being written when Tesota quits. */
  const titling = new AbortController();
  /** Name the session in the background on the namer's model (decision 036); a title that does not come leaves the name. */
  const nameInBackground = (id: string, requests: readonly string[], source: "generated" | "operator"): void => {
    void (async () => {
      const choice = readModelChoices().namer;
      if (choice === ROLE_OFF) return;
      const title = await nameSession({ target: await openModelTarget(choice, titling.signal) }, requests, titling.signal);
      if (title !== undefined && store.setTitle(id, title, source)) surface.setSessionTitle(id, title);
    })().catch(() => undefined);
  };
  /** The operator's first request names a new session at once, and a model's title follows. */
  const nameFromRequest = (id: string, request: string): void => {
    const seed = seedTitle(request);
    if (seed === undefined || !store.setTitle(id, seed, "request")) return;
    surface.setSessionTitle(id, seed);
    nameInBackground(id, [request], "generated");
  };
  /**
   * The answer check's first pass on the triage role's choice (decisions 034 and 035): a model session or a typed
   * decision model. Off, or failing in any way, it decides nothing, and the full check runs.
   */
  const firstPass = async (requests: readonly string[], reply: string, signal: AbortSignal): Promise<TriageDecision> => {
    const undecided = (reason: string): TriageDecision => ({ decided: false, checkable: true, reason });
    try {
      const choice = readModelChoices().triage;
      if (choice === ROLE_OFF) return undecided("the first pass is off");
      if (!isDecisionModel(choice)) return await triageAnswer({ target: await openModelTarget(choice, signal) }, requests, reply, signal);
      const key = await typesafeKey();
      return key === undefined ? undecided("no TypeSafe key") : await jevTriage(key, choice, requests, reply, signal);
    } catch { return undecided("the first pass failed"); }
  };
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
    if (signal.aborted || !hasClaimsToTest(reports)) return reports;
    surface.reportFor(id, { phase: "reviewing", activity: "Testing each finding and gap" });
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
    if (state.coding !== undefined) return state.coding;
    const pending = (async () => {
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
      const planCalls = new Set<string>();
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
        plan: (plan) => { showPlan(id, plan); },
        // The plan shows beside the prompt, so its tool calls stay out of the conversation.
        onActivity: (activity) => {
          if (activity.type === "tool_started" && activity.tool === "plan") planCalls.add(activity.call);
          if ("call" in activity && planCalls.has(activity.call)) return;
          surface.showActivity(id, activity);
        } }, { sessionManager, conversationId: engineId });
      consulted = agent;
      state.agent = agent;
      await briefNewConversation(id, agent, workspace);
      return agent;
    })();
    return remember(pending, () => state.coding, (value) => { state.coding = value; });
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
  /** After a switch: judges of this session's agent that share its model or lab (decision 028), and a free model's data use. */
  const warnJudges = (id: string, choice: string): void => {
    const warnings = judgeWarnings({ ...readModelChoices(), agent: choice }).filter((warning) => warning.author === "agent");
    // The same model is a warning, colored; a shared lab is a note, dimmed like Tesota's other notes.
    const same = describeJudgeWarnings(warnings.filter((warning) => warning.level === "same_model"));
    const lab = describeJudgeWarnings(warnings.filter((warning) => warning.level === "same_lab"));
    if (same !== "") surface.writeTo(id, same, "warning");
    if (lab !== "") surface.writeTo(id, lab, "info");
    // A free gateway model may keep the repository's code (decision 031).
    const notice = dataNotice(choice);
    if (notice !== undefined) surface.writeTo(id, `Free model: ${notice}. Choose a paid model for code you would not share.`, "warning");
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
        surface.writeTo(id, `The agent uses ${current} in this session; new sessions use ${role} (tesota roles agent).\n` +
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
  /** End the session's agent and environment; its next request prepares them again, on the same conversation. */
  const restartEnvironment = async (id: string): Promise<void> => {
    const state = stateFor(id);
    const held = { coding: state.coding, environment: state.environment, preparation: state.preparation };
    state.coding = undefined;
    state.environment = undefined;
    state.preparation = undefined;
    state.execution = undefined;
    state.explorers = undefined;
    state.advisor = undefined;
    state.agent = undefined;
    await release(held);
  };
  const describeSandbox = (id: string): void => {
    const execution = states.get(id)?.execution;
    const own = saved(id)?.sandbox;
    const current = execution === undefined ? "Commands in this session run where its next request chooses"
      : `Commands in this session run ${executionPlace(execution)}`;
    surface.writeTo(id, `${current}; ${own === undefined ? "it follows your choice for new sessions" : `its own choice is ${own}`}, ` +
      `and new sessions use ${readSandboxPreference()} (tesota sandbox).\n` +
      `/sandbox <${SANDBOX_PREFERENCES.join("|")}> switches this session: its environment is prepared again, and the ` +
      "agent restarts with its conversation. /sandbox default follows your choice for new sessions.");
  };
  /** Switch a session to `preference`; a sandbox named outright is used only when it is ready here. */
  const switchSandbox = async (id: string, preference: SandboxPreference, followDefault: boolean): Promise<void> => {
    surface.reportFor(id, { phase: "preparing", activity: "Choosing where commands run" });
    let next: SessionExecution;
    try { next = await executionFor(preference); } finally { surface.clearProgressFor(id, "preparing"); }
    const state = stateFor(id);
    const current = state.execution;
    if ((preference === "native" || preference === "docker") && next.commands === "host") {
      const name = Object.values(SANDBOX_NAMES).find((entry) => entry.choice === preference)?.described ?? preference;
      surface.writeTo(id, `${name.charAt(0).toUpperCase()}${name.slice(1)} is not ready here: ${unavailableReason(next)}. ` +
        `Commands in this session still run ${current === undefined ? "where they did" : executionPlace(current)}. ` +
        "tesota sandbox shows what each sandbox needs.", "warning");
      return;
    }
    store.setSandbox(id, followDefault ? undefined : preference);
    if (followDefault) surface.writeTo(id, `This session follows your choice for new sessions (${preference}).`);
    if (current?.provider === next.provider) {
      surface.writeTo(id, `Commands in this session already run ${executionPlace(next)}.`);
      return;
    }
    if (state.environment === undefined) {
      surface.writeTo(id, `Commands in this session will run ${executionPlace(next)}.`);
      return;
    }
    await restartEnvironment(id);
    surface.setSessionExecution(id, executionLabel(next));
    // The conversation remembers commands from the earlier environment: its paths and shell may no longer apply.
    const earlier = current === undefined ? "" : `; earlier commands in this conversation ran ${executionPlace(current)}, ` +
      "so their paths and tools may differ";
    state.note = [state.note, `Note: Commands now run ${executionPlace(next)}${earlier}.`]
      .filter((note) => note !== undefined).join("\n\n");
    surface.writeTo(id, `Commands in this session now run ${executionPlace(next)}. The agent restarts with your next ` +
      "request: its conversation continues, with the tools for where commands now run.");
  };
  const sessionSandbox: SessionSandboxCommands = {
    change: async (id, argument) => {
      if (argument !== undefined && argument !== "default" && !(SANDBOX_PREFERENCES as readonly string[]).includes(argument)) {
        surface.writeTo(id, sandboxUsage, "warning");
        return;
      }
      if (argument !== undefined && activeOperations.has(id)) {
        surface.writeTo(id, "Stop the current work (Esc) or wait for it before switching where commands run.", "warning");
        return;
      }
      try {
        if (argument === undefined) describeSandbox(id);
        else if (argument === "default") await switchSandbox(id, readSandboxPreference(), true);
        else await switchSandbox(id, argument as SandboxPreference, false);
      } catch (error) {
        surface.writeTo(id, `Tesota could not switch where commands run: ${error instanceof Error ? error.message : "unknown error"}.`,
          "warning");
      }
    },
  };
  /** The answer check's full review: the main reviewer, then the refuter on any gap; never throws. */
  const reviewAnswer = async (id: string, input: ReviewInput, signal: AbortSignal): Promise<ReviewReport[]> => {
    surface.reportFor(id, { phase: "reviewing", activity: "Checking the answer against your requests" });
    try {
      const reports = [await createPiReviewer({ target: await openModel(signal, "reviewer") }).review(input, signal)];
      if (signal.aborted || !hasClaimsToTest(reports)) return reports;
      surface.reportFor(id, { phase: "reviewing", activity: "Testing each gap" });
      return await refuteFindings({ target: await openModel(signal, "refuter") }, input, reports, signal)
        .catch(() => applyRefutation(reports, undefined));
    } catch (error) {
      return [{ reviewer: "Tesota reviewer", tree: input.snapshot.tree, status: "incomplete",
        reason: error instanceof Error ? error.message : "the reviewer could not start" }];
    } finally { surface.clearProgressFor(id, "reviewing"); }
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
    if (state !== undefined) await release(state);
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
      freshSessions.add(replacement.id);
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
      if (freshSessions.has(id)) return;
      environmentFor(id).catch((error: unknown) => {
        // The first request prepares again and reports its own outcome; a preparation stopped on purpose says nothing.
        if (states.has(id) && !isAbort(error)) surface.writeTo(id, `${error instanceof Error ? error.message : "The environment could not start."}`, "warning");
      });
    },
    work: (request, origin = "operator") => runOperation(id, async (signal): Promise<WorkResult> => {
      surface.setBranch(sourceBranch());
      try {
        const coding = await codingFor(id, signal);
        const state = stateFor(id);
        // A correction keeps the base the candidate was checked on, so its review sees only the agent's own
        // correction; the operator's newer repository state arrives with their next request (decision 039).
        const notes = [state.note, origin === "operator" ? await updateFromSource(id) : undefined]
          .filter((note) => note !== undefined);
        // A new request makes any earlier review stale, whether or not the work finishes.
        stateFor(id).reviewed = undefined;
        if (origin === "operator") {
          await (await workspaceFor(id)).recordRequest(request);
          try { nameFromRequest(id, request); } catch { /* a session keeps its name when the store cannot save a new one */ }
        }
        const prompt = notes.length === 0 ? request
          : `Tesota context (not written by the user):\n${notes.join("\n\n")}\n\nUser request:\n${request}`;
        state.note = undefined;
        state.explorers?.startTurn();
        state.advisor?.startTurn();
        const result = await coding.run(prompt, signal);
        if (result.status === "unsettled") { blockSession(id); return result; }
        if (result.status !== "completed") return result;
        state.lastReply = result.reply;
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
      const checks = [...await runChecks(await environmentFor(id), workspace, snapshot, commands, signal,
        { baseRuns: state.baseRuns }),
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
      // The plan steps the agent marked done go to the reviewer as claims to check (decision 034).
      const plan = saved(id)?.plan;
      const claimedSteps = (plan ?? []).flatMap((step, index) => step.status === "done"
        ? [{ index: index + 1, step: step.step, ...step.check === undefined ? {} : { check: step.check } }] : []);
      const reports = await reviewCandidate({ id, signal, depth, candidate: snapshot, models,
        input: { checkout: workspace.checkout, requests, snapshot: scope, checks, flags,
          ...(claimedSteps.length === 0 ? {} : { claimedSteps }),
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
      // Each claimed step shows what the review found of it, a judged check, beside the prompt.
      const main = reviews.find((report) => report.status === "completed" && report.obligations !== undefined);
      if (plan !== undefined && main?.status === "completed") showPlan(id, withReview(plan, main.obligations ?? []));
      surface.inspectFor(id, inspectReview({ snapshot, checks, flags, requests, reviews, depth, measurement }));
      await journal(id, workspace, reviewEntry(snapshot, requests, checks, flags, reviews, depth, measurement));
      return { status: "ready", tree: snapshot.tree, changes: snapshot.changes, checks, reviews, requests };
    }),
    assessAnswer: () => runOperation(id, async (signal): Promise<AnswerResult> => {
      const workspace = await workspaceFor(id);
      const state = stateFor(id);
      const snapshot = workspace.snapshot();
      const requests = await workspace.requests();
      const plan = saved(id)?.plan;
      const claimedSteps = (plan ?? []).flatMap((step, index) => step.status === "done"
        ? [{ index: index + 1, step: step.step, ...step.check === undefined ? {} : { check: step.check } }] : []);
      const input = { checkout: workspace.checkout, requests, snapshot, checks: [], flags: [],
        response: state.lastReply ?? "", ...(claimedSteps.length === 0 ? {} : { claimedSteps }) };
      // A cheap first pass spares the reviewer a turn with nothing to check (decision 034); off, every answer is checked.
      surface.reportFor(id, { phase: "reviewing", activity: "Deciding whether the answer needs checking" });
      const triage = await firstPass(requests, state.lastReply ?? "", signal);
      if (signal.aborted) { surface.clearProgressFor(id, "reviewing"); return { status: "cancelled" }; }
      if (!runsAnswerCheck(triage.decided, triage.checkable)) {
        surface.clearProgressFor(id, "reviewing");
        workspace.keepRequestsOpen(false);
        return { status: "assessed", reviews: [], requests };
      }
      const reports = await reviewAnswer(id, input, signal);
      if (signal.aborted) return { status: "cancelled" };
      const main = reports.find((report) => report.status === "completed");
      // A request stays pending while its check left it not held or uncertain, or could not run.
      const settled = main?.status === "completed" && (main.obligations ?? []).every((item) =>
        obligationOutcome(item.status, item.standing ?? "untested") === "held");
      workspace.keepRequestsOpen(!settled);
      if (plan !== undefined && main?.status === "completed") showPlan(id, withReview(plan, main.obligations ?? []));
      surface.inspectFor(id, inspectAnswer(requests, reports));
      await journal(id, workspace, reviewEntry(snapshot, requests, [], [], reports));
      return { status: "assessed", reviews: reports, requests };
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
        workspace.keepRequestsOpen(false);
        if (saved(id)?.plan !== undefined) showPlan(id, undefined);
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
      workspace.keepRequestsOpen(false);
      if (saved(id)?.plan !== undefined) showPlan(id, undefined);
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
    sessionSandbox,
    abortActive: () => { for (const controller of activeOperations.values()) controller.abort(); },
    dispose: async () => {
      titling.abort();
      const released = [...states.values()].map(release);
      // A release that hangs must not keep Tesota from exiting; the next session's sweep removes what it left.
      await Promise.race([Promise.allSettled(released), new Promise((settle) => { setTimeout(settle, RELEASE_TIME_LIMIT_MS).unref(); })]);
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
    // The caller exits the process on return, which would abandon a release still under way.
    await dependencies.dispose?.();
    surface.stop();
  }
}
