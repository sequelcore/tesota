import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import * as z from "zod";
import { loadTaskProposal } from "./task-proposal.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const timestampSchema = z.iso.datetime();

export interface TaskExecutionAccounting {
  readonly elapsedMs: number;
  readonly firstCheck: "passed" | "check_failed" | "not_observed";
  readonly correctionAttempts: number;
  readonly modelInvocations: number;
  readonly toolCalls: number;
  readonly edits: number;
  readonly causes?: Readonly<{
    initialImplementation: boolean;
    diagnosticRepairs: number;
    semanticRevision: boolean;
  }> | undefined;
  readonly resources?: Readonly<{ reads: number; checks: number; hostChecks: number; activeMs: number }> | undefined;
  readonly consumption: Readonly<{ status: "partial"; tokenUsage: "unavailable"; cost: "unavailable" }>;
}

interface ExecutionResult {
  readonly status: "passed" | "failed" | "cancelled";
  readonly accounting: TaskExecutionAccounting;
}

interface InitialEvent {
  readonly format: "tesota-task-outcome";
  readonly version: 1 | 2 | 3;
  readonly state: "awaiting_scope_approval";
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly baseline: string;
  readonly timestamp: string;
  readonly authority: "none";
}

type OutcomeEvent =
  | Readonly<{ state: "scope_declined" | "execution_started"; timestamp: string }>
  | Readonly<{ state: "execution_finished"; timestamp: string; candidate: string; result: ExecutionResult }>
  | Readonly<{ state: "review_ready"; timestamp: string; reviewSha256: string;
    checkStatus: "passed" | "check_failed"; revision?: "R1" | undefined; parentReviewSha256?: string | undefined;
    hostChecks?: number | undefined }>
  | Readonly<{ state: "correction_approved"; timestamp: string; parentReviewSha256: string;
    refinementSha256: string; effectiveCriteriaSha256: string; hostChecks?: number | undefined }>
  | Readonly<{ state: "revision_started"; timestamp: string; parentReviewSha256: string;
    hostChecks?: number | undefined }>
  | Readonly<{ state: "revision_finished"; timestamp: string; candidate: string; parentReviewSha256: string;
    result: ExecutionResult; hostChecks?: number | undefined }>
  | Readonly<{ state: "decision_recorded"; timestamp: string; decision: "accept" | "reject"; reviewSha256: string;
    hostChecks?: number | undefined }>
  | Readonly<{ state: "promotion_started"; timestamp: string; reviewSha256: string;
    hostChecks?: number | undefined }>
  | Readonly<{ state: "finished"; timestamp: string;
    outcome: "execution_failed" | "cancelled" | "rejected" | "promoted" | "promotion_not_applied" | "failed";
    files?: readonly { readonly path: string; readonly sourceSha256: string }[] | undefined;
    hostChecks?: number | undefined }>;

const accountingSchema: z.ZodType<TaskExecutionAccounting> = z.strictObject({
  elapsedMs: z.number().int().nonnegative(),
  firstCheck: z.enum(["passed", "check_failed", "not_observed"]),
  correctionAttempts: z.number().int().nonnegative(),
  modelInvocations: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  edits: z.number().int().nonnegative(),
  causes: z.strictObject({ initialImplementation: z.boolean(), diagnosticRepairs: z.number().int().nonnegative(),
    semanticRevision: z.boolean() }).optional(),
  resources: z.strictObject({ reads: z.number().int().nonnegative(), checks: z.number().int().nonnegative(),
    hostChecks: z.number().int().nonnegative(), activeMs: z.number().int().nonnegative() }).optional(),
  consumption: z.strictObject({ status: z.literal("partial"), tokenUsage: z.literal("unavailable"),
    cost: z.literal("unavailable") }),
});

const executionResultSchema: z.ZodType<ExecutionResult> = z.strictObject({
  status: z.enum(["passed", "failed", "cancelled"]), accounting: accountingSchema,
}).refine(({ status, accounting }) => accounting.correctionAttempts <= accounting.edits &&
  (status !== "passed" || accounting.firstCheck === "check_failed" && accounting.correctionAttempts > 0));
const revisionExecutionResultSchema: z.ZodType<ExecutionResult> = z.strictObject({
  status: z.enum(["passed", "failed", "cancelled"]), accounting: accountingSchema,
}).refine(({ status, accounting }) => accounting.correctionAttempts <= accounting.edits &&
  (status !== "passed" || accounting.firstCheck !== "not_observed"));
const initialSchema: z.ZodType<InitialEvent> = z.strictObject({
  format: z.literal("tesota-task-outcome"), version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  state: z.literal("awaiting_scope_approval"),
  proposalId: z.uuid(), proposalSha256: digestSchema, baseline: objectIdSchema, timestamp: timestampSchema,
  authority: z.literal("none"),
});
const eventSchema: z.ZodType<OutcomeEvent> = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("scope_declined"), timestamp: timestampSchema }),
  z.strictObject({ state: z.literal("execution_started"), timestamp: timestampSchema }),
  z.strictObject({ state: z.literal("execution_finished"), timestamp: timestampSchema,
    candidate: z.string().min(1).max(4096), result: executionResultSchema }),
  z.strictObject({ state: z.literal("review_ready"), timestamp: timestampSchema,
    reviewSha256: digestSchema, checkStatus: z.enum(["passed", "check_failed"]),
    revision: z.literal("R1").optional(), parentReviewSha256: digestSchema.optional(),
    hostChecks: z.number().int().nonnegative().optional() })
    .refine(({ revision, parentReviewSha256 }) => (revision === "R1") === (parentReviewSha256 !== undefined)),
  z.strictObject({ state: z.literal("correction_approved"), timestamp: timestampSchema,
    parentReviewSha256: digestSchema, refinementSha256: digestSchema, effectiveCriteriaSha256: digestSchema,
    hostChecks: z.number().int().nonnegative().optional() }),
  z.strictObject({ state: z.literal("revision_started"), timestamp: timestampSchema, parentReviewSha256: digestSchema,
    hostChecks: z.number().int().nonnegative().optional() }),
  z.strictObject({ state: z.literal("revision_finished"), timestamp: timestampSchema, candidate: z.string().min(1).max(4096),
    parentReviewSha256: digestSchema, result: revisionExecutionResultSchema,
    hostChecks: z.number().int().nonnegative().optional() }),
  z.strictObject({ state: z.literal("decision_recorded"), timestamp: timestampSchema,
    decision: z.enum(["accept", "reject"]), reviewSha256: digestSchema,
    hostChecks: z.number().int().nonnegative().optional() }),
  z.strictObject({ state: z.literal("promotion_started"), timestamp: timestampSchema, reviewSha256: digestSchema,
    hostChecks: z.number().int().nonnegative().optional() }),
  z.strictObject({ state: z.literal("finished"), timestamp: timestampSchema,
    outcome: z.enum(["execution_failed", "cancelled", "rejected", "promoted", "promotion_not_applied", "failed"]),
    files: z.array(z.strictObject({ path: z.string().min(1).max(1024), sourceSha256: digestSchema })).max(2).optional(),
    hostChecks: z.number().int().nonnegative().optional() }),
]);

export type TaskOutcomeEventInput =
  | Readonly<{ state: "scope_declined" | "execution_started" }>
  | Readonly<{ state: "execution_finished"; candidate: string;
    result: Readonly<{ status: "passed" | "failed" | "cancelled"; accounting: TaskExecutionAccounting }> }>
  | Readonly<{ state: "review_ready"; reviewSha256: string; checkStatus: "passed" | "check_failed";
    hostChecks?: number }>
  | Readonly<{ state: "correction_approved"; parentReviewSha256: string; refinementSha256: string;
    effectiveCriteriaSha256: string; hostChecks?: number }>
  | Readonly<{ state: "revision_started"; parentReviewSha256: string; hostChecks?: number }>
  | Readonly<{ state: "revision_finished"; candidate: string; parentReviewSha256: string;
    result: Readonly<{ status: "passed" | "failed" | "cancelled"; accounting: TaskExecutionAccounting }>;
    hostChecks?: number }>
  | Readonly<{ state: "review_ready"; reviewSha256: string; checkStatus: "passed" | "check_failed";
    revision: "R1"; parentReviewSha256: string; hostChecks?: number }>
  | Readonly<{ state: "decision_recorded"; decision: "accept" | "reject"; reviewSha256: string;
    hostChecks?: number }>
  | Readonly<{ state: "promotion_started"; reviewSha256: string; hostChecks?: number }>
  | Readonly<{ state: "finished"; outcome: "execution_failed" | "cancelled" | "rejected" | "promoted" | "promotion_not_applied" | "failed";
    files?: readonly { readonly path: string; readonly sourceSha256: string }[]; hostChecks?: number }>;

export interface TaskOutcomeJournal {
  append(event: TaskOutcomeEventInput): Promise<void>;
  current(): TaskOutcome;
  close(): Promise<void>;
}

type TaskOutcomePhase = "awaiting_scope_approval" | Exclude<OutcomeEvent["state"], "finished">;

export interface TaskOutcome {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly baseline: string;
  readonly status: "awaiting_scope_approval" | Exclude<OutcomeEvent["state"], "finished"> |
    Extract<OutcomeEvent, { state: "finished" }>["outcome"];
  readonly lastPhase: TaskOutcomePhase;
  readonly terminal: boolean;
  readonly elapsedMs: number;
  readonly candidate: string | null;
  readonly firstCheck: TaskExecutionAccounting["firstCheck"];
  readonly correctionAttempts: number;
  readonly execution: TaskExecutionAccounting | null;
  readonly operator: Readonly<{ scopeApproval: "pending" | "approved" | "declined";
    decision: "not_reached" | "accept" | "reject" }>;
  readonly promotion: "not_reached" | "not_applied" | "unconfirmed" | "applied";
  readonly authority: "none";
  readonly provenance: "recorded_untrusted";
}

function terminalInterruptionAllowed(previous: InitialEvent | OutcomeEvent, next: OutcomeEvent, version: 1 | 2 | 3): boolean {
  return next.state === "finished" && (next.outcome === "failed" || next.outcome === "cancelled") &&
    next.files === undefined && previous.state !== "finished" && previous.state !== "scope_declined" &&
    (version === 1 || previous.state !== "promotion_started");
}

function executionFinishedTransition(previous: Extract<OutcomeEvent, { state: "execution_finished" }>,
  next: OutcomeEvent): boolean {
  if (previous.result.status === "passed") return next.state === "review_ready";
  return next.state === "finished" &&
    next.outcome === (previous.result.status === "cancelled" ? "cancelled" : "execution_failed");
}

function decisionTransition(previous: Extract<OutcomeEvent, { state: "decision_recorded" }>,
  next: OutcomeEvent): boolean {
  if (previous.decision === "accept") return next.state === "promotion_started" &&
    next.reviewSha256 === previous.reviewSha256;
  return next.state === "finished" && next.outcome === "rejected" && next.files === undefined;
}

function reviewTransition(previous: Extract<OutcomeEvent, { state: "review_ready" }>, next: OutcomeEvent,
  version: 1 | 2 | 3): boolean {
  if (previous.revision === "R1") {
    return next.state === "decision_recorded" && next.reviewSha256 === previous.reviewSha256;
  }
  if (next.state === "decision_recorded") return next.reviewSha256 === previous.reviewSha256;
  return version === 3 && next.state === "correction_approved" && next.parentReviewSha256 === previous.reviewSha256;
}

function revisionFinishedTransition(previous: Extract<OutcomeEvent, { state: "revision_finished" }>,
  next: OutcomeEvent): boolean {
  if (previous.result.status === "passed") return next.state === "review_ready" && next.revision === "R1" &&
    next.parentReviewSha256 === previous.parentReviewSha256;
  return next.state === "finished" &&
    next.outcome === (previous.result.status === "cancelled" ? "cancelled" : "execution_failed");
}

function promotionTransition(next: OutcomeEvent): boolean {
  if (next.state !== "finished") return false;
  if (next.outcome === "promoted") return next.files !== undefined && next.files.length > 0;
  return next.outcome === "promotion_not_applied" && next.files === undefined;
}

function transitionAllowed(previous: InitialEvent | OutcomeEvent, next: OutcomeEvent, version: 1 | 2 | 3): boolean {
  if (Date.parse(next.timestamp) < Date.parse(previous.timestamp)) return false;
  if (next.state === "finished" && next.outcome === "promotion_not_applied" && version === 1) return false;
  if (terminalInterruptionAllowed(previous, next, version)) return true;
  switch (previous.state) {
    case "awaiting_scope_approval": return next.state === "scope_declined" || next.state === "execution_started";
    case "execution_started": return next.state === "execution_finished";
    case "execution_finished": return executionFinishedTransition(previous, next);
    case "review_ready": return reviewTransition(previous, next, version);
    case "correction_approved": return version === 3 && next.state === "revision_started" &&
      next.parentReviewSha256 === previous.parentReviewSha256;
    case "revision_started": return version === 3 && next.state === "revision_finished" &&
      next.parentReviewSha256 === previous.parentReviewSha256;
    case "revision_finished": return revisionFinishedTransition(previous, next);
    case "decision_recorded": return decisionTransition(previous, next);
    case "promotion_started": return promotionTransition(next);
    default: return false;
  }
}

function cumulativeHostChecks(event: OutcomeEvent, previous: number): number {
  const accounting = (event.state === "execution_finished" || event.state === "revision_finished")
    ? event.result.accounting.resources?.hostChecks : undefined;
  const recorded = "hostChecks" in event ? event.hostChecks : undefined;
  const next = recorded ?? accounting ?? previous;
  if (recorded !== undefined && accounting !== undefined && recorded < accounting || next < previous) {
    throw new Error("Invalid task outcome accounting");
  }
  return next;
}

function parseEvents(values: readonly unknown[]): readonly [InitialEvent, ...OutcomeEvent[]] {
  const first = initialSchema.parse(values[0]);
  const events: OutcomeEvent[] = [];
  let previous: InitialEvent | OutcomeEvent = first;
  let hostChecks = 0;
  for (const value of values.slice(1)) {
    const event = eventSchema.parse(value);
    if (first.version !== 3 && (event.state === "correction_approved" || event.state === "revision_started" ||
        event.state === "revision_finished" || event.state === "review_ready" &&
        (event.revision === "R1" || event.parentReviewSha256 !== undefined))) {
      throw new Error("Invalid task outcome version");
    }
    if (first.version !== 3 && event.state === "execution_finished" &&
        (event.result.accounting.causes !== undefined || event.result.accounting.resources !== undefined)) {
      throw new Error("Invalid task outcome version");
    }
    if (first.version !== 3 && "hostChecks" in event && event.hostChecks !== undefined) {
      throw new Error("Invalid task outcome version");
    }
    hostChecks = cumulativeHostChecks(event, hostChecks);
    if (!transitionAllowed(previous, event, first.version)) throw new Error("Invalid task outcome transition");
    events.push(event);
    previous = event;
  }
  return [first, ...events];
}

function outcomePhase(events: readonly [InitialEvent, ...OutcomeEvent[]]): TaskOutcomePhase {
  const last = events.at(-1) ?? events[0];
  if (last.state !== "finished") return last.state;
  const previous = events.at(-2) ?? events[0];
  if (previous.state === "finished") throw new Error("Invalid task outcome history");
  return previous.state;
}

function scopeApproval(events: readonly [InitialEvent, ...OutcomeEvent[]], last: InitialEvent | OutcomeEvent):
"pending" | "approved" | "declined" {
  if (last.state === "scope_declined") return "declined";
  return events.some((event) => event.state === "execution_started") ? "approved" : "pending";
}

function promotionState(events: readonly [InitialEvent, ...OutcomeEvent[]], last: InitialEvent | OutcomeEvent):
"not_reached" | "not_applied" | "unconfirmed" | "applied" {
  if (last.state === "finished" && last.outcome === "promoted") return "applied";
  if (last.state === "finished" && last.outcome === "promotion_not_applied") return "not_applied";
  return events.some((event) => event.state === "promotion_started") ? "unconfirmed" : "not_reached";
}

function project(events: readonly [InitialEvent, ...OutcomeEvent[]]): TaskOutcome {
  const first = events[0];
  const last = events.at(-1) ?? first;
  const executionEvent = events.findLast((event): event is Extract<OutcomeEvent,
    { state: "execution_finished" | "revision_finished" }> =>
    event.state === "execution_finished" || event.state === "revision_finished");
  const decisionEvent = events.findLast((event): event is Extract<OutcomeEvent, { state: "decision_recorded" }> =>
    event.state === "decision_recorded");
  const declined = last.state === "scope_declined";
  const started = Date.parse(first.timestamp);
  const updated = Date.parse(last.timestamp);
  const status = last.state === "finished" ? last.outcome : last.state;
  const recordedHostChecks = events.findLast((event): event is OutcomeEvent & { hostChecks: number } =>
    "hostChecks" in event && event.hostChecks !== undefined)?.hostChecks;
  const executionAccounting = executionEvent?.result.accounting;
  const execution = executionAccounting === undefined ? null : recordedHostChecks === undefined ||
      executionAccounting.resources === undefined ? executionAccounting : {
      ...executionAccounting, resources: { ...executionAccounting.resources, hostChecks: recordedHostChecks } };
  return { proposalId: first.proposalId, proposalSha256: first.proposalSha256, baseline: first.baseline,
    status, lastPhase: outcomePhase(events), terminal: declined || last.state === "finished",
    elapsedMs: Math.max(0, updated - started),
    candidate: executionEvent?.candidate ?? null, firstCheck: executionEvent?.result.accounting.firstCheck ?? "not_observed",
    correctionAttempts: executionEvent?.result.accounting.correctionAttempts ?? 0,
    execution,
    operator: { scopeApproval: scopeApproval(events, last),
      decision: decisionEvent?.decision ?? "not_reached" },
    promotion: promotionState(events, last),
    authority: "none", provenance: "recorded_untrusted" };
}

async function readBounded(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 65_536 ||
      relative(path, await realpath(path)) !== "") throw new Error("Task outcome unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > 65_536) throw new Error("Task outcome unavailable");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
}

export async function loadTaskOutcome(directory: string): Promise<TaskOutcome> {
  try {
    const text = await readBounded(join(directory, "start.jsonl"));
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0 || lines.length > 12) throw new Error("Invalid task outcome length");
    return project(parseEvents(lines.map((line) => JSON.parse(line))));
  } catch { throw new Error("Task outcome unavailable"); }
}

export async function loadProposalTaskOutcome(proposalsRoot: string, reference: string): Promise<TaskOutcome> {
  const proposal = await loadTaskProposal(proposalsRoot, reference);
  const outcome = await loadTaskOutcome(proposal.directory);
  if (outcome.proposalId !== proposal.record.id || outcome.proposalSha256 !== proposal.sha256 ||
      outcome.baseline !== proposal.record.baseline) throw new Error("Task outcome unavailable");
  return outcome;
}

export async function createTaskOutcome(directory: string, identity: Readonly<{
  proposalId: string; proposalSha256: string; baseline: string;
}>, now: () => Date = () => new Date()): Promise<TaskOutcomeJournal> {
  const path = join(directory, "start.jsonl");
  const initial = initialSchema.parse({ format: "tesota-task-outcome", version: 3,
    state: "awaiting_scope_approval", ...identity, timestamp: now().toISOString(), authority: "none" });
  const file = await open(path, "wx", 0o600);
  const events: [InitialEvent, ...OutcomeEvent[]] = [initial];
  try { await file.writeFile(JSON.stringify(initial) + "\n"); await file.sync(); }
  catch (error) { await file.close(); throw error; }
  return {
    append: async (input): Promise<void> => {
      const event = eventSchema.parse({ ...input, timestamp: now().toISOString() });
      parseEvents([...events, event]);
      await file.writeFile(JSON.stringify(event) + "\n");
      await file.sync();
      events.push(event);
    },
    current: (): TaskOutcome => project(events),
    close: async (): Promise<void> => { await file.close(); },
  };
}

function applicationSummary(promotion: TaskOutcome["promotion"]): string {
  switch (promotion) {
    case "applied": return "Applied";
    case "not_applied": return "Not applied";
    case "unconfirmed": return "Unconfirmed; inspect retained evidence before retrying";
    case "not_reached": return "Not applied";
  }
}

export function formatTaskOutcome(outcome: TaskOutcome): string {
  const execution = outcome.execution === null ? "Execution: not observed\n" :
    `Execution: ${outcome.execution.modelInvocations} model invocations, ${outcome.execution.toolCalls} tool calls, ${outcome.execution.edits} edits\n`;
  const consumption = outcome.execution === null ? "Consumption: unavailable.\n" :
    "Consumption: operation counts only; token usage and cost unavailable.\n";
  const causes = outcome.execution?.causes === undefined ? "" :
    `Execution causes: initial implementation ${outcome.execution.causes.initialImplementation ? "observed" : "not current"}; ` +
    `diagnostic repairs ${outcome.execution.causes.diagnosticRepairs}; semantic revision ` +
    `${outcome.execution.causes.semanticRevision ? "observed" : "not current"}\n`;
  const hostChecks = outcome.execution?.resources === undefined ? "" :
    `Host checks observed: ${outcome.execution.resources.hostChecks}\n`;
  return `\nTask outcome\nOutcome: ${outcome.status}\nElapsed: ${outcome.elapsedMs} ms\n` +
    `Last phase: ${outcome.lastPhase}\nFirst check: ${outcome.firstCheck}\nCorrections: ${outcome.correctionAttempts}\n${execution}` +
    `${causes}${hostChecks}Decision: ${outcome.operator.decision}\nApplication: ${applicationSummary(outcome.promotion)}\n${consumption}` +
    "Authority: none; this outcome cannot authorize execution, acceptance or application.\n";
}
