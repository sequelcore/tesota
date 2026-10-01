import type { AgentActivity } from "./integrations/model-session-contract.js";
import type { SessionDecisions } from "./session-decisions.js";
import { chooseSessionExecution, providersFor } from "./execution-providers.js";
import { createSessionEngine, type SessionEngine, type SessionEngineOptions, type SessionOutput } from "./session-engine.js";
import { openShellSessionStore } from "./shell-session-store.js";
import { type TesotaShellProgress, tesotaShellProgressLabel } from "./shell-progress.js";
import { runTesotaShell } from "./tesota-shell.js";
import type { ShellInspection } from "./tesota-shell-terminal.js";
import type { NoticeTone } from "./tesota-shell-transcript.js";
import type { WorkPlan } from "./work-plan.js";
import { type ApprovedCheck, parseApprovedCheck } from "./workspace-checks.js";
import { runCommandAnswer, runExitCode, runNetworkAnswer, type RunStatus } from "./verification/run-policy-rule.js";

/**
 * What a run allows where nobody is at the keyboard, stated up front: commands
 * that ask for approval, destinations the sandbox refused and sites the agent
 * would read, each for this run only; the checks to run after the change, the
 * suggested ones unless named; and whether a result in a copy is applied.
 */
export interface RunPolicy {
  readonly commands: boolean;
  readonly network: boolean;
  readonly checks: "suggested" | readonly ApprovedCheck[];
  readonly apply: boolean;
}

export interface RunOptions {
  /** The request, or `-` to read it from standard input. */
  readonly request: string;
  readonly policy: RunPolicy;
  /** Print one JSON record of the run on standard output instead of the agent's reply. */
  readonly json: boolean;
  /** The operator's consent to record a plain folder, which the shell asks for once. */
  readonly folder: boolean;
}

export const RUN_USAGE: string = "tesota run [--allow-commands] [--allow-network] [--checks=<command;…>|none] [--apply] [--folder] " +
  "[--json] (<request> | -)";

/** The run's options from its arguments, or why they cannot be used. */
export function parseRunArgs(args: readonly string[]): RunOptions | string {
  let commands = false;
  let network = false;
  let apply = false;
  let json = false;
  let folder = false;
  let checks: RunPolicy["checks"] = "suggested";
  const words: string[] = [];
  for (const argument of args) {
    if (words.length > 0 || !argument.startsWith("--")) { words.push(argument); continue; }
    if (argument === "--allow-commands") commands = true;
    else if (argument === "--allow-network") network = true;
    else if (argument === "--apply") apply = true;
    else if (argument === "--json") json = true;
    else if (argument === "--folder") folder = true;
    else if (argument.startsWith("--checks=")) {
      const value = argument.slice("--checks=".length).trim();
      if (value === "none") { checks = []; continue; }
      const parsed: ApprovedCheck[] = [];
      for (const text of value.split(";").filter((part) => part.trim().length > 0)) {
        const check = parseApprovedCheck(text);
        if (typeof check === "string") return check;
        parsed.push(check);
      }
      if (parsed.length === 0) return "Name the checks with --checks=<command;…>, or --checks=none.";
      checks = parsed;
    } else return `Unknown option ${argument}. Usage: ${RUN_USAGE}`;
  }
  const request = words.join(" ").trim();
  if (request.length === 0) return `Give the request, or - to read it from standard input. Usage: ${RUN_USAGE}`;
  return { request, policy: { commands, network, checks, apply }, json, folder };
}

/**
 * A run's decisions: its one request, then the end, and every other answer
 * by its policy. Hidden files stay hidden from its checks, and a result in a
 * copy is kept pending unless the run applies it.
 */
export function policyDecisions(request: string, policy: RunPolicy): SessionDecisions {
  let asked = false;
  return {
    nextRequest: async () => {
      if (asked) return "";
      asked = true;
      return request;
    },
    queued: () => false,
    checks: async (suggested) => policy.checks === "suggested" ? suggested.map((command) => ({ command, reports: [] })) : policy.checks,
    checkSecrets: async () => [],
    result: async () => policy.apply ? "apply" : "keep",
    command: async () => runCommandAnswer(policy.commands),
    network: async () => runNetworkAnswer(policy.network),
    site: async () => runNetworkAnswer(policy.network),
    // A run keeps accept edits; its --commands flag decides commands that ask.
    fullAccess: async () => false,
    // A run installs nothing it was not prepared with; its sandbox's toolchain is the one its session started with.
    toolchain: async () => false,
    // A run decides once; a source that changed under it is reported, never brought in.
    refresh: async () => false,
  };
}

/** What a run did, as `--json` prints it. */
export interface RunRecord {
  session: string;
  status: RunStatus;
  exitCode: number;
  /** The agent's replies in the turn's latest round, after any correction. */
  reply: string;
  notices: { text: string; tone: NoticeTone }[];
  results: ShellInspection[];
  execution: string | undefined;
  model: string | undefined;
  plan: WorkPlan | undefined;
  blocked: boolean;
}

/**
 * A run's output: the agent's final replies on standard output, unless the
 * run prints JSON, and Tesota's notices, progress and results on standard
 * error, all kept for the record.
 */
export class RunOutput implements SessionOutput {
  readonly record: RunRecord;
  readonly #json: boolean;
  readonly #out: (text: string) => void;
  readonly #err: (text: string) => void;
  #phase: string | undefined;

  constructor(session: string, json: boolean, out: (text: string) => void, err: (text: string) => void) {
    this.#json = json;
    this.#out = out;
    this.#err = err;
    this.record = { session, status: "not_started", exitCode: 0, reply: "", notices: [], results: [], execution: undefined,
      model: undefined, plan: undefined, blocked: false };
  }

  writeTo(_id: string, text: string, tone: NoticeTone = "info"): void {
    this.record.notices.push({ text, tone });
    this.#err(text.endsWith("\n") ? text : `${text}\n`);
  }

  replyTo(id: string, text: string, tone?: NoticeTone): void { this.writeTo(id, text, tone); }

  reportFor(_id: string, progress: TesotaShellProgress): void {
    const label = tesotaShellProgressLabel(progress);
    if (label === this.#phase) return;
    this.#phase = label;
    this.#err(`· ${label}\n`);
  }

  clearProgressFor(): void { this.#phase = undefined; }

  inspectFor(_id: string, inspection: ShellInspection): void {
    this.record.results.push(inspection);
    this.#err(`${inspection.title}\n${inspection.summary}\n`);
  }

  showActivity(_id: string, activity: AgentActivity): void {
    if (activity.type === "tool_started") this.#err(`· ${activity.tool} ${activity.subject}`.trimEnd() + "\n");
    if (activity.type !== "reply" || !activity.final || activity.text.length === 0) return;
    this.record.reply = this.record.reply.length === 0 ? activity.text : `${this.record.reply}\n\n${activity.text}`;
    if (!this.#json) this.#out(`${activity.text}\n`);
  }

  setSessionExecution(_id: string, label: string): void { this.record.execution = label; }
  /** A run decides its result itself, so it shows no decision bar. */
  setSessionUndecided(): void {}
  setSessionPlan(_id: string, plan: WorkPlan | undefined): void { this.record.plan = plan; }
  setBranch(): void {}
  setSessionModel(_id: string, model: string): void { this.record.model = model; }
  setSessionTitle(): void {}
  blockSession(): void { this.record.blocked = true; }
}

/**
 * Run one request through the same loop and engine as the shell, answering
 * its decisions by `options.policy`, and return the exit code. The session
 * stays saved, so `tesota resume` can keep or revert its turn.
 */
export async function runTesotaRun(id: string, decisions: SessionDecisions,
  engine: Pick<SessionEngine, "session" | "dispose">, output: RunOutput): Promise<number> {
  const work = engine.session(id);
  let loop = 1;
  try {
    loop = await runTesotaShell({
      ...work,
      work: async (request, origin) => {
        // The record keeps the reply of the latest round, so a correction's answer replaces the one it corrected.
        output.record.reply = "";
        const result = await work.work(request, origin);
        output.record.status = result.status;
        return result;
      },
      decisions,
      write: (text, tone) => { output.writeTo(id, text, tone); },
      report: (progress) => { output.reportFor(id, progress); },
    });
  } finally {
    await engine.dispose();
  }
  output.record.exitCode = runExitCode(output.record.status, output.record.blocked, loop);
  return output.record.exitCode;
}

/** Where a run writes: the agent's reply or the JSON record, and Tesota's notices and progress. */
export interface RunStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * Run in `cwd`, a repository or a plain folder already recorded or recorded
 * now by `--folder`: a new saved session, its engine and the loop, with
 * Ctrl+C stopping the work under way. Returns the exit code.
 */
export async function runInDirectory(cwd: string, options: RunOptions, streams: RunStreams,
  createEngine: (options: SessionEngineOptions) => Pick<SessionEngine, "session" | "dispose" | "interrupt"> = createSessionEngine,
  chooseExecution: SessionEngineOptions["chooseExecution"] = (preference) => chooseSessionExecution(providersFor(preference)),
  storeRoot?: string): Promise<number> {
  const store = openShellSessionStore(cwd, storeRoot);
  const session = store.create();
  const output = new RunOutput(session.id, options.json, streams.out, streams.err);
  const decisions = policyDecisions(options.request, options.policy);
  const stop = (): void => { engine.interrupt(session.id); };
  const engine = createEngine({ cwd, store, output, decisions: () => decisions, chooseExecution, fresh: new Set() });
  process.on("SIGINT", stop);
  try {
    await runTesotaRun(session.id, decisions, engine, output);
  } finally {
    process.off("SIGINT", stop);
    store.close();
  }
  if (options.json) streams.out(`${JSON.stringify(output.record)}\n`);
  streams.err(`Session ${session.id}: tesota resume ${session.id} opens it.\n`);
  return output.record.exitCode;
}
