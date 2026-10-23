import type { WorkingDetail } from "./contract.js";

/**
 * The gate's operations (#590): each proof, project command, test run on the
 * base, mutation, ClaimCheck call, model run, open-case listing and receipt
 * assembly, published by the code that runs it as it starts and as it ends.
 * Nothing is inferred from timings or output. Operations describe what ran;
 * they never decide a verdict or a send-back.
 */
export type OperationMethod = "proof" | "command" | "exercise" | "base_control" | "mutation" | "claimcheck" | "model_main"
  | "model_fault" | "model_replay" | "open_cases" | "receipt";

/**
 * How an operation ended. A verifier's outcome is its own; `done` ends work
 * that gives an opinion or an assembly, never a verdict; `interrupted` is an
 * end nothing reported; `not_started` was planned and never began.
 */
export type OperationResult = "passed" | "failed" | "vacuous" | "timed_out" | "cancelled" | "not_started" | "done" | "interrupted";

/** What one operation is, before it runs. */
export interface OperationSpec {
  readonly method: OperationMethod;
  /** The repository folder it runs in, `""` for the folder Tesota runs in. */
  readonly unit: string;
  /** The exact command launched or the exact file, contract or model it works on. */
  readonly target: string;
  /** The operation it belongs to, such as the model run a planted fault follows. */
  readonly parent?: string;
}

export interface Operation extends OperationSpec {
  readonly id: string;
  readonly run: string;
  readonly generation: number;
  readonly state: "planned" | "running" | "ended";
  /** Milliseconds on the monotonic clock; absent until it starts. */
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly result?: OperationResult;
  /** A result kept from an earlier check of the same content, not run again. */
  readonly reused: boolean;
  /** It ran while other work that is not its ancestor or descendant ran. */
  readonly concurrent: boolean;
}

/** How an attempt, one pass of the gate over a request, closed. */
export type AttemptEnd = "settled" | "returned_to_agent" | "stopped";

export interface Attempt {
  readonly generation: number;
  readonly closedAs?: AttemptEnd;
}

/** What a runner reports to: the gate's tracker, or nothing. */
export interface OperationSink {
  /** Announces work that is to run, so a stop can mark it as not started. Returns its id. */
  plan(spec: OperationSpec): string;
  /** Runs `work` between a start and an end; `resultOf` gives the end from the work's value. A throw ends it as interrupted. */
  run<T>(spec: OperationSpec, work: () => Promise<T>, resultOf: (value: T) => OperationResult, planned?: string): Promise<T>;
  /** The same sink for work in another repository folder. */
  forUnit(unit: string): OperationSink;
}

/** The sink for code that runs with no one watching, such as a tool call. */
export const noOperations: OperationSink = {
  plan: () => "",
  run: (_spec, work) => work(),
  forUnit: () => noOperations,
};

const labels: Readonly<Record<OperationMethod, string>> = {
  proof: "Proving", command: "Running project check", exercise: "Checking test sensitivity",
  base_control: "Checking the base without the test", mutation: "Measuring contract strength", claimcheck: "Asking ClaimCheck",
  model_main: "Checking model", model_fault: "Checking planted fault", model_replay: "Replaying model against the code",
  open_cases: "Listing open cases", receipt: "Assembling receipt",
};

/** What each method ran, named for a row of the ledger once it ended: its glyph is that run's own result, never a verdict. */
const ran: Readonly<Record<OperationMethod, string>> = {
  proof: "Proof", command: "Project check", exercise: "Base run with the test", base_control: "Base run without the test",
  mutation: "Contract strength", claimcheck: "ClaimCheck", model_main: "Model", model_fault: "Model with planted fault",
  model_replay: "Model replay", open_cases: "Open cases", receipt: "Receipt",
};

/** A result's glyph: only a pass is ✓; an end that gives no verdict, or none, is ○. */
const glyphs: Readonly<Record<OperationResult, string>> = {
  passed: "✓", failed: "✗", vacuous: "◐", timed_out: "○", cancelled: "○", not_started: "○", done: "○", interrupted: "○",
};

/** What a result adds to its row, beyond its time. */
const endings: Readonly<Partial<Record<OperationResult, string>>> = {
  vacuous: " · verified nothing", timed_out: " · ran past its limit", cancelled: " · stopped", interrupted: " · no end reported",
};

/**
 * Runs whose result is not the check's own: a planted fault that passes is not
 * caught, and one that fails may be caught or malformed, which only the
 * receipt tells apart; a base run says only how the base did.
 */
const observed: Readonly<Partial<Record<OperationMethod, Partial<Record<OperationResult, readonly [string, string]>>>>> = {
  model_fault: { passed: ["✗", " · passed: fault not caught"], failed: ["○", " · model failed"] },
  exercise: { passed: ["○", " · passed on the base"], failed: ["○", " · failed on the base"] },
  base_control: { passed: ["○", " · passed on the base"], failed: ["○", " · failed on the base"] },
};

/** One row of the ledger (#591): a glyph, its words, and how far under an earlier attempt it sits. */
export interface LedgerRow {
  readonly glyph: string;
  readonly text: string;
  readonly depth: number;
}

/** How many ended operations the ledger shows of the attempt running, collapsed. */
const RECENT = 3;

/** Elapsed milliseconds as `m:ss`. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The gate's operations for one session, in the order they were published,
 * and who listens. The gate and the runners it calls publish; the shell and
 * the footer read.
 */
export class GateOperations implements WorkingDetail, OperationSink {
  /** The message renderer that draws the ledger as the request's transcript block. */
  readonly block = "tesota-ledger";
  readonly #now: () => number;
  #run = "";
  #generation = 0;
  #sequence = 0;
  #all: Operation[] = [];
  #attempts: Attempt[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(now: () => number = () => performance.now()) { this.#now = now; }

  /** A new request: nothing of the earlier one is kept. */
  beginRun(run: string): void {
    this.#run = run;
    this.#generation = 0;
    this.#all = [];
    this.#attempts = [];
    this.#publish();
  }

  /** The gate starts a pass over the request: the first, or the one after a send-back. */
  beginAttempt(): void {
    this.#generation += 1;
    this.#attempts.push({ generation: this.#generation });
  }

  /**
   * The pass is over. Planned work that never began is `not_started`; work
   * that began and reported no end is `interrupted`, never passed.
   */
  closeAttempt(closedAs: AttemptEnd): void {
    const generation = this.#generation;
    this.#all = this.#all.map((op) => op.generation !== generation || op.state === "ended" ? op
      : op.state === "planned" ? { ...op, state: "ended", result: "not_started" }
        : this.#ended(op, "interrupted"));
    this.#attempts = this.#attempts.map((attempt) => attempt.generation === generation ? { ...attempt, closedAs } : attempt);
    this.#publish();
  }

  operations(): readonly Operation[] { return this.#all; }

  attempts(): readonly Attempt[] { return this.#attempts; }

  plan(spec: OperationSpec): string {
    const id = `${this.#run}.${this.#generation}.${this.#sequence += 1}`;
    this.#all.push({ ...spec, id, run: this.#run, generation: this.#generation, state: "planned", reused: false, concurrent: false });
    this.#publish();
    return id;
  }

  /** Begins `spec`, or the operation planned as `planned`; returns its id. */
  start(spec: OperationSpec, planned?: string): string {
    const id = planned ?? this.plan(spec);
    const at = this.#now();
    const running = this.#all.filter((op) => op.state === "running" && !this.#related(op.id, id));
    const marked = new Set(running.map(({ id: other }) => other));
    this.#all = this.#all.map((op) => op.id === id ? { ...op, state: "running", startedAt: at, concurrent: running.length > 0 }
      : marked.has(op.id) ? { ...op, concurrent: true } : op);
    this.#publish();
    return id;
  }

  end(id: string, result: OperationResult): void {
    this.#all = this.#all.map((op) => op.id === id && op.state === "running" ? this.#ended(op, result) : op);
    this.#publish();
  }

  /** Work not run again because the same content was checked before: no time of its own. */
  reused(spec: OperationSpec, result: OperationResult): void {
    const id = this.plan(spec);
    const at = this.#now();
    this.#all = this.#all.map((op) => op.id === id ? { ...op, state: "ended", startedAt: at, endedAt: at, durationMs: 0, result, reused: true } : op);
    this.#publish();
  }

  async run<T>(spec: OperationSpec, work: () => Promise<T>, resultOf: (value: T) => OperationResult, planned?: string): Promise<T> {
    const id = this.start(spec, planned);
    try {
      const value = await work();
      this.end(id, resultOf(value));
      return value;
    } catch (error) {
      this.end(id, "interrupted");
      throw error;
    }
  }

  forUnit(unit: string): OperationSink {
    return {
      plan: (spec) => this.plan({ ...spec, unit }),
      run: (spec, work, resultOf, planned) => this.run({ ...spec, unit }, work, resultOf, planned),
      forUnit: (other) => this.forUnit(other),
    };
  }

  /** What the status line says of the work running at `now`, each operation's step, exact target and elapsed time; nothing when none runs. */
  line(now: number): string | undefined {
    const running = this.#all.filter((op) => op.state === "running");
    return running.length === 0 ? undefined : running
      .map((op) => `${labels[op.method]} · ${op.target} · ${clock(now - (op.startedAt ?? now))}`).join(" | ");
  }

  /**
   * The request's checks as a ledger (#591): each attempt that went back to
   * the agent folded into one row, then the latest attempt's ended checks,
   * the three latest when collapsed with a count of the earlier ones, then
   * what runs at `now`. Expanded, every check of every attempt.
   */
  ledger(now: number, all: boolean): LedgerRow[] {
    const returned = new Set(this.#attempts.filter(({ closedAs }) => closedAs === "returned_to_agent").map(({ generation }) => generation));
    const ended = (op: Operation, depth: number): LedgerRow => {
      const result = op.result ?? "interrupted";
      const [glyph, ending] = observed[op.method]?.[result] ?? [glyphs[result], endings[result] ?? ""];
      return { glyph, text: `${ran[op.method]} · ${op.unit === "" ? "" : `${op.unit}: `}${op.target}${op.reused ? " · reused, not run again"
        : result === "not_started" ? " · not started" : ` · ${clock(op.durationMs ?? 0)}${ending}`}`, depth };
    };
    const folded = [...returned].flatMap((generation) => {
      const ops = this.#all.filter((op) => op.generation === generation);
      return [{ glyph: "↺", text: `Attempt ${generation} · returned to agent · ${ops.length} ${ops.length === 1 ? "check" : "checks"}`, depth: 0 },
        ...all ? ops.map((op) => ended(op, 1)) : []];
    });
    const latest = this.#all.filter((op) => !returned.has(op.generation));
    const done = latest.filter(({ state }) => state === "ended");
    const shown = all ? done : done.slice(-RECENT);
    const earlier = done.length - shown.length;
    return [...folded,
      ...earlier === 0 ? [] : [{ glyph: "·", text: `${earlier} earlier ${earlier === 1 ? "check" : "checks"}`, depth: 0 }],
      ...shown.map((op) => ended(op, 0)),
      ...latest.filter(({ state }) => state === "running").map((op) => ({ glyph: "›",
        text: `${labels[op.method]} · ${op.target} · ${clock(now - (op.startedAt ?? now))}`, depth: 0 }))];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** How many are listening. */
  subscribers(): number { return this.#listeners.size; }

  #ended(op: Operation, result: OperationResult): Operation {
    const at = this.#now();
    return { ...op, state: "ended", endedAt: at, durationMs: at - (op.startedAt ?? at), result };
  }

  /** Whether one is the other's ancestor or descendant. */
  #related(first: string, second: string): boolean {
    const parents = new Map(this.#all.map(({ id, parent }) => [id, parent]));
    const above = (from: string, target: string): boolean => {
      for (let at = parents.get(from); at !== undefined; at = parents.get(at)) if (at === target) return true;
      return false;
    };
    return above(first, second) || above(second, first);
  }

  #publish(): void { for (const listener of this.#listeners) listener(); }
}
