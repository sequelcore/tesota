import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Finding, FindingStanding, ReviewInput, ReviewReport } from "../review.js";
import { type ModelAccess, startModelSession } from "./model-session.js";
import { type LimitedTurnResult, REVIEW_TIME_LIMIT_MS, runWithTimeLimit } from "./model-session-contract.js";
import { readOnlyFileTools, repositoryInstructions } from "./pi-coding-session.js";
import { reviewMessage } from "./pi-reviewer.js";

/**
 * The refuter (decision 016): a cold, read-only session that tries to
 * disprove every finding before any of it can act. It sees the request
 * record, the candidate, the verifier results and each finding's claim, but
 * not the reviewer's session, to avoid inheriting its reasoning.
 */

export type RefutationVerdict = "confirmed" | "refuted" | "undetermined";

export interface Refutation {
  readonly id: number;
  readonly verdict: RefutationVerdict;
  /** The code, output or reasoning that settles it. */
  readonly evidence: string;
  /** An earlier finding's number when this one reports the same problem. */
  readonly duplicateOf?: number;
}

const verdictSchema = Type.Object({ verdicts: Type.Array(Type.Object({
  id: Type.Integer({ minimum: 1, description: "The finding's number" }),
  verdict: Type.Union([Type.Literal("confirmed"), Type.Literal("refuted"), Type.Literal("undetermined")]),
  evidence: Type.String({ description: "For confirmed: the code lines or check output that show the problem. " +
    "For refuted: what shows it is not a problem. For undetermined: what is missing." }),
  duplicateOf: Type.Optional(Type.Integer({ minimum: 1, description:
    "The number of an earlier finding that reports the same problem at the same place, if any" })),
})) });

function recordVerdicts(record: (verdicts: readonly Refutation[]) => void): ToolDefinition {
  return defineTool({ name: "record_verdicts", label: "Record verdicts",
    description: "Record one verdict per finding once you have investigated them all. Call it exactly once.",
    parameters: verdictSchema,
    execute: async (_id, value) => {
      record(value.verdicts);
      return { content: [{ type: "text", text: "Recorded." }], details: undefined, terminate: true };
    } });
}

function refuterPrompt(root: string): string {
  return "You are Tesota's refuter. Reviewers raised findings about a change another agent made; your job is to " +
    "disprove them. For each finding, investigate the code with the read, search and list tools and decide:\n" +
    "- confirmed: you can point to the code lines or check output that show the problem exists and that it " +
    "affects what the user asked for. Quote them.\n" +
    "- refuted: the code, the requests or the checks show it is not a problem, it was already handled, it rests " +
    "on an assumption the requests do not state, or it is speculation about code nobody showed is affected.\n" +
    "- undetermined: you cannot establish either with the evidence available.\n" +
    "Do not confirm a finding because it sounds plausible or because a reviewer was confident. Correct code is " +
    "often judged non-conformant by mistake, so look for the evidence that it is correct first. Several reviewers " +
    "may report the same problem: when a finding reports the same problem at the same place as an earlier one, " +
    "give that earlier number as duplicateOf. When you are done, " +
    "call record_verdicts once with a verdict for every finding." +
    `\n\nPlatform: ${process.platform}.` + repositoryInstructions(root);
}

function describeFinding(finding: Finding, id: number): string {
  const where = finding.path === undefined ? "" : ` at ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
  return `${id}. [${finding.severity}, ${finding.origin}]${where}: ${finding.statement}\n   Reviewer's reason: ${finding.reason}`;
}

/** Lines at most this far apart in one file count as the same place, as Codex deduplicates by changed location. */
const nearbyLines = 3;

function samePlace(first: Finding, second: Finding): boolean {
  if (first.path === undefined || first.path !== second.path) return false;
  if (first.line === undefined || second.line === undefined) return first.line === second.line;
  return Math.abs(first.line - second.line) <= nearbyLines;
}

/**
 * Findings at the same place, as groups of 1-based numbers: candidates for
 * one problem reported several times, as Bugbot buckets similar bugs before
 * consolidating them. Only the refuter decides whether they are one problem.
 */
export function locationGroups(findings: readonly Finding[]): number[][] {
  const groups: number[][] = [];
  const grouped = new Set<number>();
  findings.forEach((finding, index) => {
    if (grouped.has(index)) return;
    const group = [index];
    for (let other = index + 1; other < findings.length; other++) {
      const candidate = findings[other];
      if (!grouped.has(other) && candidate !== undefined && group.some((member) => samePlace(findings[member] ?? candidate, candidate))) {
        group.push(other);
      }
    }
    if (group.length > 1) {
      for (const member of group) grouped.add(member);
      groups.push(group.map((member) => member + 1));
    }
  });
  return groups;
}

/** What the refuter is told: the review input, the findings numbered across every report, and where they coincide. */
export function refutationMessage(input: ReviewInput, findings: readonly Finding[]): string {
  const groups = locationGroups(findings);
  const places = groups.length === 0 ? "" : "\n\nFindings at the same place, which may report one problem more than " +
    "once. For each group, mark every later finding that reports the same problem as an earlier one with duplicateOf; " +
    "keep findings that report different problems separate:\n" + groups.map((group) => {
      const first = findings[(group[0] ?? 1) - 1];
      return `- ${group.join(", ")} at ${first?.path ?? "the same file"}${first?.line === undefined ? "" : `:${first.line}`}`;
    }).join("\n");
  return `${reviewMessage(input)}\n\nFindings to test, one verdict each:\n${findings.map((finding, index) =>
    describeFinding(finding, index + 1)).join("\n")}${places}`;
}

function standingOf(verdict: RefutationVerdict | undefined): FindingStanding {
  return verdict === "confirmed" ? "confirmed" : verdict === "refuted" ? "refuted" : "unsettled";
}

/**
 * Give each finding its standing from the refuter's verdicts, numbered in
 * report order. A finding without a verdict, or every finding when the
 * refuter did not finish, is unsettled: never confirmed or cleared by omission.
 */
export function applyRefutation(reports: readonly ReviewReport[], verdicts: readonly Refutation[] | undefined): ReviewReport[] {
  const numbered = reports.flatMap((report) => report.status === "completed"
    ? report.findings.map((finding) => ({ reviewer: report.reviewer, finding })) : []);
  let id = 0;
  return reports.map((report) => {
    if (report.status !== "completed") return report;
    return { ...report, findings: report.findings.map((finding) => {
      id += 1;
      const verdict = verdicts?.find((entry) => entry.id === id);
      // Only a strictly earlier finding in the same file and of the same origin can be the original: duplicates
      // cannot form a cycle, a mistaken verdict cannot merge problems in different files, and a defect the change
      // introduced is never hidden behind one whose cause is unknown or that was already there.
      const candidate = verdict?.duplicateOf !== undefined && verdict.duplicateOf < id ? numbered[verdict.duplicateOf - 1] : undefined;
      const original = candidate !== undefined && candidate.finding.path !== undefined && candidate.finding.path === finding.path &&
        candidate.finding.origin === finding.origin ? candidate : undefined;
      return { ...finding, standing: standingOf(verdict?.verdict),
        ...(verdict === undefined ? {} : { refutation: verdict.evidence }),
        ...(original === undefined ? {} : { duplicateOf: `${original.reviewer}: ${original.finding.statement}` }) };
    }) };
  });
}

/** The refuter's verdicts, or undefined when it did not record them. */
export function verdictsFrom(turn: LimitedTurnResult, recorded: readonly Refutation[] | undefined): readonly Refutation[] | undefined {
  return turn.status === "cancelled" || turn.status === "unsettled" || turn.status === "timed_out" ? undefined : recorded;
}

export type RefuterOptions = ModelAccess;

/** Test every finding in the reports and return them with their standing. */
export async function refuteFindings(options: RefuterOptions, input: ReviewInput, reports: readonly ReviewReport[],
  signal: AbortSignal): Promise<ReviewReport[]> {
  const findings = reports.flatMap((report) => report.status === "completed" ? report.findings : []);
  if (findings.length === 0) return [...reports];
  let recorded: readonly Refutation[] | undefined;
  const session = await startModelSession(options, { cwd: input.checkout, systemPrompt: refuterPrompt(input.checkout),
    tools: [...readOnlyFileTools(input.checkout), recordVerdicts((verdicts) => { recorded ??= verdicts; })] });
  try {
    const turn = await runWithTimeLimit(session, refutationMessage(input, findings), signal, REVIEW_TIME_LIMIT_MS);
    return applyRefutation(reports, verdictsFrom(turn, recorded));
  } finally { session.dispose(); }
}
