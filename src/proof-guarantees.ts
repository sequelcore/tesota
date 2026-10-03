import { candidateLines } from "./diff-lines.js";
import { contracts } from "./integrations/pi-claimcheck.js";
import type { MutationResult } from "./proof-mutation.js";
import type { ReviewReport } from "./review.js";
import { proofCovered } from "./verification/proof-cover-rule.js";
import type { ContentReader } from "./verification/oxlint-verifier.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * What the candidate's LemmaScript contracts guarantee, for the result
 * panel's Guarantees view (docs/design/assurance.md, "Showing what was
 * guaranteed"): each contract in a changed annotated file as written, whether
 * it proved, what it assumes, what the candidate added to its assumptions,
 * how ClaimCheck compared it with the requests, and, apart, the changed lines
 * no proof covers (`proofCovered`).
 */

export type ProofOutcome = "proved" | "not proved" | "not run";

export interface ContractGuarantee {
  readonly path: string;
  readonly name: string;
  /** The contract's `//@` lines as written. */
  readonly lines: readonly string[];
  readonly outcome: ProofOutcome;
  /** Its `requires` and `assume` lines: what it takes as given. */
  readonly assumes: readonly string[];
  /** The `requires` and `assume` lines the candidate added, which narrow what was proved. */
  readonly narrowed: readonly string[];
  /** ClaimCheck's statement when it found the contract says less or other than was asked; undefined when it found nothing. */
  readonly mismatch?: string;
  /** Whether ClaimCheck compared this contract with the requests. */
  readonly compared: boolean;
  /** Proof-based mutation, for a contract the candidate added or changed and proved; absent otherwise. */
  readonly mutation?: MutationResult;
}

export interface Guarantees {
  readonly contracts: readonly ContractGuarantee[];
  /** Changed TypeScript lines no proof covers, by file, for the annotated files only. */
  readonly uncovered: readonly { readonly path: string; readonly lines: readonly number[] }[];
}

const assumptionLine = /^\/\/@\s+(requires|assume)\b/u;

/** The line of the brace that closes the function declared on line `declaration` (both 1-based); the declaration line when none closes. */
export function bodyEnd(source: string, declaration: number): number {
  const lines = source.split(/\r?\n/u);
  let depth = 0;
  let opened = false;
  for (let index = declaration - 1; index < lines.length; index += 1) {
    let quote: string | undefined;
    const line = lines[index] ?? "";
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      if (quote !== undefined) {
        if (char === "\\") at += 1;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "/" && line[at + 1] === "/") break;
      if (char === "\"" || char === "'" || char === "`") quote = char;
      else if (char === "{") { depth += 1; opened = true; } else if (char === "}") {
        depth -= 1;
        if (opened && depth === 0) return index + 1;
      }
    }
  }
  return declaration;
}

function proofOutcome(checks: readonly CheckResult[], path: string): ProofOutcome {
  const check = checks.find((entry) => entry.verifier === "lemmascript" && entry.command === `lemmascript ${path}`);
  return check === undefined ? "not run" : check.outcome === "passed" ? "proved" : check.outcome === "failed" ? "not proved" : "not run";
}

/**
 * Each contract in the candidate's changed annotated TypeScript files, and the
 * changed lines in them no proof covers; `mutation` holds `mutateContracts`'
 * results, keyed `path:name`.
 */
export function proofGuarantees(snapshot: WorkspaceSnapshot, checks: readonly CheckResult[], reviews: readonly ReviewReport[],
  read: ContentReader, mutation: ReadonlyMap<string, MutationResult> = new Map()): Guarantees {
  const changed = candidateLines(snapshot);
  const claimcheck = reviews.find((report) => report.reviewer === "ClaimCheck method");
  const found: ContractGuarantee[] = [];
  const uncovered: { path: string; lines: number[] }[] = [];
  for (const change of snapshot.changes) {
    if (change.status === "deleted" || !change.path.endsWith(".ts")) continue;
    const source = read(snapshot.tree, change.path);
    if (source === undefined) continue;
    const items = contracts(change.path, source);
    if (items.length === 0) continue;
    const before = new Set((read(snapshot.base, change.path) ?? "").split(/\r?\n/u).map((line) => line.trim()));
    const outcome = proofOutcome(checks, change.path);
    const starts: number[] = [];
    const ends: number[] = [];
    const proved: boolean[] = [];
    const narrowed: boolean[] = [];
    for (const item of items) {
      const lines = item.text.split("\n").filter((line) => line.startsWith("//@"));
      const assumes = lines.filter((line) => assumptionLine.test(line));
      const added = assumes.filter((line) => !before.has(line));
      const finding = claimcheck?.status === "completed"
        ? claimcheck.findings.find((entry) => entry.path === item.path && entry.line === item.line) : undefined;
      const mutated = mutation.get(`${item.path}:${item.name}`);
      found.push({ path: item.path, name: item.name, lines, outcome, assumes, narrowed: added,
        ...(finding === undefined ? {} : { mismatch: `${finding.statement} ${finding.reason}` }),
        compared: claimcheck?.status === "completed", ...(mutated === undefined ? {} : { mutation: mutated }) });
      starts.push(item.endLine);
      ends.push(bodyEnd(source, item.endLine));
      proved.push(outcome === "proved");
      narrowed.push(added.length > 0);
    }
    const lines = [...changed.get(change.path)?.added ?? []].sort((a, b) => a - b)
      .filter((line) => !proofCovered(line, starts, ends, proved, narrowed));
    if (lines.length > 0) uncovered.push({ path: change.path, lines });
  }
  return { contracts: found, uncovered };
}

/** Line numbers as short ranges: 3, 5-8, 12. */
export function lineRanges(lines: readonly number[]): string {
  const parts: string[] = [];
  let start: number | undefined;
  let previous = 0;
  for (const line of [...lines, Number.NaN]) {
    if (start !== undefined && line === previous + 1) { previous = line; continue; }
    if (start !== undefined) parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  return parts.join(", ");
}

const outcomeWords: Readonly<Record<ProofOutcome, string>> = { proved: "✓ proved", "not proved": "✗ not proved", "not run": "· not run" };

/**
 * What mutation found about one contract. A survivor proved after the change,
 * so the contract does not rule that behavior out; it may also behave the same
 * as the original, so it is reported, never called a defect.
 */
function mutationLines(result: MutationResult): string[] {
  const tried = result.rejected + result.survived.length + result.inconclusive;
  if (tried === 0) return ["    Mutation: no change to try in its body"];
  const unsettled = result.inconclusive === 0 ? "" : `; ${result.inconclusive} could not be decided`;
  if (result.survived.length === 0) {
    return [`    Mutation: all ${result.rejected} decided changes to its code made the proof fail${unsettled}`];
  }
  return [`    ! Mutation: ${result.survived.length} of ${tried} changes to its code still proved, so the contract does not ` +
    `rule them out (one may behave the same as the original)${unsettled}:`,
  ...result.survived.map((mutant) => `      line ${mutant.line}: ${mutant.before} became ${mutant.after}`)];
}

/** The Guarantees section of a review record; undefined when the candidate touched no contract. */
export function guaranteesDetail(guarantees: Guarantees): string | undefined {
  if (guarantees.contracts.length === 0) return undefined;
  const contractLines = guarantees.contracts.map((contract) => [
    `  ${outcomeWords[contract.outcome]} ${contract.name} in ${contract.path}`,
    ...contract.lines.map((line) => `    ${line}`),
    ...contract.assumes.length === 0 ? [] : [`    Takes as given: ${contract.assumes.map((line) => line.replace(/^\/\/@\s+/u, "")).join("; ")}`],
    ...contract.narrowed.length === 0 ? [] : [`    ! This change added: ${contract.narrowed.join("; ")}, which narrows what was proved`],
    contract.mismatch !== undefined ? `    ! ClaimCheck: ${contract.mismatch}`
      : contract.compared ? "    ClaimCheck found it expresses what was asked (a model's comparison, not a proof)"
        : "    ClaimCheck did not compare it",
    ...contract.mutation === undefined ? [] : mutationLines(contract.mutation),
  ].join("\n"));
  const uncovered = guarantees.uncovered.length === 0 ? "  Every changed line in these files is inside a proved function."
    : guarantees.uncovered.map((entry) => `  ${entry.path}: lines ${lineRanges(entry.lines)}`).join("\n");
  return `Guarantees\n${contractLines.join("\n\n")}\n\n  Not covered by a proof, so left to review:\n${uncovered}`;
}
