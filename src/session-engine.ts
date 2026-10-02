import type { DiffSources } from "./tesota-shell-result.js";
import { workingTreeDiff } from "./working-diff.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { confinesCommands, type ExecutionEnvironment, type PreparationStep } from "./execution-environment.js";
import { readSandboxPreference, releaseWorkspace, repositoryKey, SANDBOX_NAMES, SANDBOX_PREFERENCES,
  type SandboxPreference, type SessionExecution } from "./execution-providers.js";
import { hostProvider } from "./host-environment.js";
import type { AgentActivity } from "./integrations/model-session-contract.js";
import { type ModelAccess, type ModelTarget, openModelTarget, sameAccount, startWorkingAgent, type WorkingAgent } from "./integrations/model-session.js";
import { HOSTED_SEARCH_KINDS, ROLE_OFF, type ModelRole, parseModelChoice, readModelChoices, ROUTE_ENGINE } from "./model-roles.js";
import { type WorkPlan, withReview } from "./work-plan.js";
import { isGitRepository, largeUntrackedFiles, largeUntrackedWarning, pathKey } from "./source-shadow.js";
import { hiddenFilesIn } from "./secret-files.js";
import { type RevertedTurn, SourceSession } from "./source-session.js";
import { dataNotice, offeredChoices, offeredModels, type OfferedModel, routeListing } from "./models-command.js";
import { handoffBrief, hasHistory, openFindings, type SessionHistory } from "./handoff-brief.js";
import { describeJudgeWarnings, judgeWarnings } from "./judge-warnings.js";
import { modelSwitch, needsBrief } from "./verification/model-switch.js";
import { removeClaudeTranscripts } from "./claude-code-transcripts.js";
import { commandPlace, needsConfirmation, nextMode, type PermissionMode } from "./verification/permission-mode.js";
import { installsDeclaredTools, toolchainStep } from "./verification/toolchain-refresh-rule.js";
import { planToolchain } from "./toolchain.js";
import { currentBranch } from "./repository-git.js";
import { askExplorer, askPageReader } from "./integrations/pi-explorer.js";
import type { WebAccess } from "./integrations/web-tools.js";
import { fetchPage, pinnedGet, resolveHost } from "./web-fetch.js";
import { readWebSearch, type WebSearch } from "./web-search.js";
import { KEYLESS_SEARCH } from "./integrations/keyless-search.js";
import { hostedSearch } from "./integrations/hosted-search.js";
import { ExplorerPool } from "./integrations/pi-explore.js";
import { Advisor } from "./integrations/advisor.js";
import { hasContracts } from "./integrations/prove-tool.js";
import { consultAdvisor } from "./integrations/advisor-session.js";
import { Semaphore } from "./semaphore.js";
import { type ShellSessionRecord, type ShellSessionStore } from "./shell-session-store.js";
import { type SessionDecisions } from "./session-decisions.js";
import { type AnswerResult, type ApplyResult, type CorrectionContext, type RefreshResult, type RequestOrigin, type ReviewResult, type TesotaShellDependencies,
  type WholeChecksResult, type WorkPlace, type WorkResult } from "./tesota-shell.js";
import { inspectAnswer, inspectReview, type ReviewRecord } from "./tesota-shell-inspection.js";
import { runsRelatedForm } from "./verification/check-scope-rule.js";
import { runsAnswerCheck, triageOutcome } from "./verification/answer-check-rule.js";
import { activityBy, attributed } from "./review-attribution.js";
import type { TriageDecision } from "./integrations/answer-triage.js";
import { answerHeld, firstPass, reviewAnswer } from "./answer-check.js";
import { nameSession } from "./integrations/session-namer.js";
import { seedTitle } from "./session-title.js";
import type { TesotaShellTerminal } from "./tesota-shell-terminal.js";
import { UnsupportedSourceChange } from "./source-snapshot.js";
import { Workspace, type WorkspaceSnapshot, type WorkspaceUpdate } from "./workspace.js";
import { applyWorkspace, type ApplicationPathState, ApplyConflictError, ApplyRecoveryError, ApplyRolledBackError,
  unfinishedApplications } from "./workspace-apply.js";
import { approvedCheckText, type BaseRuns, type CheckOptions, runChecks, suggestChecks } from "./workspace-checks.js";
import { flagVerificationChanges } from "./verification-changes.js";
import { runLemmaScriptVerifier } from "./verification/lemmascript-verifier.js";
import { runOxlintVerifier } from "./verification/oxlint-verifier.js";
import { applicableLenses, createPiReviewer } from "./integrations/pi-reviewer.js";
import { importsAuthority, parseSensitivePaths, reviewDepth, SENSITIVE_PATHS_FILE, type DepthDecision,
  type Sensitivity } from "./review-depth.js";
import { createClaimCheckReviewer } from "./integrations/pi-claimcheck.js";
import { applyRefutation, hasClaimsToTest, refuteFindings } from "./integrations/pi-refuter.js";
import { attributeOrigins } from "./finding-origin.js";
import { forecastLine, type ReviewMeasurement, type ReviewModels, type ReviewPlan } from "./review-forecast.js";
import { countsAsMeasurement } from "./verification/review-estimate.js";
import { formatTokens, type TokenUsage, totalTokens } from "./token-usage.js";
import { validateFixes, validationReport } from "./integrations/pi-fix-validator.js";
import type { ReviewInput, ReviewReport, Reviewer, ToolCallRecord } from "./review.js";
import { appendAssurance, checksEntry, correctionEntry, decisionEntry, openAssurance, reviewEntry, triageEntry,
  type AssuranceEntry, type OpenAssurance } from "./assurance-journal.js";

export type SessionWork = Omit<TesotaShellDependencies, "write" | "decisions" | "report">;

/** How long quitting waits for the sessions' environments to be released, such as the WSL sandbox's process and proxy. */
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

export interface TurnCommands {
  keep(id: string): Promise<void>;
  /** `args` is empty, `["all"]` or `["agent"]`. */
  revert(id: string, args: readonly string[]): Promise<void>;
  redo(id: string): Promise<void>;
  /** Work in an isolated workspace instead of the operator's files; only before the session has work. */
  isolate(id: string): Promise<void>;
  /** `/verify`: the full check of the latest answer the first pass skipped, as the operator asks. */
  verify(id: string): Promise<void>;
}

export interface SessionSandboxCommands {
  /** Show where the session's commands run, or switch it to a sandbox choice, or `default`. */
  change(id: string, argument: string | undefined): Promise<void>;
}

/** The operator's permission mode for a session (Read only, Accept edits, Full access), cycled with Shift+Tab. */
export interface PermissionModeCommands {
  /** Switch the session to the next mode; entering Full access asks first, once per session. */
  cycle(id: string): Promise<void>;
  /** Show the session's mode, and where its commands run once known, under the prompt. */
  show(id: string): void;
  /** Show the mode of a session the shell opens, reminding the operator when it opens in Full access. */
  open(id: string): void;
}

export interface AgentModelCommands {
  /** Show the agent's model and the offered ones, or switch to `route:model`, or `default`. */
  change(id: string, argument: string | undefined): Promise<void>;
  /** Start the agent's conversation afresh on the same model. */
  handOff(id: string): Promise<void>;
}

/**
 * A permission mode as the footer names it, marked with Tesota's prompt chevron: a dot for Read only, where nothing
 * runs without asking, and one more chevron for each step of what does.
 */
const MODE_NAMES: Readonly<Record<PermissionMode, string>> = { "read-only": "· read only on",
  "accept-edits": "›› accept edits on", "full-access": "››› full access on" };

/**
 * The footer's line: the mode, then where commands run once the session's
 * environment is chosen, which sandbox or "this computer"; full access runs
 * them on this computer (proved: `commandPlace`). The place is the host
 * whenever commands reach this computer, for the footer's caution color.
 */
export function executionLabel(mode: PermissionMode, execution: SessionExecution | undefined):
  { readonly label: string; readonly place: SessionExecution["commands"] } {
  const sandboxed = execution === undefined ? mode !== "full-access" : execution.commands === "sandbox";
  if (commandPlace(mode, sandboxed) === "computer") {
    return { label: `${MODE_NAMES[mode]} · this computer${mode === "full-access" ? "" : " · asks first"}`, place: "host" };
  }
  if (execution?.commands !== "sandbox") return { label: MODE_NAMES[mode], place: "sandbox" };
  return { label: `${MODE_NAMES[mode]} · sandbox · ${SANDBOX_NAMES[execution.provider.name]?.label ?? execution.provider.name}`,
    place: "sandbox" };
}

/** What the agent is told when the operator's mode changes: what it may do now, and what not to try. */
function modeNote(mode: PermissionMode, sandboxed: boolean): string {
  if (mode === "read-only") {
    return "Note: the user's mode is now Read only. Your edit and write tools refuse, and every command asks the user first. " +
      "Investigate, answer and propose changes; do not try to change files another way, such as with commands.";
  }
  if (mode === "full-access") {
    return "Note: the user's mode is now Full access. Your commands run on the user's computer without asking, with their " +
      "programs, credentials and network, outside any sandbox; files hidden from your file tools are not hidden from them. " +
      "Read hidden files only when the task needs them, and do not change anything outside this repository unless asked.";
  }
  return `Note: the user's mode is now Accept edits. You may edit files; ${sandboxed
    ? "commands run in the sandbox without asking, and run_on_computer asks the user"
    : "each command asks the user first, unless a rule they saved allows it"}.`;
}

/** Where commands run, as a phrase: "in the WSL sandbox", or "on this computer" for the host. */
function executionPlace(execution: SessionExecution): string {
  if (execution.commands === "host") return "on this computer, which asks before each command";
  return `in ${SANDBOX_NAMES[execution.provider.name]?.described ?? execution.provider.name}`;
}

/** Why a named sandbox is not in use here: its missing steps, the controls that failed on this computer, or what it does not confine. */
function unavailableReason(execution: SessionExecution): string {
  if (execution.commands === "sandbox") return "";
  return execution.missing.flatMap((entry) => {
    const failed = entry.qualification?.results.filter((result) => !result.passed) ?? [];
    if (failed.length > 0) return failed.map((result) => `its controls failed on this computer (${result.detail})`);
    if (entry.unconfined !== undefined) return [`it is ready, but ${entry.unconfined}`];
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


/** A shell that stopped while applying leaves its application unfinished (decision 042); say so in the stopped sessions. */
function noticeUnfinishedApplications(cwd: string, stopped: readonly string[],
  surface: Pick<TesotaShellTerminal, "writeTo">): void {
  if (stopped.length === 0) return;
  void unfinishedApplications(cwd).catch(() => []).then((unfinished) => {
    if (unfinished.length === 0) return;
    for (const id of stopped) {
      surface.writeTo(id, "An application to this repository did not finish. Run tesota recover to undo or " +
        "finish it; nothing can be applied until then.", "warning");
    }
  });
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

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** One shell session's workspace, agent conversation and pending review. */
/** Keeps a turn's tool call as Tesota saw it start and finish; a call that never finished stays unfinished. */
export function recordCall(calls: Map<string, ToolCallRecord>, activity: AgentActivity): void {
  if (activity.type === "tool_started") calls.set(activity.call, { tool: activity.tool, subject: activity.subject, outcome: "unfinished" });
  if (activity.type !== "tool_finished") return;
  const started = calls.get(activity.call);
  if (started !== undefined) calls.set(activity.call, { ...started, outcome: activity.failed ? "failed" : "succeeded" });
}

/** What a session works in: an isolated workspace, or the operator's own files through the source's shadow. */
type Work = Workspace | SourceSession;

/** A saved session's work, opened as what its record says it is. */
function openWork(directory: string): Promise<Work> {
  return existsSync(join(directory, "session.json")) ? SourceSession.open(directory) : Workspace.open(directory);
}

/** What a review judges: every pending change in a workspace; in the source, the turns since the last review of changes (#249). */
function candidateIn(work: Work, open: OpenAssurance): WorkspaceSnapshot {
  return work.place === "source" ? work.candidate(open.reviewed) : work.snapshot();
}

/** The paths the agent's own file tools wrote, relative to `root` with forward slashes. */
export function agentWrites(calls: Iterable<ToolCallRecord>, root: string): string[] {
  const written = new Set<string>();
  for (const call of calls) {
    if ((call.tool !== "edit" && call.tool !== "write") || call.outcome !== "succeeded" || call.subject.length === 0) continue;
    const path = relative(root, resolve(root, call.subject.replace(/^@/u, ""))).split(sep).join("/");
    if (path.length > 0 && !path.startsWith("..")) written.add(path);
  }
  return [...written];
}

class SessionState {
  workspace: Promise<Work> | undefined;
  /** Where the session works, once its first request opened its work. */
  place: WorkPlace | undefined;
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
  /** The agent's run in progress, which the operator may steer, and the recording of each request steered into it. */
  running: { readonly agent: WorkingAgent; readonly work: Work; readonly steered: Promise<void>[] } | undefined;
  /** Sites the operator allowed or refused for this session's page reading (decision 024). */
  readonly webAllowed: Set<string> = new Set();
  readonly webDenied: Set<string> = new Set();
  reviewed: WorkspaceSnapshot | undefined;
  /** The latest review as its panel shows it, so the whole commands' run can take the place of their related forms. */
  lastReview: ReviewRecord | undefined;
  /** How failing checks ended on the base, so correction rounds on the same base do not run it again (decision 039). */
  readonly baseRuns: BaseRuns = new Map();
  /** Context the agent needs with the next request, such as a rejected change. */
  note: string | undefined;
  /** The agent's last reply, which the answer check reads when a turn changes no files (decision 034). */
  lastReply: string | undefined;
  /** The latest answer the first pass skipped, which `/verify` checks in full until a new turn begins. */
  unverified: Readonly<{ input: ReviewInput; requests: readonly string[]; triage: Readonly<{ model: string; decision: TriageDecision }> }> | undefined;
  /** The latest turn's tool calls by call id, as Tesota saw them, for the answer check to hold the reply to. */
  readonly turnCalls: Map<string, ToolCallRecord> = new Map();
  /** The hidden files the agent was last told of, so it hears again only when they change. */
  toldHidden: string | undefined;
  /** The repository's toolchain declaration the sandbox was set up for, or last asked about (decision 048). */
  toolchain: string | undefined;
  /** The mode the agent was last told of; undefined while its system prompt's, accept edits, holds. */
  toldMode: PermissionMode | undefined;
  /** Whether the operator confirmed Full access in this session, which is asked once. */
  fullAccessConfirmed = false;
  /** Commands Full access let run without asking in the current turn, which the operator is told of when it ends. */
  fullAccessCommands = 0;
}

/** Where a session's work shows: the part of the shell's surface the engine writes to, which a run without a terminal also provides. */
export type SessionOutput = Pick<TesotaShellTerminal, "writeTo" | "replyTo" | "reportFor" | "clearProgressFor" | "inspectFor" |
  "showActivity" | "setSessionExecution" | "setSessionPlan" | "setBranch" | "setSessionModel" | "setSessionTitle" | "blockSession" |
  "setSessionUndecided" | "showTriage">;

export interface SessionEngineOptions {
  readonly cwd: string;
  /** The repository's saved sessions; whoever opened it closes it. */
  readonly store: ShellSessionStore;
  readonly output: SessionOutput;
  /** Who answers each session's decisions: the operator at its prompt, or a stated policy. */
  readonly decisions: (id: string) => SessionDecisions;
  readonly chooseExecution: (preference: SandboxPreference) => Promise<SessionExecution>;
  /** Sessions created in this run that have not had a request, which prepare nothing until their first. */
  readonly fresh: ReadonlySet<string>;
  /**
   * Each session's permission mode, read at every edit and command; absent, every session runs in accept edits, as a
   * run without a terminal does, and the mode cannot be switched.
   */
  readonly mode?: (id: string) => PermissionMode;
}

/** What the engine offers the shell and a run without a terminal: each session's work and the commands on it. */
export interface SessionEngine {
  readonly session: (id: string) => SessionWork;
  readonly turnCommands: TurnCommands;
  /** Show a restored session's undecided turns in the operator's files, read from its record without starting work. */
  showUndecided(id: string): Promise<void>;
  /** The Diff tab's live sources for a session, read without starting work. */
  diffSources(id: string): Promise<DiffSources>;
  readonly agentModel: AgentModelCommands;
  readonly sessionSandbox: SessionSandboxCommands;
  readonly permissionMode: PermissionModeCommands;
  /** `/checks [reset]`: the repository's approved checks and the hidden files they may read. */
  showChecks(id: string, args: readonly string[]): void;
  /** Name a session from its requests in the background, as the `namer` role writes it (decision 036). */
  name(id: string, requests: readonly string[], source: "generated" | "operator"): void;
  /** The routes' models, read once. */
  offered(): readonly OfferedModel[];
  /** The size of the session agent's conversation, once it has started. */
  contextTokens(id: string): number | undefined;
  /** Stop a session's running work. */
  interrupt(id: string): void;
  /**
   * Send the operator's message to the agent while it works, as a request of
   * the turn in progress; false when no agent is running or its engine cannot
   * take one mid-run.
   */
  steer(id: string, text: string): boolean;
  abortActive(): void;
  /** Whether a session is working or applying, when it cannot close. */
  busy(id: string): boolean;
  /** Pending changes in a session's existing work; never creates it. */
  pendingChanges(id: string): Promise<number>;
  /** Remove a closed session's engine, transcript, workspace and record. */
  discard(id: string, record: ShellSessionRecord): Promise<void>;
  /** Release every session's environment, within a time limit. */
  dispose(): Promise<void>;
}

/** The session's agent model: the one its conversation runs on, or for a new agent the operator's choice for the role. */
export function sessionAgentModel(store: ShellSessionStore, id: string): string {
  return store.list().find((session) => session.id === id)?.agent ?? readModelChoices().agent;
}

/**
 * Every session of one repository: its work, environment, agent, checks,
 * review and application, and the commands on it, writing to `output` and
 * asking `decisions`. The shell and a run without a terminal share it.
 */
export function createSessionEngine({ cwd, store, output, decisions, chooseExecution, fresh, mode }: SessionEngineOptions):
  SessionEngine {
  const modeOf = (id: string): PermissionMode => mode?.(id) ?? "accept-edits";
  // Sessions share one choice per shell, since readiness takes some seconds; qualification is kept on disk. The
  // operator naming a sandbox with /sandbox checks again, so a sandbox that stopped being ready since is not reused.
  const executionChoices = new Map<SandboxPreference, Promise<SessionExecution>>();
  const executionFor = (preference: SandboxPreference, checkAgain = false): Promise<SessionExecution> => {
    let choice = checkAgain ? undefined : executionChoices.get(preference);
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
  const piSessionsDirectory = join(homedir(), ".tesota", "pi-sessions",
    createHash("sha256").update(pathKey(resolve(cwd))).digest("hex"));
  /** Sessions writing to the source repository; they cannot be closed until it settles. */
  const applying = new Set<string>();
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
  const agentChoice = (id: string): string => sessionAgentModel(store, id);
  let offeredCache: readonly OfferedModel[] | undefined;
  /** The routes' models, read once: the catalogues ship with Tesota and do not change while it runs. */
  const offered = (): readonly OfferedModel[] => { offeredCache ??= offeredModels(); return offeredCache; };
  const savedSessions = store.list();
  /** The agent's plan (decision 033), shown and saved; undefined when the work it planned ends. */
  const showPlan = (id: string, plan: WorkPlan | undefined): void => {
    store.setPlan(id, plan);
    output.setSessionPlan(id, plan);
  };
  /** Whether the shell works on a Git repository or a plain folder, decided once. */
  const sourceKind = isGitRepository(cwd) ? "repository" as const : "folder" as const;
  /** The source repository's branch; a plain folder has none. */
  const sourceBranch = (): string | undefined => sourceKind === "repository" ? currentBranch(cwd) : undefined;
  output.setBranch(sourceBranch());
  for (const session of savedSessions) {
    if (session.interrupted) {
      output.writeTo(session.id, "The previous shell stopped during work. Pending changes stay where the session left them.");
      store.markActive(session.id, false);
    }
    if (session.blocked) {
      output.blockSession(session.id);
      output.writeTo(session.id, "This session stopped with unresolved effects. Check your repository and start a new session.", "warning");
    }
  }
  noticeUnfinishedApplications(cwd, savedSessions.filter((session) => session.interrupted || session.blocked)
    .map((session) => session.id), output);
  const saved = (id: string): ReturnType<ShellSessionStore["list"]>[number] | undefined =>
    store.list().find((session) => session.id === id);
  const stateFor = (id: string): SessionState => {
    let state = states.get(id);
    if (state === undefined) { state = new SessionState(); states.set(id, state); }
    return state;
  };
  /** The session's mode and, once chosen, where its commands run, under the prompt. */
  const showExecution = (id: string): void => {
    const { label, place } = executionLabel(modeOf(id), states.get(id)?.execution);
    output.setSessionExecution(id, label, place);
  };
  /** The session that works in the operator's files; one at a time may, and others get an isolated workspace. */
  let sourceHolder: string | undefined;
  const holdsSource = (id: string): boolean => sourceHolder === id || sourceHolder === undefined &&
    !store.list().some((session) => session.id !== id && session.workspace !== null && existsSync(join(session.workspace, "session.json")));
  /** Why a session works in a copy: a folder always does, and a repository's session by choice or because another holds it. */
  const whyCopy = (chosen: boolean): string => sourceKind === "folder" ? "Tesota works on a copy of this folder"
    : chosen ? "This session works in an isolated copy, as you chose"
      : "Another session works in your files, so this one works in an isolated copy";
  const workspaceFor = (id: string): Promise<Work> => {
    const state = stateFor(id);
    if (state.workspace !== undefined) return state.workspace;
    const pending = (async (): Promise<Work> => {
      const directory = saved(id)?.workspace;
      if (directory !== null && directory !== undefined) {
        try {
          const work = await openWork(directory);
          state.place = work.place === "source" ? "source" : "workspace";
          if (work.place === "source") sourceHolder = id;
          return work;
        } catch { store.rotateEngine(id); }
      }
      // A folder of documents keeps "nothing changes until you apply": its people are not developers, and Office
      // locks open files. A repository works in place, one session at a time, unless the session chose isolation.
      // Decided before any wait, so two sessions starting together cannot both take the operator's files.
      const chosen = saved(id)?.isolated === true;
      const inSource = sourceKind === "repository" && !chosen && holdsSource(id);
      if (inSource) sourceHolder = id;
      const work = inSource ? await SourceSession.create(cwd, undefined, { kind: sourceKind })
        : await Workspace.create(cwd, undefined, { kind: sourceKind });
      state.place = work.place === "source" ? "source" : "workspace";
      store.setWorkspace(id, work.directory);
      if (!inSource) {
        output.writeTo(id, `${whyCopy(chosen)}: nothing in your files changes until you apply its reviewed result.`);
      }
      const workspace = work;
      if (workspace.place !== "source" && workspace.included.length > 0) {
        output.writeTo(id, `The workspace includes your ${workspace.included.length} uncommitted ` +
          `${workspace.included.length === 1 ? "change" : "changes"}. Later edits in your repository are not visible to the agent.`);
      }
      // A repository is recorded without asking, so large untracked files, read before every request, are named instead.
      const large = sourceKind === "repository" ? largeUntrackedWarning(await largeUntrackedFiles(work.source)) : undefined;
      if (large !== undefined) output.writeTo(id, large, "warning");
      return work;
    })();
    return remember(pending, () => state.workspace, (value) => { state.workspace = value; });
  };
  const environmentFor = (id: string): Promise<ExecutionEnvironment> => {
    const state = stateFor(id);
    if (state.environment !== undefined) return state.environment;
    const preparation = new AbortController();
    state.preparation = preparation;
    const pending = (async () => {
      // The first choice on a machine qualifies the sandbox there, which takes some seconds.
      output.reportFor(id, { phase: "preparing", activity: "Choosing where commands run" });
      const [workspace, execution] = await Promise.all([workspaceFor(id), executionFor(sandboxPreference(id))]);
      state.execution = execution;
      showExecution(id);
      if (execution.commands === "host") {
        output.writeTo(id, "Commands ask before running and run on this computer without isolation. " +
          "Run tesota setup to see what sandboxed sessions need.", "warning");
      }
      let environment: ExecutionEnvironment;
      output.reportFor(id, { phase: "preparing" });
      try {
        environment = await execution.provider.prepare(workspace.checkout,
          { onProgress: (activity) => { output.reportFor(id, { phase: "preparing", activity }); },
            repository: repositoryKey(cwd), allowed: store.allowedNetwork(), signal: preparation.signal });
      } catch (error) {
        if (preparation.signal.aborted) throw new DOMException("preparation stopped", "AbortError");
        throw new Error(`The ${execution.provider.name} environment could not start` +
          `${error instanceof Error ? `: ${error.message}` : ""}. Run tesota setup to check it.`);
      } finally { output.clearProgressFor(id, "preparing"); }
      const remembered = store.allowedNetwork();
      if (remembered.length > 0 && environment.network !== undefined) {
        output.writeTo(id, `Also allowed for this repository: ${remembered.join(", ")}.`);
      }
      const summary = describePreparation(environment.preparation);
      if (summary !== undefined) {
        const failed = environment.preparation.some((step) => step.outcome === "failed");
        output.writeTo(id, summary, failed ? "warning" : "info");
        if (failed) state.note = [state.note, `Note: ${summary}`].filter((note) => note !== undefined).join("\n\n");
      }
      state.toolchain = planToolchain(workspace.checkout).fingerprint;
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
      if (title !== undefined && store.setTitle(id, title, source)) output.setSessionTitle(id, title);
    })().catch(() => undefined);
  };
  /** The operator's first request names a new session at once, and a model's title follows. */
  const nameFromRequest = (id: string, request: string): void => {
    const seed = seedTitle(request);
    if (seed === undefined || !store.setTitle(id, seed, "request")) return;
    output.setSessionTitle(id, seed);
    nameInBackground(id, [request], "generated");
  };
  /**
   * The model a helper tool of the agent runs on, read when it starts, as each helper reads its own: the advisor, the
   * explorers, and the page reader, which runs on the explorers' model when they are on and the agent's otherwise.
   */
  const helperModel = (tool: string): string | undefined => {
    try {
      const choices = readModelChoices();
      if (tool === "advisor") return choices.advisor;
      if (tool === "explore") return choices.explorer;
      if (tool === "web_read") return choices.explorer === ROLE_OFF ? choices.agent : choices.explorer;
    } catch { return undefined; }
    return undefined;
  };
  /** The first pass on the triage role's current choice, with the model it used. */
  const firstPassNow = async (id: string, requests: readonly string[], reply: string, signal: AbortSignal):
    Promise<Readonly<{ model: string; decision: TriageDecision }>> => {
    let model = "unknown";
    try { model = readModelChoices().triage; } catch { return { model, decision: { decided: false, checkable: true,
      reason: "the first pass failed" } }; }
    output.reportFor(id, { phase: "reviewing", activity: activityBy("Deciding whether the answer needs checking", "triage", model) });
    return { model, decision: await firstPass(model, requests, reply, signal) };
  };
  /** The model for one of the review step's sessions, counting its tokens toward the step. */
  const modelFor = async (run: ReviewRun, role: ModelRole): Promise<ModelAccess> =>
    ({ target: await openModel(run.signal, role), onUsage: run.onUsage });
  /** In a correction round, whether each finding sent back is resolved; a validator that cannot run settles nothing. */
  const validateCorrection = async (run: ReviewRun): Promise<ReviewReport | undefined> => {
    const sentBack = run.input.correction?.sentBack ?? [];
    if (sentBack.length === 0) return undefined;
    output.reportFor(run.id, { phase: "reviewing", activity: activityBy("Checking each fix", "validator", run.models.validator) });
    try {
      return { ...await validateFixes(await modelFor(run, "validator"), run.input, sentBack, run.signal), model: run.models.validator };
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
    const plan: ReviewPlan = { depth: run.depth.depth, correction: run.input.correction !== undefined, reasons: run.depth.reasons,
      models: run.models,
      lenses: run.depth.depth === "deep" ? applicableLenses(run.input.checkout).map((lens) => lens.name) : [],
      claimcheck: run.input.checks.some((check) => check.verifier === "lemmascript" && check.outcome === "passed") };
    if (plan.depth === "deep") output.writeTo(run.id, forecastLine(plan, store.reviewMeasurements()));
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
    output.reportFor(id, { phase: "reviewing",
      activity: activityBy(plan.depth === "deep" ? "Deep review" : "Reviewing", "reviewer", run.models.reviewer) });
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
    const reports = attributed(attributeOrigins(await Promise.all(reviewers.map((reviewer) => reviewer.review(input, signal)
      .catch((error: unknown): ReviewReport => ({ reviewer: reviewer.name, tree: input.snapshot.tree, status: "incomplete",
        reason: error instanceof Error ? error.message : "the reviewer failed" })))), run.candidate), { reviewer: run.models.reviewer });
    if (signal.aborted || !hasClaimsToTest(reports)) return reports;
    output.reportFor(id, { phase: "reviewing", activity: activityBy("Testing each finding and gap", "refuter", run.models.refuter) });
    try {
      return attributed(await refuteFindings(await modelFor(run, "refuter"), input, reports, signal),
        { reviewer: run.models.reviewer, refuter: run.models.refuter });
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
      output.reportFor(id, { phase: "awaiting_command" });
      const decision = await decisions(id).site(host);
      output.reportFor(id, { phase: "working" });
      if (decision === "deny") { state.webDenied.add(host); return "denied"; }
      if (decision === "repository") store.allowNetwork([destination]);
      state.webAllowed.add(host);
      return "allowed";
    };
    // The searcher's own search, when its route has one; it reads its model when a search starts.
    const searcher = readModelChoices().searcher;
    const searcherKind = parseModelChoice(searcher)?.kind;
    const hosted = searcherKind !== undefined && HOSTED_SEARCH_KINDS.includes(searcherKind)
      ? hostedSearch(searcher, (signal) => openModel(signal, "searcher")) : undefined;
    let search: WebSearch;
    // The first search that would go to a keyless provider asks, as a site does before its first page.
    const ask = async (providers: readonly string[]) => {
      output.reportFor(id, { phase: "awaiting_command" });
      try { return await decisions(id).keylessSearch(providers); } finally { output.reportFor(id, { phase: "working" }); }
    };
    try { search = readWebSearch({ hosted, keyless: KEYLESS_SEARCH, ask }); } catch (error) {
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
  const sessionHistory = async (id: string, workspace: Work): Promise<SessionHistory> => {
    const snapshot = workspace.snapshot();
    let review: SessionHistory["review"];
    try {
      const open = (await openAssurance(workspace.directory)).review;
      if (open !== undefined) review = { current: open.tree === snapshot.tree, findings: openFindings(open.reviews) };
    } catch {
      output.writeTo(id, "Tesota could not read the last review from the workspace's journal; the brief leaves its findings out.", "warning");
    }
    const lastReply = saved(id)?.entries.findLast((entry) => entry.kind === "agent")?.text;
    return { requests: await workspace.requests(), changes: snapshot.changes, review, lastReply };
  };
  /** An agent that starts a new conversation in a session with history gets the brief with the next request, shown whole. */
  const briefNewConversation = async (id: string, agent: WorkingAgent, workspace: Work): Promise<void> => {
    if (agent.resumed) return;
    const history = await sessionHistory(id, workspace);
    const brief = handoffBrief(history);
    if (!needsBrief(agent.resumed, hasHistory(history)) || brief === undefined) return;
    const state = stateFor(id);
    state.note = [brief, state.note].filter((note) => note !== undefined).join("\n\n");
    output.writeTo(id, `The agent starts a new conversation and does not have the earlier one. Tesota sends it this brief with your request:\n${brief}`);
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
      output.setSessionModel(id, choice);
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
        // Measured in #294: the guidance and `prove` let the agent finish with its contracts proved.
        ...hasContracts(workspace.checkout) ? { proofs: "tool" as const } : {},
        sandboxed: confinesCommands(environment.guarantees), place: workspace.place === "source" ? "source" : "copy",
        // A sandboxed agent may ask to run one command here, with the operator's own tools and logins (decision 049).
        ...confinesCommands(environment.guarantees) ? { computer: await hostProvider.prepare(workspace.checkout) } : {},
        commandRules: () => store.commandRules(),
        mode: () => modeOf(id),
        onFullAccessCommand: () => { stateFor(id).fullAccessCommands += 1; },
        beforeSandboxCommand: () => installDeclaredTools(id, workspace.checkout),
        approveCommand: async (request) => {
          output.reportFor(id, { phase: "awaiting_command" });
          const approval = await decisions(id).command(request);
          output.reportFor(id, { phase: "working" });
          if (approval === "rule" && request.rule !== undefined) store.saveCommandRule(request.rule);
          return approval;
        },
        decideNetwork: async (destinations) => {
          output.reportFor(id, { phase: "awaiting_command" });
          const decision = await decisions(id).network(destinations);
          output.reportFor(id, { phase: "working" });
          if (decision === "repository") store.allowNetwork(destinations);
          return decision;
        },
        plan: (plan) => { showPlan(id, plan); },
        // The plan shows beside the prompt, so its tool calls stay out of the conversation.
        onActivity: (activity) => {
          if (activity.type === "tool_started" && activity.tool === "plan") planCalls.add(activity.call);
          if ("call" in activity && planCalls.has(activity.call)) return;
          recordCall(stateFor(id).turnCalls, activity);
          const by = activity.type === "tool_started" ? helperModel(activity.tool) : undefined;
          output.showActivity(id, by === undefined || activity.type !== "tool_started" ? activity : { ...activity, by });
        } }, { sessionManager, conversationId: engineId });
      consulted = agent;
      state.agent = agent;
      // A new conversation knows only its system prompt's mode, accept edits; any other is named with the next request.
      state.toldMode = undefined;
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
    output.setSessionModel(id, choice);
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
    if (same !== "") output.writeTo(id, same, "warning");
    if (lab !== "") output.writeTo(id, lab, "info");
    // A free gateway model may keep the repository's code (decision 031).
    const notice = dataNotice(choice);
    if (notice !== undefined) output.writeTo(id, `Free model: ${notice}. Choose a paid model for code you would not share.`, "warning");
  };
  const agentModel: AgentModelCommands = {
    change: async (id, argument) => {
      let current: string;
      let role: string;
      try { current = agentChoice(id); role = readModelChoices().agent; } catch (error) {
        output.replyTo(id, `${error instanceof Error ? error.message : "The model choices could not be read"}.`, "warning");
        return;
      }
      const models = offered();
      if (argument === undefined) {
        output.replyTo(id, `The agent uses ${current} in this session; new sessions use ${role} (tesota roles agent).\n` +
          "/model <route:model> switches it: on the same engine its conversation continues, on another it starts a new one. " +
          `/model default returns to ${role}. Add @low, @medium, @high, @xhigh or @max for a reasoning level the model ` +
          `accepts. Offered:\n${routeListing(models)}`);
        return;
      }
      const choice = argument === "default" ? role : argument;
      const from = parseModelChoice(current);
      const to = parseModelChoice(choice);
      if (from === undefined || to === undefined || !offeredChoices(models).includes(choice)) {
        output.replyTo(id, `${choice} is not offered. /model lists the models.`, "warning");
        return;
      }
      // Another account needs its own runtime or process, so only a switch within one account continues in place (decision 050).
      switch (modelSwitch(choice === current, ROUTE_ENGINE[from.kind] === ROUTE_ENGINE[to.kind] && sameAccount(from, to))) {
        case "unchanged": output.replyTo(id, `The agent already uses ${current}.`); return;
        case "in_place": {
          try {
            const target = await openModelTarget(choice);
            await (await liveAgent(id))?.switchModel(target);
          } catch (error) {
            output.replyTo(id, `The agent could not switch to ${choice}: ${error instanceof Error ? error.message : "unknown error"}. ` +
              `It still uses ${current}.`, "warning");
            return;
          }
          store.setAgentModel(id, choice);
          output.setSessionModel(id, choice);
          output.writeTo(id, `The agent now uses ${choice}; its conversation continues.`);
          const context = states.get(id)?.agent?.contextTokens();
          // A prompt cache belongs to one model and level; measured on both engines, the next call reads everything anew.
          if (context !== undefined) {
            output.writeTo(id, `The next request re-reads this conversation, about ${formatTokens(context)}, without the ` +
              "prompt cache, which belongs to one model and level; later requests use the cache again. /handoff instead " +
              "starts a new conversation with a short brief.");
          }
          warnJudges(id, choice);
          return;
        }
        case "new_conversation":
          await newConversation(id, choice);
          output.writeTo(id, `The agent now uses ${choice}, which runs on another engine. ${newConversationNote}`);
          warnJudges(id, choice);
      }
    },
    handOff: async (id) => {
      let current: string;
      try { current = agentChoice(id); } catch (error) {
        output.replyTo(id, `${error instanceof Error ? error.message : "The model choices could not be read"}.`, "warning");
        return;
      }
      await newConversation(id, current);
      output.writeTo(id, `The agent stays on ${current}. ${newConversationNote}`);
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
    output.replyTo(id, `${current}; ${own === undefined ? "it follows your choice for new sessions" : `its own choice is ${own}`}, ` +
      `and new sessions use ${readSandboxPreference()} (tesota sandbox).\n` +
      `/sandbox <${SANDBOX_PREFERENCES.join("|")}> switches this session: its environment is prepared again, and the ` +
      "agent restarts with its conversation. /sandbox default follows your choice for new sessions.");
  };
  /** Switch a session to `preference`; a sandbox named outright is used only when it is ready here. */
  const switchSandbox = async (id: string, preference: SandboxPreference, followDefault: boolean): Promise<void> => {
    output.reportFor(id, { phase: "preparing", activity: "Choosing where commands run" });
    let next: SessionExecution;
    try { next = await executionFor(preference, true); } finally { output.clearProgressFor(id, "preparing"); }
    const state = stateFor(id);
    const current = state.execution;
    // A sandbox named outright, never auto or this computer, is used only when it is ready here.
    if (preference !== "auto" && preference !== "host" && next.commands === "host") {
      const name = Object.values(SANDBOX_NAMES).find((entry) => entry.choice === preference)?.described ?? preference;
      output.replyTo(id, `${name.charAt(0).toUpperCase()}${name.slice(1)} is not ready here: ${unavailableReason(next)}. ` +
        `Commands in this session still run ${current === undefined ? "where they did" : executionPlace(current)}. ` +
        "tesota sandbox shows what each sandbox needs.", "warning");
      return;
    }
    store.setSandbox(id, followDefault ? undefined : preference);
    if (followDefault) output.writeTo(id, `This session follows your choice for new sessions (${preference}).`);
    if (current?.provider === next.provider) {
      output.replyTo(id, `Commands in this session already run ${executionPlace(next)}.`);
      return;
    }
    if (state.environment === undefined) {
      output.writeTo(id, `Commands in this session will run ${executionPlace(next)}.`);
      return;
    }
    await restartEnvironment(id);
    stateFor(id).execution = next;
    showExecution(id);
    // The conversation remembers commands from the earlier environment: its paths and shell may no longer apply.
    const earlier = current === undefined ? "" : `; earlier commands in this conversation ran ${executionPlace(current)}, ` +
      "so their paths and tools may differ";
    state.note = [state.note, `Note: Commands now run ${executionPlace(next)}${earlier}.`]
      .filter((note) => note !== undefined).join("\n\n");
    output.writeTo(id, `Commands in this session now run ${executionPlace(next)}. The agent restarts with your next ` +
      "request: its conversation continues, with the tools for where commands now run.");
  };
  const sessionSandbox: SessionSandboxCommands = {
    change: async (id, argument) => {
      if (argument !== undefined && argument !== "default" && !(SANDBOX_PREFERENCES as readonly string[]).includes(argument)) {
        output.replyTo(id, sandboxUsage, "warning");
        return;
      }
      if (argument !== undefined && activeOperations.has(id)) {
        output.replyTo(id, "Stop the current work (Esc) or wait for it before switching where commands run.", "warning");
        return;
      }
      try {
        if (argument === undefined) describeSandbox(id);
        else if (argument === "default") await switchSandbox(id, readSandboxPreference(), true);
        else await switchSandbox(id, argument as SandboxPreference, false);
      } catch (error) {
        output.replyTo(id, `Tesota could not switch where commands run: ${error instanceof Error ? error.message : "unknown error"}.`,
          "warning");
      }
    },
  };
  /** The answer check's full review, showing its progress in the session. */
  const reviewAnswerIn = async (id: string, input: ReviewInput, signal: AbortSignal): Promise<ReviewReport[]> => {
    const { reviewer, refuter } = readModelChoices();
    const models = { reviewer, refuter };
    try {
      return attributed(await reviewAnswer(async (role) => ({ target: await openModel(signal, role) }), input, signal,
        (activity, role) => { output.reportFor(id, { phase: "reviewing", activity: activityBy(activity, role, models[role]) }); }),
      models);
    } finally { output.clearProgressFor(id, "reviewing"); }
  };
  /** `/verify`: the full check of the latest answer the first pass skipped, which a new turn makes stale. */
  const verifyAnswer = async (id: string): Promise<void> => {
    if (activeOperations.has(id) || applying.has(id)) {
      output.replyTo(id, "Wait for the current work to finish, or stop it with Esc.", "warning");
      return;
    }
    const pending = states.get(id)?.unverified;
    if (pending === undefined) {
      output.replyTo(id, "Nothing to verify: /verify runs the full check of the latest answer the first pass skipped.");
      return;
    }
    await runOperation(id, async (signal) => {
      const workspace = await workspaceFor(id);
      const reports = await reviewAnswerIn(id, pending.input, signal);
      if (signal.aborted) return;
      stateFor(id).unverified = undefined;
      workspace.keepRequestsOpen(!answerHeld(reports));
      output.inspectFor(id, inspectAnswer(pending.requests, reports, { ...pending.triage, requested: true }));
      await journal(id, workspace, reviewEntry("answer", pending.input.snapshot, pending.requests, [], [], reports));
    }).catch((error: unknown) => {
      if (!isAbort(error)) output.replyTo(id, `The full check could not run: ${error instanceof Error ? error.message : "unknown error"}.`, "warning");
    });
  };
  const blockSession = (id: string): void => { store.block(id); output.blockSession(id); };
  /**
   * What marks a candidate's paths sensitive (decision 053): the repository's
   * file as the candidate's base declares it, so a change cannot remove its
   * own paths.
   */
  const sensitivityOf = (snapshot: WorkspaceSnapshot, read: (revision: string, path: string) => string | undefined): Sensitivity => {
    const declared = read(snapshot.base, SENSITIVE_PATHS_FILE);
    return { declared: parseSensitivePaths(declared), confirmed: declared !== undefined,
      // Either side counts, so removing an import cannot make a change look less sensitive.
      importsAuthority: (path) => importsAuthority(read(snapshot.base, path)) || importsAuthority(read(snapshot.tree, path)) };
  };
  /** Where the repository's files are read for suggestions: the source, or an isolated session's copy. */
  const checksRoot = (id: string): string => {
    const directory = saved(id)?.workspace;
    return directory === null || directory === undefined || existsSync(join(directory, "session.json")) ? cwd : join(directory, "repo");
  };
  /** Checks are commands the operator approved: they read the hidden files the operator named, and their results say so. */
  const checkOptions = async (id: string, checkout: string): Promise<CheckOptions> => {
    const every = await hiddenFilesIn(checkout);
    const readsHidden = store.checkSecrets().filter((path) => every.includes(path));
    return { baseRuns: stateFor(id).baseRuns, hidden: every.filter((path) => !readsHidden.includes(path)), readsHidden };
  };
  /** Evidence that could not be recorded is reported, never dropped silently. */
  const journal = async (id: string, workspace: Work, entry: AssuranceEntry): Promise<void> => {
    try { await appendAssurance(workspace.directory, entry); } catch (error) {
      output.writeTo(id, `Tesota could not record this in the workspace's assurance journal: ${error instanceof Error ? error.message : "unknown error"}.`, "warning");
    }
  };

  /**
   * What the journal holds open of the pending changes. One that cannot be
   * read leaves no review known, so the next review covers every undecided
   * turn and judges no correction.
   */
  const openAssuranceIn = async (id: string, workspace: Work): Promise<OpenAssurance> => {
    try { return await openAssurance(workspace.directory); } catch {
      output.writeTo(id, "Tesota could not read the last review from the workspace's journal; this review covers every " +
        "undecided change and judges no earlier correction.", "warning");
      return {};
    }
  };
  /** A correction is journaled before the agent starts, so a review after a stop still judges what was sent back (#249). */
  const journalCorrection = async (id: string, workspace: Work, correction: CorrectionContext | undefined): Promise<void> => {
    if (correction !== undefined) await journal(id, workspace, correctionEntry(correction));
  };

  /** Pending changes in a session's existing workspace; never creates one. */
  const pendingChangeCount = async (id: string): Promise<number> => {
    const directory = saved(id)?.workspace;
    const loaded = states.get(id)?.workspace;
    if (loaded === undefined && (directory === null || directory === undefined)) return 0;
    try { return (await (loaded ?? openWork(directory ?? ""))).snapshot().changes.length; }
    catch { return 0; }
  };

  /** Remove a closed session's engine, transcript, workspace and record. */
  const discardSession = async (id: string, record: ShellSessionRecord): Promise<void> => {
    const state = states.get(id);
    states.delete(id);
    if (state !== undefined) await release(state);
    if (sourceHolder === id) sourceHolder = undefined;
    if (record.workspace !== null) {
      let checkout = join(record.workspace, "repo");
      if (existsSync(join(record.workspace, "session.json"))) {
        // Working in the source shares the source's sandbox state with later sessions; only the pinned trees go.
        try {
          const session = await SourceSession.open(record.workspace);
          checkout = session.checkout;
          session.discard();
        } catch { checkout = cwd; }
      } else await releaseWorkspace(checkout);
      // The conversation and those it left behind at a handoff (decision 026).
      for (const engineId of [record.engineId, ...record.retiredEngineIds ?? []]) {
        const transcript = SessionManager.findById(checkout, engineId, piSessionsDirectory);
        if (transcript !== undefined) await rm(transcript, { force: true });
      }
      // On the claude-code routes, Claude Code keeps the same conversations in its own folders, by the same ids.
      await removeClaudeTranscripts([record.engineId, ...record.retiredEngineIds ?? []]).catch(() => 0);
      if (!record.blocked) await rm(record.workspace, { recursive: true, force: true, maxRetries: 3 });
    }
    store.remove(id);
  };

  /**
   * Bring the operator's newer repository state into the workspace before a
   * request, and return what the agent should be told about it.
   */
  const updateFromSource = async (id: string): Promise<string | undefined> => (await bringInSource(id)).note;
  /** Bring the operator's newer repository state into a workspace, and what the agent should be told of it. */
  const bringInSource = async (id: string): Promise<{ status: RefreshResult; note?: string }> => {
    const work = await workspaceFor(id);
    // Working in the source, there is nothing to bring in; the turn names the operator's own edits instead.
    if (work.place === "source") return { status: "current" };
    let update: WorkspaceUpdate;
    try { update = await work.update(); } catch (error) {
      output.writeTo(id, "Could not bring your latest repository changes into the workspace" +
        `${error instanceof UnsupportedSourceChange ? `: ${error.message}` : ""}. The agent works on the earlier state.`, "warning");
      return { status: "failed" };
    }
    if (update.status === "current") return { status: "current" };
    if (update.status === "conflict") {
      output.writeTo(id, "Your repository changed in files that also have pending changes in this workspace:\n" +
        `${update.paths.map((path) => `  ${path}`).join("\n")}\nThe workspace was not updated; apply or reject the pending changes first.`, "warning");
      return { status: "conflict" };
    }
    const files = update.changes.map((change) => `  ${change.status} ${change.path}`).join("\n");
    output.writeTo(id, `Brought ${update.changes.length} newer ${update.changes.length === 1 ? "change" : "changes"} ` +
      `from your repository into the workspace:\n${files}`);
    return { status: "updated",
      note: `Note: the user changed these files in their repository since your last turn; the workspace now includes them:\n${files}` };
  };

  /**
   * Begin a turn in the operator's files, and return what the agent should be
   * told: the files the operator changed since its last turn, if any.
   */
  const beginTurnIn = async (session: SourceSession): Promise<string | undefined> => {
    const previous = session.turns.at(-1)?.after ?? session.base;
    const started = await session.beginTurn();
    if (previous === started) return undefined;
    const changes = session.compare(previous, started).changes;
    if (changes.length === 0) return undefined;
    return `Note: the user changed these files since your last turn:\n${changes.map((change) => `  ${change.status} ${change.path}`).join("\n")}`;
  };
  /**
   * End a turn in the operator's files, and name the files it changed that
   * the agent's own file tools did not write: its commands wrote them, or the
   * operator did meanwhile, which cannot be told apart.
   */
  const endTurnIn = async (id: string, session: SourceSession, origin: RequestOrigin):
    Promise<Awaited<ReturnType<SourceSession["endTurn"]>>> => {
    const written = agentWrites(stateFor(id).turnCalls.values(), session.checkout);
    const ended = await session.endTurn({ written, continues: origin === "tesota" });
    reportUndecided(id, session);
    const outside = ended.changed.map((change) => change.path).filter((path) => !written.includes(path));
    if (outside.length > 0) {
      output.writeTo(id, "Changed outside the agent's file tools, by its commands or by you during the turn; reverting asks " +
        `before it touches them:\n${outside.map((path) => `  ${path}`).join("\n")}`, "warning");
    }
    return ended;
  };

  const pathList = (paths: readonly string[]): string => paths.map((path) => `  ${path}`).join("\n");
  /** A session's undecided turns in the operator's files, and whether a reverted one can be put back, for the shell's decision bar. */
  const reportUndecided = (id: string, work: Work): void => {
    if (work.place !== "source") return;
    const first = work.turns[0];
    const last = work.turns.at(-1);
    output.setSessionUndecided(id, { turns: work.turns.length, redoable: work.redoable !== undefined,
      files: first === undefined || last === undefined ? 0 : work.compare(first.before, last.after).changes.length });
  };
  /**
   * Where the session works, everything uncommitted and its undecided turns together. A session in a copy has the
   * copy's changes, which nothing in the operator's files holds yet; one with no work yet, the repository's own.
   */
  const diffSources = async (id: string): Promise<DiffSources> => {
    const directory = saved(id)?.workspace;
    const loaded = states.get(id)?.workspace;
    let work: Work | undefined;
    if (loaded !== undefined || (directory !== null && directory !== undefined)) {
      try { work = await (loaded ?? openWork(directory ?? "")); } catch { work = undefined; }
    }
    if (work !== undefined && work.place !== "source") return { working: work.snapshot().diff };
    const working = sourceKind === "repository" ? workingTreeDiff(cwd) : undefined;
    const first = work?.turns[0];
    const last = work?.turns.at(-1);
    return { working, undecided: work === undefined || first === undefined || last === undefined ? undefined
      : work.compare(first.before, last.after).diff };
  };
  const showUndecided = async (id: string): Promise<void> => {
    const directory = saved(id)?.workspace;
    const loaded = states.get(id)?.workspace;
    if (loaded === undefined && (directory === null || directory === undefined)) return;
    try { reportUndecided(id, await (loaded ?? openWork(directory ?? ""))); } catch { /* A record that cannot be read shows no bar. */ }
  };
  /** A session's work in the source for the turn commands, or why they do not apply to it now; never creates work. */
  const turnsOf = async (id: string): Promise<SourceSession | string> => {
    if (activeOperations.has(id) || applying.has(id)) return "Wait for the current work to finish, or stop it with Esc.";
    const directory = saved(id)?.workspace;
    if (states.get(id)?.workspace === undefined && (directory === null || directory === undefined)) return "This session has no turns yet.";
    const work = await workspaceFor(id);
    return work.place === "source" ? work
      : "This session works in a copy: its result is applied or rejected after review, never kept or reverted in your files.";
  };
  /** Choose an isolated workspace for a session that has no work yet; a session keeps where it works for its life. */
  const isolateSession = async (id: string): Promise<void> => {
    const directory = saved(id)?.workspace;
    if (states.get(id)?.workspace !== undefined || (directory !== null && directory !== undefined)) {
      const work = await workspaceFor(id);
      output.replyTo(id, work.place === "source" ? "This session already works in your files, and keeps working there. " +
        "Isolation is chosen before a session's first request: start one with /new, then /isolate."
        : "This session already works in an isolated copy.");
      return;
    }
    if (sourceKind === "folder") {
      output.replyTo(id, "Tesota already works on a copy of this folder: nothing in it changes until you apply a reviewed result.");
      return;
    }
    if (saved(id)?.isolated === true) { output.replyTo(id, "This session will already work in an isolated copy."); return; }
    try { store.setIsolated(id); } catch (error) {
      output.replyTo(id, `Tesota could not record the choice: ${error instanceof Error ? error.message : "unknown error"}.`, "warning");
      return;
    }
    output.writeTo(id, "This session will work in an isolated copy, made with its first request: nothing in your files " +
      "changes until you apply its reviewed result.");
  };
  const undecidedText = (session: SourceSession): string => {
    const count = session.turns.length;
    return count === 0 ? "No turn is undecided." : `${count} ${count === 1 ? "turn is" : "turns are"} undecided.`;
  };
  /** A revert or redo that did not finish, journaled; one that left a partial effect blocks the session, as an application does. */
  const turnWriteFailure = async (id: string, session: SourceSession, tree: string, error: unknown,
    paths: readonly string[], action: "revert" | "redo"): Promise<void> => {
    const verb = action === "revert" ? "reverted" : "put back";
    if (error instanceof ApplyConflictError || error instanceof ApplyRolledBackError) {
      const rolledBack = error instanceof ApplyRolledBackError;
      await journal(id, session, decisionEntry(tree, rolledBack ? `${action}_rolled_back` : `${action}_conflict`));
      output.writeTo(id, `Not ${verb}: ${error.message}.\n${error.paths.length > 0 ? `${pathList(error.paths)}\n` : ""}` +
        (rolledBack ? "Your files hold what they held before." : "Nothing was written."), "warning");
      return;
    }
    await journal(id, session, decisionEntry(tree, `${action}_recovery_required`));
    const states: readonly ApplicationPathState[] = error instanceof ApplyRecoveryError ? error.paths
      : paths.map((path) => ({ path, state: "unknown" as const }));
    output.writeTo(id, `Recovery required: the ${action} stopped partway and could not be undone.\n` +
      `${pathList(states.map((state) => `${state.path}: ${state.state}`))}\n` +
      "Tesota kept a copy of every file. Run tesota recover in this repository to undo or finish it. This session is closed.", "warning");
    blockSession(id);
  };
  /** `/keep`: the operator's acceptance of every undecided turn, which the journal records apart from checks and review. */
  const keepTurns = async (id: string): Promise<void> => {
    const session = await turnsOf(id);
    if (typeof session === "string") { output.replyTo(id, session, "warning"); return; }
    const count = session.turns.length;
    if (count === 0) { output.replyTo(id, "No turn is undecided; there is nothing to keep."); return; }
    const tree = session.snapshot().tree;
    stateFor(id).reviewed = undefined;
    await session.keep();
    reportUndecided(id, session);
    await journal(id, session, decisionEntry(tree, "kept"));
    session.keepRequestsOpen(false);
    if (saved(id)?.plan !== undefined) showPlan(id, undefined);
    output.writeTo(id, `Kept ${count} ${count === 1 ? "turn" : "turns"}. The changes are in your files.`, "success");
  };
  /**
   * `/revert`: undo the latest undecided turn; run again, it steps further
   * back. A file the turn changed outside the agent's file tools may hold the
   * operator's own edit, so it is touched only when the operator says which:
   * `/revert all` reverts it too, `/revert agent` leaves it.
   */
  const revertTurn = (id: string, args: readonly string[]): Promise<void> => serialized(async () => {
    const mode = args[0];
    if (args.length > 1 || mode !== undefined && mode !== "all" && mode !== "agent") {
      output.replyTo(id, "Use /revert, /revert all or /revert agent.", "warning");
      return;
    }
    const session = await turnsOf(id);
    if (typeof session === "string") { output.replyTo(id, session, "warning"); return; }
    const turn = session.turns.at(-1);
    if (turn === undefined) {
      output.replyTo(id, `No turn is undecided${session.redoable === undefined ? "" : "; /redo puts the last reverted one back"}.`);
      return;
    }
    const changed = session.compare(turn.before, turn.after).changes.map((change) => change.path);
    const outside = turn.outside.filter((path) => changed.includes(path));
    if (outside.length > 0 && mode === undefined) {
      output.replyTo(id, "This turn also changed files outside the agent's file tools, by its commands or by you during the " +
        `turn:\n${pathList(outside)}\nUse /revert all to revert them too, or /revert agent to leave them as they are.`, "warning");
      return;
    }
    stateFor(id).reviewed = undefined;
    applying.add(id);
    try {
      const reverted = await session.revert(join(dirname(dirname(session.directory)), "applications"), mode === "agent" ? outside : []);
      if (reverted === undefined) return;
      reportUndecided(id, session);
      await journal(id, session, decisionEntry(turn.after, "reverted"));
      if (session.turns.length === 0) {
        session.keepRequestsOpen(false);
        if (saved(id)?.plan !== undefined) showPlan(id, undefined);
      }
      reportRevert(id, session, reverted);
    } catch (error) { await turnWriteFailure(id, session, turn.after, error, changed, "revert"); }
    finally { applying.delete(id); }
  });
  /** Tell the operator and the agent what a revert did. */
  const reportRevert = (id: string, session: SourceSession, reverted: RevertedTurn): void => {
    const kept = [...reverted.changedSince, ...reverted.left];
    stateFor(id).note = "Note: the user reverted your latest turn; its files hold what they held before it" +
      (kept.length === 0 ? "." : `, except these, which stay as they are: ${kept.join(", ")}.`);
    output.writeTo(id, [`Reverted:\n${pathList(reverted.restored)}`,
      ...reverted.changedSince.length === 0 ? [] : [`Left as they are, since they changed after the turn:\n${pathList(reverted.changedSince)}`],
      ...reverted.left.length === 0 ? [] : [`Left as the turn left them, as you chose:\n${pathList(reverted.left)}`],
      `${undecidedText(session)} /redo puts this turn back${session.turns.length === 0 ? "" : "; /revert again steps further back"}.`]
      .join("\n"), reverted.changedSince.length === 0 ? "success" : "warning");
  };
  /** `/redo`: put the latest reverted turn back, as OpenCode's /redo does, while no new turn started since. */
  const redoTurn = (id: string): Promise<void> => serialized(async () => {
    const session = await turnsOf(id);
    if (typeof session === "string") { output.replyTo(id, session, "warning"); return; }
    const turn = session.redoable;
    if (turn === undefined) { output.replyTo(id, "Nothing to redo: no turn was reverted since the latest one began."); return; }
    const changed = session.compare(turn.before, turn.after).changes.map((change) => change.path);
    stateFor(id).reviewed = undefined;
    applying.add(id);
    try {
      const redone = await session.redo(join(dirname(dirname(session.directory)), "applications"));
      if (redone === undefined) return;
      reportUndecided(id, session);
      await journal(id, session, decisionEntry(turn.after, "redone"));
      stateFor(id).note = "Note: the user put your reverted turn back" +
        (redone.changedSince.length === 0 ? "." : `, except these, which they changed since: ${redone.changedSince.join(", ")}.`);
      output.writeTo(id, [`Put back:\n${pathList(redone.restored)}`,
        ...redone.changedSince.length === 0 ? [] : [`Left as they are, since they changed after the revert:\n${pathList(redone.changedSince)}`],
        `${undecidedText(session)} Review it again with your next request, or /keep or /revert it.`].join("\n"),
        redone.changedSince.length === 0 ? "success" : "warning");
    } catch (error) { await turnWriteFailure(id, session, turn.before, error, changed, "redo"); }
    finally { applying.delete(id); }
  });
  /** `/checks`: the repository's approved checks and the hidden files they may read; `/checks reset` chooses them again. */
  const showChecks = (id: string, args: readonly string[]): void => {
    if (args.length === 1 && args[0] === "reset") {
      store.resetChecks();
      output.writeTo(id, "The next review asks for the checks again, and which hidden files they may read.");
      return;
    }
    if (args.length > 0) { output.replyTo(id, "Use /checks or /checks reset.", "warning"); return; }
    const checks = store.checks();
    const allowed = store.checkSecrets();
    output.replyTo(id, [checks === null ? "No checks are chosen yet; the first review asks for them."
      : checks.length === 0 ? "No checks run after a change." : `Checks:\n${pathList(checks.map(approvedCheckText))}`,
    allowed.length === 0 ? "The checks read no hidden files." : `Hidden files the checks may read:\n${pathList(allowed)}`,
    "/checks reset chooses them again at the next review."].join("\n"));
  };

  /**
   * Tell the agent which files are hidden from it, when that changed, so a
   * command that fails without one is reported rather than worked around.
   */
  const hiddenNotice = async (id: string, root: string): Promise<string | undefined> => {
    const hidden = await hiddenFilesIn(root);
    const state = stateFor(id);
    const told = hidden.join("\n");
    if (told === (state.toldHidden ?? "")) return undefined;
    state.toldHidden = told;
    if (hidden.length === 0) return "Note: no file is hidden from you any longer.";
    return "Note: these files are hidden from you, your file tools and your commands, since they may hold credentials:\n" +
      `${hidden.map((path) => `  ${path}`).join("\n")}\nA command that needs one fails for that reason; say so to the user ` +
      "instead of working around it, such as by creating the file.";
  };

  /** Tell the agent the operator's mode when it differs from the one it last heard of. */
  const modeNotice = (id: string): string | undefined => {
    const state = stateFor(id);
    const current = modeOf(id);
    if (current === (state.toldMode ?? "accept-edits")) return undefined;
    state.toldMode = current;
    return modeNote(current, state.execution?.commands === "sandbox");
  };
  /** Shift+Tab: the next mode, after the operator confirms Full access the first time in this session. */
  const cycleMode = async (id: string): Promise<void> => {
    if (mode === undefined) return;
    const state = stateFor(id);
    const next = nextMode(modeOf(id));
    const asked = needsConfirmation(next, state.fullAccessConfirmed);
    if (asked) {
      let confirmed: boolean;
      // The question cannot open while another waits, such as a command's approval; the mode stays and the shell says why.
      try { confirmed = await decisions(id).fullAccess(); } catch (error) {
        if (!isAbort(error)) output.replyTo(id, "Answer the waiting question first; the mode did not change.", "warning");
        return;
      }
      if (!confirmed) return;
      state.fullAccessConfirmed = true;
    }
    store.setMode(id, next);
    showExecution(id);
    // The answer to the question already says so; entering Full access again in the session still leaves a line.
    if (next === "full-access" && !asked) output.writeTo(id, "Full access: commands run on this computer without asking.", "warning");
  };
  /**
   * Before a sandboxed command: when the repository's toolchain declaration changed since the sandbox was set up, as
   * when the agent declares a tool a check needs, ask the operator, once per declaration, and set it up on their yes
   * (proved: `toolchainStep`, `installsDeclaredTools`). What the agent must know comes back for the command's output.
   */
  const installDeclaredTools = async (id: string, checkout: string): Promise<string | undefined> => {
    const state = stateFor(id);
    const plan = planToolchain(checkout);
    const environment = await environmentFor(id);
    const step = toolchainStep(plan.fingerprint !== state.toolchain, environment.refreshToolchain !== undefined);
    if (step === "unchanged") return undefined;
    state.toolchain = plan.fingerprint;
    const files = [...plan.miseFiles, ...plan.setupScript === null ? [] : [plan.setupScript]];
    if (step === "unavailable") {
      return "Tesota: the repository's toolchain changed, but this sandbox sets up tools only when it is prepared; " +
        "they are not available in this session. Say so to the user rather than working around it.";
    }
    output.reportFor(id, { phase: "awaiting_command" });
    const approved = await decisions(id).toolchain(files);
    output.reportFor(id, { phase: "working" });
    if (!installsDeclaredTools(true, true, approved) || environment.refreshToolchain === undefined) {
      return "Tesota: the user declined installing the tools the repository's toolchain now declares; they are not " +
        "available. Say so rather than working around it.";
    }
    output.reportFor(id, { phase: "preparing", activity: "Installing the declared tools" });
    try {
      const steps = await environment.refreshToolchain({ onProgress: (activity) => { output.reportFor(id, { phase: "preparing", activity }); } });
      const failed = steps.find((entry) => entry.outcome === "failed");
      const summary = describePreparation(steps);
      if (summary !== undefined) output.writeTo(id, summary, failed === undefined ? "info" : "warning");
      return failed === undefined ? "Tesota: the user approved, and the sandbox now has what the repository's toolchain declares."
        : `Tesota: installing the declared tools stopped at "${failed.description}": ${failed.output.trim().slice(-600)}`;
    } catch (error) {
      return `Tesota: the declared tools could not be installed: ${error instanceof Error ? error.message : "unknown error"}.`;
    } finally { output.clearProgressFor(id, "preparing"); output.reportFor(id, { phase: "working" }); }
  };
  /** A session opens in the mode last chosen, which can be Full access without a question: the operator is reminded. */
  const openMode = (id: string): void => {
    showExecution(id);
    if (modeOf(id) === "full-access") {
      output.replyTo(id, "This session is in Full access: commands run on this computer without asking. " +
        "Shift+Tab switches to Read only or Accept edits.", "warning");
    }
  };
  const permissionMode: PermissionModeCommands = { cycle: cycleMode, show: showExecution, open: openMode };
  /** At a turn's end, how many commands Full access let run on this computer without asking, when any did. */
  const noticeFullAccessCommands = (id: string): void => {
    const unasked = stateFor(id).fullAccessCommands;
    if (unasked === 0) return;
    output.writeTo(id, `Full access: ${unasked} ${unasked === 1 ? "command" : "commands"} ran on this computer ` +
      "without asking in this turn.", "warning");
  };

  const sessionWork = (id: string): SessionWork => ({
    prepare: () => {
      if (fresh.has(id)) return;
      environmentFor(id).catch((error: unknown) => {
        // The first request prepares again and reports its own outcome; a preparation stopped on purpose says nothing.
        if (states.has(id) && !isAbort(error)) output.writeTo(id, `${error instanceof Error ? error.message : "The environment could not start."}`, "warning");
      });
    },
    work: (request, origin = "operator", correction) => runOperation(id, async (signal): Promise<WorkResult> => {
      output.setBranch(sourceBranch());
      try {
        const coding = await codingFor(id, signal);
        const state = stateFor(id);
        // A correction keeps the base the candidate was checked on, so its review sees only the agent's own
        // correction; the operator's newer repository state arrives with their next request (decision 039).
        const work = await workspaceFor(id);
        await journalCorrection(id, work, correction);
        // In the source, the turn begins now, and the operator's own edits since the agent's last turn are named to it.
        const edited = work.place === "source" ? await beginTurnIn(work) : undefined;
        const notes = [state.note, modeNotice(id), origin === "operator" ? edited ?? await updateFromSource(id) : undefined,
          origin === "operator" ? await hiddenNotice(id, work.checkout) : undefined]
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
        state.turnCalls.clear();
        let ended: Awaited<ReturnType<SourceSession["endTurn"]>> | undefined;
        let result: Awaited<ReturnType<typeof coding.run>>;
        const steered: Promise<void>[] = [];
        state.running = { agent: coding, work, steered };
        state.fullAccessCommands = 0;
        // A turn that stops or fails still ends, so what it changed can be kept or reverted.
        try { result = await coding.run(prompt, signal); }
        finally {
          state.running = undefined;
          if ((await Promise.allSettled(steered)).some((recorded) => recorded.status === "rejected")) {
            output.writeTo(id, "A message you sent during the turn could not be recorded, so its review does not see it.", "warning");
          }
          if (work.place === "source") ended = await endTurnIn(id, work, origin).catch(() => undefined);
          noticeFullAccessCommands(id);
        }
        if (result.status === "unsettled") { blockSession(id); return result; }
        if (result.status !== "completed") return result;
        state.lastReply = result.reply;
        state.unverified = undefined;
        return { status: "completed", changes: ended?.changed ?? work.snapshot().changes };
      } catch (error) {
        if (signal.aborted || isAbort(error)) return { status: "cancelled" };
        return { status: "failed", reason: error instanceof Error ? error.message : "Unknown failure" };
      }
    }),
    checks: () => store.checks(),
    suggestChecks: () => suggestChecks(checksRoot(id)),
    setChecks: (commands) => { store.setChecks(commands); },
    hiddenFiles: async () => hiddenFilesIn((await workspaceFor(id)).checkout),
    allowForChecks: (paths) => { store.setCheckSecrets([...store.checkSecrets(), ...paths]); },
    place: () => stateFor(id).place ?? "workspace",
    review: (commands, rounds) => runOperation(id, async (signal): Promise<ReviewResult> => {
      const workspace = await workspaceFor(id);
      const state = stateFor(id);
      state.reviewed = undefined;
      state.lastReview = undefined;
      const open = await openAssuranceIn(id, workspace);
      const snapshot = candidateIn(workspace, open);
      const { correction } = open;
      const read = (revision: string, path: string): string | undefined => workspace.contentAt(revision, path);
      const flags = flagVerificationChanges(snapshot, read);
      // A round may run only the tests related to the candidate's changed files; the whole commands run before the decision.
      const related = runsRelatedForm(rounds?.related === true && commands.some((check) => check.related !== undefined),
        snapshot.changes.length > 0, snapshot.changes.some((change) => change.status === "deleted"),
        flags.some((flag) => flag.kind !== "test"), rounds?.lastRound !== false);
      const checks = [...await runChecks(await environmentFor(id), workspace, snapshot, commands, signal,
        { ...await checkOptions(id, workspace.checkout),
          ...related ? { relatedFiles: snapshot.changes.map((change) => change.path) } : {} }),
        ...await runOxlintVerifier(snapshot, read), ...await runLemmaScriptVerifier(snapshot, read, signal)];
      if (signal.aborted) return { status: "cancelled" };
      const requests = await workspace.requests();
      // A correction round reviews only the correction; the verifiers above always cover the whole candidate.
      const scope = correction === undefined ? snapshot
        : { ...snapshot, base: correction.previousTree, ...workspace.compare(correction.previousTree, snapshot.tree) };
      const depth = reviewDepth(scope, flags, checks, sensitivityOf(snapshot, read));
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
          output.writeTo(id, "Tesota could not record what this review cost; later forecasts leave it out.", "warning");
        }
      }
      // Reviewers have no tool that writes, but only an unchanged candidate may be applied.
      const unchanged = workspace.currentTree() === snapshot.tree;
      const reviews: ReviewReport[] = unchanged ? reports : reports.map((report) => ({ reviewer: report.reviewer,
        tree: snapshot.tree, status: "incomplete", reason: "the candidate changed during review" }));
      if (unchanged) state.reviewed = snapshot;
      state.lastReview = { snapshot, checks, flags, requests, reviews, depth, measurement };
      // Each claimed step shows what the review found of it, a judged check, beside the prompt.
      const main = reviews.find((report) => report.status === "completed" && report.obligations !== undefined);
      if (plan !== undefined && main?.status === "completed") showPlan(id, withReview(plan, main.obligations ?? []));
      output.inspectFor(id, inspectReview({ snapshot, checks, flags, requests, reviews, depth, measurement }));
      await journal(id, workspace, reviewEntry("changes", snapshot, requests, checks, flags, reviews, depth, measurement));
      return { status: "ready", tree: snapshot.tree, changes: snapshot.changes, checks, reviews, requests };
    }),
    checkWhole: (commands) => runOperation(id, async (signal): Promise<WholeChecksResult> => {
      const workspace = await workspaceFor(id);
      const state = stateFor(id);
      // The candidate the review just judged, since that review is now the last one.
      const snapshot = candidateIn(workspace, await openAssuranceIn(id, workspace));
      const checks = await runChecks(await environmentFor(id), workspace, snapshot, commands, signal,
        await checkOptions(id, workspace.checkout));
      if (signal.aborted) return { status: "cancelled" };
      await journal(id, workspace, checksEntry(snapshot, checks));
      if (workspace.currentTree() !== snapshot.tree) state.reviewed = undefined;
      // The review's panel shows the whole commands in place of their related forms, beside the verifiers that ran.
      const record = state.lastReview;
      if (record?.snapshot.tree === snapshot.tree) {
        state.lastReview = { ...record, checks: [...checks, ...record.checks.filter((check) => check.verifier !== "command")] };
        output.inspectFor(id, inspectReview(state.lastReview));
      }
      return { status: "ready", tree: snapshot.tree, checks };
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
        response: state.lastReply ?? "", toolCalls: [...state.turnCalls.values()],
        ...(claimedSteps.length === 0 ? {} : { claimedSteps }) };
      // A cheap first pass spares the reviewer a turn with nothing to check (decision 034); off, every answer is checked.
      const triage = await firstPassNow(id, requests, state.lastReply ?? "", signal);
      if (signal.aborted) { output.clearProgressFor(id, "reviewing"); return { status: "cancelled" }; }
      const runsCheck = runsAnswerCheck(triage.decision.decided, triage.decision.checkable);
      await journal(id, workspace, triageEntry(snapshot.tree, requests, triage.model, triage.decision, runsCheck, input.toolCalls));
      // The verdict always shows, so an answer is never left unchecked without the operator seeing why.
      output.showTriage(id, { model: triage.model, outcome: triageOutcome(triage.decision.decided, triage.decision.checkable),
        reason: triage.decision.reason });
      if (!runsCheck) {
        output.clearProgressFor(id, "reviewing");
        workspace.keepRequestsOpen(false);
        state.unverified = { input, requests, triage };
        return { status: "assessed", reviews: [], requests };
      }
      const reports = await reviewAnswerIn(id, input, signal);
      if (signal.aborted) return { status: "cancelled" };
      const main = reports.find((report) => report.status === "completed");
      // A request stays pending while its check left it not held or uncertain, or could not run.
      workspace.keepRequestsOpen(!answerHeld(reports));
      if (plan !== undefined && main?.status === "completed") showPlan(id, withReview(plan, main.obligations ?? []));
      output.inspectFor(id, inspectAnswer(requests, reports, triage));
      await journal(id, workspace, reviewEntry("answer", snapshot, requests, [], [], reports));
      return { status: "assessed", reviews: reports, requests };
    }),
    // Decision 042's refresh, without an agent turn: the agent hears of the changes with its next request.
    refresh: () => runOperation(id, async (): Promise<RefreshResult> => {
      const brought = await bringInSource(id);
      const state = stateFor(id);
      if (brought.note !== undefined) state.note = [state.note, brought.note].filter((note) => note !== undefined).join("\n\n");
      return brought.status;
    }),
    apply: () => serialized(async (): Promise<ApplyResult> => {
      const state = stateFor(id);
      const reviewed = state.reviewed;
      if (reviewed === undefined) return { status: "conflict", reason: "there is no current review", paths: [] };
      state.reviewed = undefined;
      const workspace = await workspaceFor(id);
      if (workspace.place === "source") return { status: "conflict", reason: "the changes are already in your files", paths: [] };
      applying.add(id);
      try {
        const applied = await applyWorkspace(workspace, reviewed);
        await journal(id, workspace, decisionEntry(reviewed.tree, "applied"));
        workspace.keepRequestsOpen(false);
        if (saved(id)?.plan !== undefined) showPlan(id, undefined);
        return { status: "applied", changes: applied.changes, alsoChanged: applied.alsoChanged };
      } catch (error) {
        if (error instanceof ApplyConflictError) {
          await journal(id, workspace, decisionEntry(reviewed.tree, "application_conflict"));
          return { status: "conflict", reason: error.message, paths: error.paths, ...error.sourceChanged ? { sourceChanged: true } : {} };
        }
        if (error instanceof ApplyRolledBackError) {
          await journal(id, workspace, decisionEntry(reviewed.tree, "application_rolled_back"));
          return { status: "conflict", reason: error.message, paths: error.paths, rolledBack: true };
        }
        blockSession(id);
        await journal(id, workspace, decisionEntry(reviewed.tree, "application_recovery_required"));
        // An error outside the application's own record leaves its state unknown, so every changed path is listed.
        return error instanceof ApplyRecoveryError ? { status: "recovery_required", id: error.id, paths: error.paths }
          : { status: "recovery_required", id: "", paths: reviewed.changes.map((change) => ({ path: change.path,
            state: "unknown" as const })) };
      } finally { applying.delete(id); }
    }),
    reject: async () => {
      const state = stateFor(id);
      const rejected = state.reviewed;
      state.reviewed = undefined;
      const workspace = await workspaceFor(id);
      if (workspace.place === "source") return;
      if (rejected !== undefined) await journal(id, workspace, decisionEntry(rejected.tree, "rejected"));
      workspace.revert();
      workspace.keepRequestsOpen(false);
      if (saved(id)?.plan !== undefined) showPlan(id, undefined);
      state.note = "Note: the user rejected your previous changes, and the workspace was reset to the last applied state.";
    },
  });

  return {
    session: sessionWork,
    turnCommands: { keep: keepTurns, revert: revertTurn, redo: redoTurn, isolate: isolateSession, verify: verifyAnswer },
    showUndecided,
    diffSources,
    agentModel,
    sessionSandbox,
    permissionMode,
    showChecks,
    name: nameInBackground,
    offered,
    contextTokens: (id) => states.get(id)?.agent?.contextTokens(),
    interrupt,
    steer: (id, text) => {
      const running = states.get(id)?.running;
      if (running?.agent.steer?.(text) !== true) return false;
      running.steered.push(running.work.recordRequest(text, true));
      return true;
    },
    abortActive: () => { for (const controller of activeOperations.values()) controller.abort(); },
    busy: (id) => activeOperations.has(id) || applying.has(id),
    pendingChanges: pendingChangeCount,
    discard: discardSession,
    dispose: async () => {
      titling.abort();
      const released = [...states.values()].map(release);
      // A release that hangs must not keep Tesota from exiting; the next session's sweep removes what it left.
      await Promise.race([Promise.allSettled(released), new Promise((settle) => { setTimeout(settle, RELEASE_TIME_LIMIT_MS).unref(); })]);
    },
  };
}
