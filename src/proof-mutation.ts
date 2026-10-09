import { basename } from "node:path";
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

/** The parameter names of a declaration's parameter list; undefined when one is not a plain name, such as a destructured one. */
function parameterNames(list: string): string[] | undefined {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const [at, char] of [...`${list},`].entries()) {
    if ("([{<".includes(char)) depth += 1;
    else if (")]}".includes(char) || char === ">" && list[at - 1] !== "=") depth -= 1;
    if (char !== "," || depth > 0) { current += char; continue; }
    if (current.trim() === "") { current = ""; continue; }
    const name = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*(?::|$)/u.exec(current)?.[1];
    if (name === undefined) return undefined;
    names.push(name);
    current = "";
  }
  return names;
}

/**
 * The file that asks Dafny whether a mutant behaves exactly like the code:
 * `source` with a copy of the function declared on line `start`, whose body
 * closes on line `end` (both 1-based), as `mutated` changed it, renamed to a
 * name `source` does not use and keeping only the contract's `requires`; and
 * the original's contract replaced by its `requires` and an `ensures` that its
 * result equals the copy's. It proves only when the two return the same
 * result for every input the `requires` admit. Undefined, so the mutant stays
 * a survivor, when the declaration does not fit on its line, a parameter is
 * not a plain name, or the function calls itself: the copy would call the
 * original, so its proof would not be about the mutant alone.
 */
export function equivalenceSource(source: string, start: number, end: number, mutated: string): string | undefined {
  const lines = source.split("\n");
  const declaration = lines[start - 1] ?? "";
  const signature = /function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/u.exec(declaration);
  const name = signature?.[1];
  const parameters = parameterNames(signature?.[2] ?? "");
  if (name === undefined || parameters === undefined) return undefined;
  const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/gu, "\\$")}\\s*\\(`, "u");
  if (lines.slice(start, end).some((line) => call.test(line))) return undefined;
  let first = start - 1;
  while (first > 0 && (lines[first - 1] ?? "").trim().startsWith("//@")) first -= 1;
  const requires = lines.slice(first, start - 1).filter((line) => line.trim().startsWith("//@ requires"));
  let copy = `${name}Mutant`;
  for (let suffix = 2; source.includes(copy); suffix += 1) copy = `${name}Mutant${suffix}`;
  const changed = mutated.split("\n").slice(start - 1, end);
  const indent = /^\s*/u.exec(declaration)?.[0] ?? "";
  return [...lines.slice(0, first), ...requires, (changed[0] ?? "").replace(/function\s+[A-Za-z_$][\w$]*/u, (text) => `${text.slice(0, -name.length)}${copy}`), ...changed.slice(1), "", ...requires,
    `${indent}//@ ensures \\result === ${copy}(${parameters.join(", ")})`, ...lines.slice(start - 1)].join("\n");
}

/**
 * Proves each mutant of the function declared on line `start` of `source`,
 * whose body closes on line `end`, as file `path` alone (`proveSource`). A
 * mutant runs without the file's `.dfy` proof additions, since they belong to
 * the original's generated code, so a rejection may also mean a proof step is
 * missing; a survivor proved without any, and is real. A survivor whose
 * `equivalenceSource` proves the same way, under the same time limit, behaves
 * like the code and is counted as equivalent instead (`equivalentMutant`).
 */
export async function mutateContract(path: string, source: string, start: number, end: number, signal: AbortSignal,
  limit: number = MUTANT_LIMIT): Promise<MutationResult> {
  let rejected = 0;
  let inconclusive = 0;
  let equivalent = 0;
  const survived: MutationResult["survived"][number][] = [];
  for (const mutant of mutants(source, start, end, limit)) {
    if (signal.aborted) break;
    const finding = mutantFinding(await proveSource(basename(path), mutant.source, signal));
    if (finding === "rejected") rejected += 1;
    else if (finding === "inconclusive") inconclusive += 1;
    else {
      const equivalence = equivalenceSource(source, start, end, mutant.source);
      if (equivalence !== undefined && equivalentMutant(await proveSource(basename(path), equivalence, signal))) equivalent += 1;
      else survived.push({ line: mutant.line, operator: mutant.operator, before: mutant.before, after: mutant.after });
    }
  }
  return { rejected, survived, inconclusive, equivalent };
}
