import { basename } from "node:path";
import type { Contract } from "./proof-guarantees.js";
import { proveSource } from "./verification/lemmascript-verifier.js";
import { equivalentMutant, mutantFinding } from "./verification/mutation-rule.js";

/**
 * Proof-based mutation: for each contract the request added or changed and
 * that proved, small fixed changes to its function's body, each proved
 * again. A mutant that still proves is behavior the contract does not rule
 * out, so the contract is too weak to trust, unless Dafny proves that it
 * returns the same result as the code for every input the contract admits
 * (`equivalenceSource`). This is the completeness metric of Lahiri (FMCAD
 * 2024) with the prover in place of tests; no model decides it.
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
  /** Mutants that still proved and are not proved equivalent: behavior the contract does not rule out. */
  readonly survived: readonly Pick<Mutant, "line" | "operator" | "before" | "after">[];
  /** Mutants that still proved and that Dafny proved return the same result as the code (`equivalentMutant`). */
  readonly equivalent: number;
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
 * The mutants of a function whose body spans the source offsets `body`
 * (`Contract.body`): one change each, inside the body and never on a `//@`
 * line, taking each operator in turn so a cap keeps a mix of them. A result
 * mutant returns another of the function's returned values in place of one,
 * as a branch with its result swapped; the other operators flip a comparison,
 * move a number by one, or swap `+` and `-`, and often leave behavior the same.
 */
export function mutants(source: string, [from, to]: readonly [number, number], limit: number = MUTANT_LIMIT): Mutant[] {
  const lines = source.split("\n");
  const byOperator: Readonly<Record<MutationOperator, Mutant[]>> = { result: [], comparison: [], constant: [], arithmetic: [] };
  const replace = (index: number, changed: string): string => [...lines.slice(0, index), changed, ...lines.slice(index + 1)].join("\n");
  // Each line the body reaches, with the columns of the line inside it.
  const body: { index: number; first: number; end: number }[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const start = offset;
    offset += line.length + 1;
    if (offset > from && start < to && !line.trim().startsWith("//")) {
      body.push({ index, first: Math.max(from - start, 0), end: Math.min(to - start, line.length) });
    }
  }
  const returnIn = ({ index, first, end }: (typeof body)[number]): RegExpExecArray | undefined => {
    const match = returned.exec(lines[index] ?? "");
    const column = match?.[1]?.length ?? -1;
    return match !== null && column >= first && column + (match[2]?.length ?? 0) <= end ? match : undefined;
  };
  const results = [...new Set(body.flatMap((span) => returnIn(span)?.[2] ?? []))];
  for (const span of body) {
    const line = lines[span.index] ?? "";
    const match = returnIn(span);
    const other = match === undefined ? undefined : results.find((value) => value !== match[2]);
    if (match !== undefined && other !== undefined) {
      byOperator.result.push({ line: span.index + 1, operator: "result", before: match[2] ?? "", after: other,
        source: replace(span.index, `${match[1] ?? ""}${other}${match[3] ?? ""}`) });
    }
    for (const [column, before, after, operator] of sites(line)) {
      if (column < span.first || column + before.length > span.end) continue;
      byOperator[operator].push({ line: span.index + 1, operator, before, after,
        source: replace(span.index, `${line.slice(0, column)}${after}${line.slice(column + before.length)}`) });
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


/** The offset where 1-based line `line` of `lines` starts; past the end of the text after its last line. */
function lineStart(lines: readonly string[], line: number): number {
  return lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0);
}

/**
 * The file that asks Dafny whether a mutant behaves exactly like the code:
 * `source` with a copy of the contract's function as `mutated` changed it,
 * renamed to a name `source` does not use; both keep every annotation of the
 * contract but its `ensures`, such as the `requires`, `//@ pure` and
 * `//@ type`, and the original gains an `ensures` that its result equals the
 * copy's, where LemmaScript reads it (`Contract.readsAbove`). It
 * proves only when the two return the same result for every input the
 * `requires` admit. Undefined, so the mutant stays a survivor, when a
 * parameter is not a plain name, or the function calls itself: the copy would
 * call the original, so its proof would not be about the mutant alone.
 */
export function equivalenceSource(source: string, contract: Contract, mutated: string): string | undefined {
  const { name, parameters, body: [from, to] } = contract;
  if (parameters === undefined) return undefined;
  const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/gu, "\\$")}\\s*\\(`, "u");
  if (call.test(source.slice(from, to))) return undefined;
  let copy = `${name}Mutant`;
  for (let suffix = 2; source.includes(copy); suffix += 1) copy = `${name}Mutant${suffix}`;
  const lines = source.split("\n");
  const start = lineStart(lines, contract.endLine);
  const indent = /^\s*/u.exec(lines[contract.endLine - 1] ?? "")?.[0] ?? "";
  const ensures = (text: string): boolean => /^\/\/@ ensures(?:\s|$)/u.test(text);
  // The ensures in the body are blanked to spaces, so every offset still holds, and the mutant keeps every line.
  const withoutEnsures = (text: string): string[] => text.split("\n").map((line, index) => {
    const found = contract.annotations.find((item) => item.line === index + 1 && item.line >= contract.endLine && ensures(item.text));
    return found === undefined ? line : line.replace(found.text, " ".repeat(found.text.length));
  });
  const mutatedLines = withoutEnsures(mutated);
  // The mutant changes only the body, after the name, so the copy's name sits where the original's does.
  const changed = mutatedLines.join("\n").slice(start, lineStart(mutatedLines, contract.bodyEnd + 1)).replace(/\n?$/u, "\n");
  const named = `${changed.slice(0, contract.nameAt - start)}${copy}${changed.slice(contract.nameAt - start + name.length)}`;
  const above = contract.annotations.filter(({ line, text }) => line < contract.endLine && !ensures(text))
    .map(({ text }) => `${indent}${text}\n`).join("");
  const original = withoutEnsures(source).join("\n").slice(start);
  const equality = `//@ ensures \\result === ${copy}(${parameters.join(", ")})`;
  return `${source.slice(0, lineStart(lines, contract.line))}${above}${named}\n${above}` + (contract.readsAbove
    ? `${indent}${equality}\n${original}`
    : `${original.slice(0, from - start)}\n${indent}  ${equality}${original.slice(from - start)}`);
}

/**
 * Proves each mutant of the contract's function in `source` as the
 * contract's file alone (`proveSource`). A mutant runs without the file's
 * `.dfy` proof additions, since they belong to the original's generated code,
 * so a rejection may also mean a proof step is missing; a survivor proved
 * without any, and is real. A survivor whose `equivalenceSource` proves the
 * same way, under the same time limit, behaves like the code and is counted
 * as equivalent instead (`equivalentMutant`).
 */
export async function mutateContract(contract: Contract, source: string, signal: AbortSignal,
  limit: number = MUTANT_LIMIT): Promise<MutationResult> {
  let rejected = 0;
  let inconclusive = 0;
  let equivalent = 0;
  const survived: MutationResult["survived"][number][] = [];
  const file = basename(contract.path);
  for (const mutant of mutants(source, contract.body, limit)) {
    if (signal.aborted) break;
    const finding = mutantFinding(await proveSource(file, mutant.source, signal));
    if (finding === "rejected") rejected += 1;
    else if (finding === "inconclusive") inconclusive += 1;
    else {
      const equivalence = equivalenceSource(source, contract, mutant.source);
      if (equivalence !== undefined && equivalentMutant(await proveSource(file, equivalence, signal))) equivalent += 1;
      else survived.push({ line: mutant.line, operator: mutant.operator, before: mutant.before, after: mutant.after });
    }
  }
  return { rejected, survived, inconclusive, equivalent };
}
