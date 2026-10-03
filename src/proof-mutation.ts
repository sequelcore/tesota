import { basename } from "node:path";
import { contracts } from "./integrations/pi-claimcheck.js";
import { bodyEnd } from "./proof-guarantees.js";
import { annotations, proveSource } from "./verification/lemmascript-verifier.js";
import type { ContentReader } from "./verification/oxlint-verifier.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import type { CheckResult } from "./workspace-checks.js";

/**
 * Proof-based mutation (docs/design/assurance.md, "Checking the contract
 * itself"): for each contract the candidate added or changed and proved,
 * small fixed changes to its function's body, each proved again. A mutant
 * that still proves is behavior the contract does not rule out. This is the
 * completeness metric of Lahiri (FMCAD 2024) with the prover in place of
 * tests; no model decides it.
 */

export type MutationOperator = "result" | "comparison" | "constant" | "arithmetic";

export interface Mutant {
  /** The line changed, 1-based. */
  readonly line: number;
  readonly operator: MutationOperator;
  /** The text replaced and what replaced it. */
  readonly before: string;
  readonly after: string;
  /** The whole file with this one change. */
  readonly source: string;
}

export interface MutationResult {
  /** Mutants whose proof failed: the contract ruled them out. */
  readonly rejected: number;
  /** Mutants that still proved: behavior the contract does not rule out. */
  readonly survived: readonly Pick<Mutant, "line" | "operator" | "before" | "after">[];
  /** Mutants whose proof timed out or could not run, which count as neither. */
  readonly inconclusive: number;
}

/** At most this many mutants per contract, each one Dafny run of seconds. */
export const MUTANT_LIMIT = 8;

const comparisons: Readonly<Record<string, string>> = { "<=": "<", ">=": ">", "<": "<=", ">": ">=", "===": "!==", "!==": "===" };

/** The line with every string and `//` comment blanked to spaces, so columns still match the original. */
function codeOf(line: string): string {
  let code = "";
  let quote: string | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] ?? "";
    if (quote === undefined && char === "/" && line[at + 1] === "/") return code.padEnd(line.length);
    if (quote === undefined && (char === "\"" || char === "'" || char === "`")) quote = char;
    else if (quote !== undefined && char === "\\") { code += "  "; at += 1; continue; } else if (quote !== undefined && char === quote) quote = undefined;
    code += quote === undefined && char !== "\"" && char !== "'" && char !== "`" ? char : " ";
  }
  return code;
}

/** Where each operator can apply on one line, outside strings and comments: [column, text, replacement, operator]. */
function sites(line: string): [number, string, string, MutationOperator][] {
  const code = codeOf(line);
  const found: [number, string, string, MutationOperator][] = [];
  for (const match of code.matchAll(/===|!==|<=|>=|=>|==|!=|<|>/gu)) {
    const replacement = comparisons[match[0]];
    if (replacement !== undefined) found.push([match.index, match[0], replacement, "comparison"]);
  }
  for (const match of code.matchAll(/ ([+-]) /gu)) found.push([match.index + 1, match[1] ?? "", match[1] === "+" ? "-" : "+", "arithmetic"]);
  for (const match of code.matchAll(/(?<![\w$.])\d+/gu)) found.push([match.index, match[0], String(Number(match[0]) + 1), "constant"]);
  return found.sort((a, b) => a[0] - b[0]);
}

const returned = /^(.*\breturn\s+)(.+?)(;?\s*)$/u;
const OPERATORS: readonly MutationOperator[] = ["result", "comparison", "constant", "arithmetic"];

/**
 * The mutants of the function declared on line `start` whose body closes on
 * line `end` (both 1-based): one change each, on the lines after the
 * declaration and never on a `//@` line, taking each operator in turn so a cap
 * keeps a mix of them. A result mutant returns another of the function's
 * returned values in place of one, as a branch with its result swapped; the
 * other operators flip a comparison, move a number by one, or swap `+` and
 * `-`, and often leave behavior the same.
 */
export function mutants(source: string, start: number, end: number, limit: number = MUTANT_LIMIT): Mutant[] {
  const lines = source.split("\n");
  const byOperator: Readonly<Record<MutationOperator, Mutant[]>> = { result: [], comparison: [], constant: [], arithmetic: [] };
  const replace = (index: number, changed: string): string => [...lines.slice(0, index), changed, ...lines.slice(index + 1)].join("\n");
  const body: number[] = [];
  for (let index = start; index < end && index < lines.length; index += 1) {
    if (!(lines[index] ?? "").trim().startsWith("//")) body.push(index);
  }
  const results = [...new Set(body.flatMap((index) => returned.exec(lines[index] ?? "")?.[2] ?? []))];
  for (const index of body) {
    const line = lines[index] ?? "";
    const match = returned.exec(line);
    const other = match === null ? undefined : results.find((value) => value !== match[2]);
    if (match !== null && other !== undefined) {
      byOperator.result.push({ line: index + 1, operator: "result", before: match[2] ?? "", after: other,
        source: replace(index, `${match[1] ?? ""}${other}${match[3] ?? ""}`) });
    }
    for (const [column, before, after, operator] of sites(line)) {
      byOperator[operator].push({ line: index + 1, operator, before, after,
        source: replace(index, `${line.slice(0, column)}${after}${line.slice(column + before.length)}`) });
    }
  }
  const ordered: Mutant[] = [];
  for (let round = 0; ordered.length < limit; round += 1) {
    const next = OPERATORS.flatMap((operator) => byOperator[operator][round] ?? []);
    if (next.length === 0) break;
    ordered.push(...next);
  }
  return ordered.slice(0, limit);
}

/** A contract's `//@` lines, the same whatever the indentation. */
function contractLines(text: string): string {
  return text.split("\n").filter((line) => line.startsWith("//@")).join("\n");
}

/**
 * Mutation results for each proved contract the candidate added or changed,
 * keyed `path:name`. A mutant runs without the file's `.dfy` proof additions,
 * since they belong to the original's generated code, so a rejection may also
 * mean a proof step is missing; a survivor proved without any, and is real.
 */
export async function mutateContracts(snapshot: WorkspaceSnapshot, checks: readonly CheckResult[], read: ContentReader,
  signal: AbortSignal, limit: number = MUTANT_LIMIT): Promise<ReadonlyMap<string, MutationResult>> {
  const results = new Map<string, MutationResult>();
  for (const change of snapshot.changes) {
    if (change.status === "deleted" || !change.path.endsWith(".ts")) continue;
    const proved = checks.some((check) => check.verifier === "lemmascript" && check.command === `lemmascript ${change.path}` &&
      check.outcome === "passed");
    const source = read(snapshot.tree, change.path);
    if (!proved || source === undefined || annotations(source).length === 0) continue;
    const before = new Map(contracts(change.path, read(snapshot.base, change.path) ?? "")
      .map((item) => [item.name, contractLines(item.text)]));
    for (const item of contracts(change.path, source)) {
      if (before.get(item.name) === contractLines(item.text)) continue;
      let rejected = 0;
      let inconclusive = 0;
      const survived: MutationResult["survived"][number][] = [];
      for (const mutant of mutants(source, item.endLine, bodyEnd(source, item.endLine), limit)) {
        if (signal.aborted) break;
        const proof = await proveSource(basename(change.path), mutant.source, undefined, signal);
        if (proof.outcome === "failed") rejected += 1;
        else if (proof.outcome === "passed") survived.push({ line: mutant.line, operator: mutant.operator, before: mutant.before, after: mutant.after });
        else inconclusive += 1;
      }
      results.set(`${item.path}:${item.name}`, { rejected, survived, inconclusive });
    }
  }
  return results;
}
