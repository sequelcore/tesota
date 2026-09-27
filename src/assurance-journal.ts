import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { ReviewReport } from "./review.js";
import type { DepthDecision } from "./review-depth.js";
import type { ReviewMeasurement } from "./review-forecast.js";
import type { VerificationChange } from "./verification-changes.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * The workspace's assurance journal (decision 015): one line per reviewed
 * candidate, with what was asked, what each verifier claimed and observed,
 * what each reviewer found, and the operator's decision. It sits beside the
 * checkout, out of the agent's reach, and is only ever appended to.
 */
const journalFile = "assurance.jsonl";
const outputTail = 2_000;

export type AssuranceDecision = "applied" | "rejected" | "application_conflict" | "application_uncertain";

export type AssuranceEntry =
  | Readonly<{ kind: "review"; at: string; base: string; tree: string; requests: readonly string[];
      checks: readonly Readonly<Pick<CheckResult, "verifier" | "command" | "claim" | "limits" | "environment" | "outcome" |
        "exitCode" | "output">>[];
      flags: readonly VerificationChange[]; reviews: readonly ReviewReport[]; depth?: DepthDecision;
      measurement?: ReviewMeasurement }>
  | Readonly<{ kind: "decision"; at: string; tree: string; decision: AssuranceDecision }>;

export function reviewEntry(snapshot: WorkspaceSnapshot, requests: readonly string[], checks: readonly CheckResult[],
  flags: readonly VerificationChange[], reviews: readonly ReviewReport[], depth?: DepthDecision,
  measurement?: ReviewMeasurement): AssuranceEntry {
  return { kind: "review", at: new Date().toISOString(), base: snapshot.base, tree: snapshot.tree, requests, flags, reviews,
    ...(depth === undefined ? {} : { depth }), ...(measurement === undefined ? {} : { measurement }),
    checks: checks.map((check) => ({ verifier: check.verifier, command: check.command, claim: check.claim,
      limits: check.limits, environment: check.environment, outcome: check.outcome, exitCode: check.exitCode,
      output: check.output.slice(-outputTail) })) };
}

export function decisionEntry(tree: string, decision: AssuranceDecision): AssuranceEntry {
  return { kind: "decision", at: new Date().toISOString(), tree, decision };
}

export async function appendAssurance(workspaceDirectory: string, entry: AssuranceEntry): Promise<void> {
  await appendFile(join(workspaceDirectory, journalFile), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

// Only what a reader of the last review needs; the journal holds more, which these schemas pass over.
const journaledFinding = z.looseObject({ severity: z.enum(["high", "medium", "low"]), statement: z.string(),
  path: z.string().optional(), line: z.number().int().optional(), standing: z.enum(["confirmed", "refuted", "unsettled"]).optional(),
  duplicateOf: z.string().optional() });
const journaledReport = z.discriminatedUnion("status", [
  z.looseObject({ reviewer: z.string(), tree: z.string(), status: z.literal("completed"), summary: z.string(),
    findings: z.array(journaledFinding) }),
  z.looseObject({ reviewer: z.string(), tree: z.string(), status: z.literal("incomplete"), reason: z.string() }),
]);
const journaledEntry = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("review"), tree: z.string(), reviews: z.array(journaledReport) }),
  z.looseObject({ kind: z.literal("decision"), tree: z.string(), decision: z.string() }),
]);

/**
 * The last review of the pending changes: the journal's last review, unless
 * the operator has since applied or rejected what it reviewed.
 */
export async function lastOpenReview(workspaceDirectory: string):
  Promise<Readonly<{ tree: string; reviews: readonly ReviewReport[] }> | undefined> {
  const path = join(workspaceDirectory, journalFile);
  if (!existsSync(path)) return undefined;
  const entries = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0)
    .map((line) => journaledEntry.parse(JSON.parse(line)));
  const index = entries.findLastIndex((entry) => entry.kind === "review");
  const review = entries[index];
  if (review?.kind !== "review") return undefined;
  const settled = entries.slice(index + 1).some((entry) => entry.kind === "decision" &&
    (entry.decision === "applied" || entry.decision === "rejected"));
  return settled ? undefined : { tree: review.tree, reviews: review.reviews as unknown as ReviewReport[] };
}
