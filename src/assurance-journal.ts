import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { TriageDecision } from "./integrations/answer-triage.js";
import type { Finding, ReviewReport, ToolCallRecord } from "./review.js";
import type { DepthDecision } from "./review-depth.js";
import type { ReviewMeasurement } from "./review-forecast.js";
import type { CorrectionContext } from "./tesota-shell.js";
import type { VerificationChange } from "./verification-changes.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * The workspace's assurance journal (decision 015): one line per reviewed
 * candidate, with what was asked, what each verifier claimed and observed,
 * what each reviewer found, and the operator's decision, one per correction
 * sent back to the agent, and one per answer check's first pass. It sits beside the
 * checkout, out of the agent's reach, and is only ever appended to.
 */
const journalFile = "assurance.jsonl";
const outputTail = 2_000;
const subjectLimit = 300;

export type AssuranceDecision = "applied" | "rejected" | "application_conflict" | "application_rolled_back" |
  "application_recovery_required" | "kept" | "reverted" | "revert_conflict" | "revert_rolled_back" | "revert_recovery_required" |
  "redone" | "redo_conflict" | "redo_rolled_back" | "redo_recovery_required";

type JournaledCheck = Readonly<Pick<CheckResult, "verifier" | "command" | "claim" | "limits" | "environment" | "outcome" |
  "exitCode" | "durationMs" | "output" | "base" | "baseDurationMs" | "relatedTo">>;

function journaledCheck(check: CheckResult): JournaledCheck {
  return { verifier: check.verifier, command: check.command, claim: check.claim,
    limits: check.limits, environment: check.environment, outcome: check.outcome, exitCode: check.exitCode,
    durationMs: check.durationMs, ...(check.base === undefined ? {} : { base: check.base }),
    ...(check.baseDurationMs === undefined ? {} : { baseDurationMs: check.baseDurationMs }),
    ...(check.relatedTo === undefined ? {} : { relatedTo: check.relatedTo }), output: check.output.slice(-outputTail) };
}

/** What a review judged: a candidate's changes, or an answer from a turn that changed no files (decision 034). */
export type ReviewSubject = "changes" | "answer";

export type AssuranceEntry =
  | Readonly<{ kind: "review"; subject: ReviewSubject; at: string; base: string; tree: string; requests: readonly string[];
      checks: readonly JournaledCheck[];
      flags: readonly VerificationChange[]; reviews: readonly ReviewReport[]; depth?: DepthDecision;
      measurement?: ReviewMeasurement }>
  | Readonly<{ kind: "checks"; at: string; base: string; tree: string; checks: readonly JournaledCheck[] }>
  | Readonly<{ kind: "correction"; at: string; tree: string; sentBack: readonly Finding[] }>
  | Readonly<{ kind: "decision"; at: string; tree: string; decision: AssuranceDecision }>
  | Readonly<{ kind: "triage"; at: string; tree: string; requests: readonly string[]; model: string;
      decided: boolean; checkable: boolean; probability?: number; reason: string; runsCheck: boolean;
      toolCalls: readonly ToolCallRecord[] }>;

export function reviewEntry(subject: ReviewSubject, snapshot: WorkspaceSnapshot, requests: readonly string[],
  checks: readonly CheckResult[], flags: readonly VerificationChange[], reviews: readonly ReviewReport[], depth?: DepthDecision,
  measurement?: ReviewMeasurement): AssuranceEntry {
  return { kind: "review", subject, at: new Date().toISOString(), base: snapshot.base, tree: snapshot.tree, requests, flags, reviews,
    ...(depth === undefined ? {} : { depth }), ...(measurement === undefined ? {} : { measurement }),
    checks: checks.map(journaledCheck) };
}

/** The whole approved commands' run on a reviewed candidate, after its rounds ran only their related forms. */
export function checksEntry(snapshot: WorkspaceSnapshot, checks: readonly CheckResult[]): AssuranceEntry {
  return { kind: "checks", at: new Date().toISOString(), base: snapshot.base, tree: snapshot.tree, checks: checks.map(journaledCheck) };
}

/** A correction sent back to the agent: the reviewed tree it corrects and the findings it was sent. */
export function correctionEntry(correction: CorrectionContext): AssuranceEntry {
  return { kind: "correction", at: new Date().toISOString(), tree: correction.previousTree, sentBack: correction.sentBack };
}

export function decisionEntry(tree: string, decision: AssuranceDecision): AssuranceEntry {
  return { kind: "decision", at: new Date().toISOString(), tree, decision };
}

/**
 * The answer check's first pass on a turn that changed no files, whether or
 * not the full check then ran, with the tool calls the check saw, so every decision,
 * a skip included, can be measured against what the turn held.
 */
export function triageEntry(tree: string, requests: readonly string[], model: string, decision: TriageDecision,
  runsCheck: boolean, toolCalls: readonly ToolCallRecord[]): AssuranceEntry {
  return { kind: "triage", at: new Date().toISOString(), tree, requests, model, decided: decision.decided,
    checkable: decision.checkable, ...(decision.probability === undefined ? {} : { probability: decision.probability }),
    reason: decision.reason, runsCheck, toolCalls: toolCalls.map((call) => ({ ...call, subject: call.subject.slice(0, subjectLimit) })) };
}

export async function appendAssurance(workspaceDirectory: string, entry: AssuranceEntry): Promise<void> {
  await appendFile(join(workspaceDirectory, journalFile), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

// Only what a reader of the open entries needs; the journal holds more, which these schemas pass over.
const journaledFinding = z.looseObject({ severity: z.enum(["high", "medium", "low"]), statement: z.string(),
  path: z.string().optional(), line: z.number().int().optional(), standing: z.enum(["confirmed", "refuted", "unsettled"]).optional(),
  duplicateOf: z.string().optional() });
const journaledReport = z.discriminatedUnion("status", [
  z.looseObject({ reviewer: z.string(), tree: z.string(), status: z.literal("completed"), summary: z.string(),
    findings: z.array(journaledFinding) }),
  z.looseObject({ reviewer: z.string(), tree: z.string(), status: z.literal("incomplete"), reason: z.string() }),
]);
const journaledEntry = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("review"), subject: z.enum(["changes", "answer"]), base: z.string(), tree: z.string(),
    reviews: z.array(journaledReport) }),
  z.looseObject({ kind: z.literal("correction"), tree: z.string(), sentBack: z.array(journaledFinding) }),
  z.looseObject({ kind: z.literal("decision"), tree: z.string(), decision: z.string() }),
  z.looseObject({ kind: z.literal("checks") }),
  z.looseObject({ kind: z.literal("triage") }),
]);
type JournaledEntry = z.infer<typeof journaledEntry>;

/** Decisions that settle what was reviewed before them; a redo after a revert puts the reviewed turn back. */
const settlingDecisions: ReadonlySet<string> = new Set(["applied", "rejected", "kept", "reverted", "redone"]);

/** What the journal holds of the pending changes, read once (#249). */
export interface OpenAssurance {
  /** The last review, of changes or of an answer, with what it found. */
  readonly review?: Readonly<{ tree: string; reviews: readonly ReviewReport[] }>;
  /** The candidate the last review of changes judged, where the next review begins. */
  readonly reviewed?: Pick<WorkspaceSnapshot, "base" | "tree">;
  /** A correction sent back after that review that no review has judged, after a stop or a restart too. */
  readonly correction?: CorrectionContext;
}

/**
 * What is still open in the journal: an entry stays open until the operator
 * applies, rejects, keeps or reverts what it concerns, and a later redo
 * reopens it.
 */
export async function openAssurance(workspaceDirectory: string): Promise<OpenAssurance> {
  const path = join(workspaceDirectory, journalFile);
  if (!existsSync(path)) return {};
  const entries = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0)
    .map((line) => journaledEntry.parse(JSON.parse(line)));
  const openAt = (index: number): JournaledEntry | undefined => {
    if (index < 0) return undefined;
    const last = entries.slice(index + 1).findLast((entry) => entry.kind === "decision" && settlingDecisions.has(entry.decision));
    return last?.kind !== "decision" || last.decision === "redone" ? entries[index] : undefined;
  };
  const changesAt = entries.findLastIndex((entry) => entry.kind === "review" && entry.subject === "changes");
  const correctionAt = entries.findLastIndex((entry) => entry.kind === "correction");
  const review = openAt(entries.findLastIndex((entry) => entry.kind === "review"));
  const changes = openAt(changesAt);
  // Only a correction sent after the last review of changes is still to be judged.
  const correction = correctionAt > changesAt ? openAt(correctionAt) : undefined;
  return {
    ...review?.kind === "review" ? { review: { tree: review.tree, reviews: review.reviews as unknown as ReviewReport[] } } : {},
    ...changes?.kind === "review" ? { reviewed: { base: changes.base, tree: changes.tree } } : {},
    ...correction?.kind === "correction"
      ? { correction: { previousTree: correction.tree, sentBack: correction.sentBack as unknown as Finding[] } } : {},
  };
}
