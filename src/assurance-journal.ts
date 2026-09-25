import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewReport } from "./review.js";
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
      flags: readonly VerificationChange[]; reviews: readonly ReviewReport[] }>
  | Readonly<{ kind: "decision"; at: string; tree: string; decision: AssuranceDecision }>;

export function reviewEntry(snapshot: WorkspaceSnapshot, requests: readonly string[], checks: readonly CheckResult[],
  flags: readonly VerificationChange[], reviews: readonly ReviewReport[]): AssuranceEntry {
  return { kind: "review", at: new Date().toISOString(), base: snapshot.base, tree: snapshot.tree, requests, flags, reviews,
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
