import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@earendil-works/pi-ai";
import type { Finding, ReviewInput, ReviewReport, Reviewer } from "../review.js";
import { type ModelAccess, type ModelSession, runRole, startModelSession } from "./model-session.js";
import type { CodingTurnResult } from "./pi-coding-session.js";

/**
 * ClaimCheck's round-trip method (metareflection/claimcheck, MIT), adapted to
 * LemmaScript contracts proved by Tesota's verifier and run through Tesota's
 * model route. Pass 1 restates each proved contract without seeing the
 * user's requests; pass 2, a separate session, compares that restatement
 * with the requests. ClaimCheck uses two different models for the passes;
 * with one route, Tesota keeps them apart by context only.
 */

const REVIEWER = "ClaimCheck method";

/** A proved LemmaScript contract: its annotations and the function they govern. */
export interface Contract {
  readonly path: string;
  readonly name: string;
  readonly text: string;
  /** The contract's first annotation line and its declaration line. */
  readonly line: number;
  readonly endLine: number;
}

/** The `//@` blocks directly above a function declaration; annotations inside bodies belong to proofs, not contracts. */
export function contracts(path: string, source: string): Contract[] {
  const found: Contract[] = [];
  let block: string[] = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line.startsWith("//@")) { block.push(line); continue; }
    const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(line);
    if (declaration !== null && block.length > 0) {
      found.push({ path, name: declaration[1] ?? "", text: [...block, line].join("\n"), line: index + 1 - block.length,
        endLine: index + 1 });
    }
    if (line.length > 0) block = [];
  }
  return found;
}

const informalizationSchema = Type.Object({ informalizations: Type.Array(Type.Object({
  name: Type.String(),
  preconditions: Type.String({ description: "What the requires clauses assume, literally" }),
  postcondition: Type.String({ description: "What the ensures clauses guarantee, literally" }),
  strength: Type.Union([Type.Literal("trivial"), Type.Literal("weak"), Type.Literal("moderate"), Type.Literal("strong")]),
})) });
const comparisonSchema = Type.Object({ comparisons: Type.Array(Type.Object({
  name: Type.String(),
  verdict: Type.Union([Type.Literal("justified"), Type.Literal("partially_justified"), Type.Literal("not_justified"),
    Type.Literal("vacuous")]),
  disposition: Type.Union([Type.Literal("fixable"), Type.Literal("operator")], { description:
    "fixable: the contract clearly says less or other than the requests and can be corrected; operator: it depends on intent" }),
  explanation: Type.String(),
})) });
/** Pass 1's literal restatement of one contract. */
export interface Informalization {
  readonly name: string;
  readonly preconditions: string;
  readonly postcondition: string;
  readonly strength: "trivial" | "weak" | "moderate" | "strong";
}

/** Pass 2's judgment of one contract against the requests. */
export interface Comparison {
  readonly name: string;
  readonly verdict: "justified" | "partially_justified" | "not_justified" | "vacuous";
  readonly disposition: "fixable" | "operator";
  readonly explanation: string;
}

function recordTool<T extends typeof informalizationSchema | typeof comparisonSchema>(name: string, schema: T,
  record: (value: Static<T>) => void): ToolDefinition {
  return defineTool({ name, label: name, description: "Record your answer. Call it exactly once.", parameters: schema,
    execute: async (_id, value) => {
      record(value);
      return { content: [{ type: "text", text: "Recorded." }], details: undefined, terminate: true };
    } });
}

function contractList(items: readonly Contract[]): string {
  return items.map((item, index) => `### Function ${index + 1}: ${item.name} (${item.path})\n\n\`\`\`typescript\n${item.text}\n\`\`\``).join("\n\n");
}

/** Pass 1. It must never contain the user's requests. */
export function informalizePrompt(items: readonly Contract[]): string {
  return "You are reading LemmaScript function contracts, already proved by Dafny, and translating them to plain " +
    `English.\n\n## Contracts\n\n${contractList(items)}\n\n## Instructions\n\nFor each function contract, describe ` +
    "literally what it guarantees, not what you think the author intended. State the preconditions (requires) and " +
    "postconditions (ensures) separately. Rate the claim's strength: trivial if the ensures restates the requires, " +
    "is always true, or follows from definitions; weak if it says very little; moderate if it makes a substantive " +
    "claim; strong if it significantly constrains behavior. Flag ensures clauses that mirror requires clauses.\n\n" +
    "Call record_informalizations with one entry per function.";
}

/** Pass 2: the requests against the restatements, with the contracts for reference. */
export function comparePrompt(requests: readonly string[], items: readonly Contract[],
  informalizations: readonly Informalization[]): string {
  const pairs = items.map((item) => {
    const back = informalizations.find((entry) => entry.name === item.name);
    return `### ${item.name} (${item.path})\n\n\`\`\`typescript\n${item.text}\n\`\`\`\n\n**Back-translation:**\n` +
      `- Preconditions: ${back?.preconditions ?? "(missing)"}\n- Postcondition: ${back?.postcondition ?? "(missing)"}\n` +
      `- Strength: ${back?.strength ?? "(missing)"}`;
  }).join("\n\n");
  return "You are checking whether proved LemmaScript contracts express what the user asked for. Each " +
    "back-translation was written in a separate session that did not see the user's requests.\n\n" +
    `## The user's requests, verbatim\n\n${requests.map((request, index) => `${index + 1}. ${request}`).join("\n") ||
      "(not recorded)"}\n\n## Contracts\n\n${pairs}\n\n## Watch for\n\n1. Tautology: the ensures restates the requires.\n` +
    "2. Weakened postcondition: the ensures says less than the requests ask.\n3. Narrowed scope: only some of " +
    "the cases the requests describe.\n4. Missing case: the requests have several conditions and the contract " +
    "captures some.\n5. Wrong property: something related but different.\n\nBe strict about quantifiers and boundaries " +
    "(`<` against `<=`), but do not flag different wording with the same meaning. A contract that is not about " +
    "anything the requests mention is justified if it is consistent with them. A trivial back-translation is almost " +
    "always a mismatch.\n\nCall record_comparisons with one entry per function.";
}

function finding(item: Contract, comparison: Comparison): Finding | undefined {
  if (comparison.verdict === "justified") return undefined;
  const verdict = comparison.verdict === "vacuous" ? "proves nothing beyond its assumptions" :
    comparison.verdict === "partially_justified" ? "covers only part of what was asked" : "does not express what was asked";
  // Introduced when the candidate wrote or changed the contract; Tesota checks that against the diff.
  return { severity: comparison.verdict === "partially_justified" ? "medium" : "high", disposition: comparison.disposition,
    origin: "introduced",
    path: item.path, line: item.line, endLine: item.endLine, statement: `The proved contract of ${item.name} ${verdict}.`, reason: comparison.explanation };
}

/** Findings from the comparisons; a contract left without a comparison makes the review unfinished. */
export function claimcheckReport(tree: string, items: readonly Contract[],
  comparisons: readonly Comparison[] | undefined, turn: CodingTurnResult): ReviewReport {
  if (turn.status === "cancelled" || turn.status === "unsettled" || comparisons === undefined) {
    return { reviewer: REVIEWER, tree, status: "incomplete",
      reason: turn.status === "failed" ? `the model request failed: ${turn.reason}` : "the comparison was not recorded" };
  }
  const missing = items.filter((item) => !comparisons.some((comparison) => comparison.name === item.name));
  if (missing.length > 0) {
    return { reviewer: REVIEWER, tree, status: "incomplete",
      reason: `no comparison for ${missing.map((item) => item.name).join(", ")}` };
  }
  const findings = items.flatMap((item) => {
    const result = finding(item, comparisons.find((comparison) => comparison.name === item.name) as Comparison);
    return result === undefined ? [] : [result];
  });
  return { reviewer: REVIEWER, tree, status: "completed", findings,
    summary: `${items.length - findings.length} of ${items.length} proved contracts express what was asked.` };
}

export interface ClaimCheckOptions extends ModelAccess {
  /** Reads a file from the candidate's frozen tree. */
  readonly read: (path: string) => string | undefined;
}

/** Runs only when LemmaScript proved contracts in this candidate; otherwise there is nothing to compare. */
export function createClaimCheckReviewer(options: ClaimCheckOptions): Reviewer {
  return {
    name: REVIEWER,
    async review(input: ReviewInput, signal: AbortSignal): Promise<ReviewReport> {
      const proved = input.checks.filter((check) => check.verifier === "lemmascript" && check.outcome === "passed")
        .map((check) => check.command.replace(/^lemmascript /u, ""));
      const items = proved.flatMap((path) => { const source = options.read(path); return source === undefined ? [] : contracts(path, source); });
      const tree = input.snapshot.tree;
      if (items.length === 0) return { reviewer: REVIEWER, tree, status: "completed", findings: [], summary: "No proved contracts to compare." };
      const session = (tool: ToolDefinition): Promise<ModelSession> => startModelSession(options, { cwd: input.checkout,
        tools: [tool],
        systemPrompt: "You compare formal specifications with natural-language requirements. Answer only through the tool you are given." });
      let informalizations: readonly Informalization[] | undefined;
      const first = await session(recordTool("record_informalizations", informalizationSchema, (value) => { informalizations = value.informalizations; }));
      let turn: CodingTurnResult;
      try { turn = await runRole(first, informalizePrompt(items), signal); } finally { first.dispose(); }
      if (informalizations === undefined) return claimcheckReport(tree, items, undefined, turn);
      let comparisons: readonly Comparison[] | undefined;
      const second = await session(recordTool("record_comparisons", comparisonSchema, (value) => { comparisons = value.comparisons; }));
      try { turn = await runRole(second, comparePrompt(input.requests, items, informalizations), signal); } finally { second.dispose(); }
      return claimcheckReport(tree, items, comparisons, turn);
    },
  };
}
