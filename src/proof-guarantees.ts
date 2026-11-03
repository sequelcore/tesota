import type { ExtensionContext } from "./contract.js";
import type { ts as TypeScript } from "ts-morph";
import { noOperations, type OperationSink } from "./operations.js";
import { type ClaimCheck, type Comparison, claimCheck, type JudgmentContext, type Restatement } from "./pi-claimcheck.js";
import { type MutationResult, mutateContract } from "./proof-mutation.js";
import { typescript } from "./typescript-source.js";
import { reviewStatus } from "./verification/verdict-rule.js";
import { type ProofInfo, sourceInfo } from "./verification/lemmascript-verifier.js";

/**
 * How strong the contracts a request added or changed are, once they proved:
 * proof-based mutation shows what behavior each contract fails to rule out,
 * and ClaimCheck has a model compare each with the operator's request.
 */

/** A LemmaScript contract: its annotations and the function they govern. */
export interface Contract {
  readonly path: string;
  readonly name: string;
  /** The annotations above the declaration, its first line, then the annotations in its body. */
  readonly text: string;
  /** The contract's first line, its declaration line, and the line where its function ends (all 1-based). */
  readonly line: number;
  readonly endLine: number;
  readonly bodyEnd: number;
  /** Each `//@` line of the contract, trimmed, with its line. */
  readonly annotations: readonly { readonly line: number; readonly text: string }[];
  /** Whether LemmaScript reads the function's annotations above its declaration, or only inside its body, as for an arrow function with a block body. */
  readonly readsAbove: boolean;
  /** Where the function's name starts, and its body: inside its braces, or the expression an arrow function returns (source offsets). */
  readonly nameAt: number;
  readonly body: readonly [number, number];
  /** Its parameters' names; undefined when one is not a plain name, such as a destructured one. */
  readonly parameters: readonly string[] | undefined;
}

/** The functions a top-level statement declares as LemmaScript extracts them: a named function, or a variable set to an arrow function. */
function declared(ts: typeof TypeScript, statement: TypeScript.Statement):
  { name: TypeScript.Identifier; fn: TypeScript.FunctionDeclaration | TypeScript.ArrowFunction }[] {
  if (ts.isFunctionDeclaration(statement)) return statement.name === undefined ? [] : [{ name: statement.name, fn: statement }];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && ts.isArrowFunction(declaration.initializer)
      ? [{ name: declaration.name, fn: declaration.initializer }] : []);
}

interface Annotated {
  readonly contract: Contract;
  readonly skipped: boolean;
  readonly extracted: boolean;
}

/**
 * Locate dependency-reported contracts in the source. LemmaScript's metadata
 * owns both clause attachment and function selection. TypeScript supplies
 * declaration, annotation and body positions for mutation and line coverage.
 */
async function annotated(path: string, source: string, inspected?: ProofInfo, signal?: AbortSignal): Promise<Annotated[]> {
  if (!source.includes("//@")) return [];
  const info = inspected ?? await sourceInfo(path, source, signal);
  if (info.status === "unavailable") return [];
  const selected = new Map(info.functions.map((fn) => [fn.name, fn]));
  const ts = typescript();
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lines = source.split(/\r?\n/u);
  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1;
  const comments = (position: number): TypeScript.CommentRange[] => ts.getLeadingCommentRanges(source, position) ?? [];
  const leading = (position: number): { line: number; text: string }[] =>
    comments(position).flatMap(({ kind, pos, end }) => {
      const text = source.slice(pos, end).trim();
      return kind === ts.SyntaxKind.SingleLineCommentTrivia && text.startsWith("//@")
        ? [{ line: lineOf(pos), text }] : [];
    });
  return file.statements.flatMap((statement) => declared(ts, statement).flatMap(({ name, fn }) => {
    const block = fn.body !== undefined && ts.isBlock(fn.body) ? fn.body : undefined;
    const readsAbove = ts.isFunctionDeclaration(fn) || block === undefined;
    const first = block?.statements[0];
    const actual = selected.get(name.text);
    const attached = (text: string): boolean => {
      const normalized = text.replace(/^(\/\/@ \w+) +/u, "$1 ");
      return actual === undefined ? /^\/\/@ (?:requires|ensures|contract|decreases) /u.test(normalized)
        : actual.clauses.includes(normalized) || /^\/\/@ (?:verify|extern|pure|impure|autohavoc|type)(?:\s|$)/u.test(normalized);
    };
    const above = leading(statement.pos).filter(({ text }) => attached(text));
    const inside = first === undefined ? [] : leading(first.pos).filter(({ text }) => attached(text));
    const annotations = [...above, ...inside];
    const start = annotations[0];
    if (start === undefined) return [];
    const endLine = lineOf(statement.getStart(file));
    const body: [number, number] = block !== undefined ? [block.getStart(file) + 1, block.getEnd() - 1]
      : fn.body !== undefined ? [fn.body.getStart(file), fn.body.getEnd()] : [statement.getEnd(), statement.getEnd()];
    const skipped = [...leading(statement.pos), ...leading(fn.pos)].some(({ text }) => text === "//@ skip");
    return [{ skipped, extracted: actual !== undefined,
      contract: { path, name: name.text, line: Math.min(start.line, endLine), endLine, bodyEnd: lineOf(statement.getEnd()),
        text: [...above.map(({ text }) => text), (lines[endLine - 1] ?? "").trim(), ...inside.map(({ text }) => text)].join("\n"),
        annotations, readsAbove, nameAt: name.getStart(file), body,
        parameters: fn.parameters.every(({ name: parameter }) => ts.isIdentifier(parameter))
          ? fn.parameters.map(({ name: parameter }) => parameter.getText(file)) : undefined } }];
  }));
}

/** The contracts LemmaScript proves (`annotated`): a function it skips or leaves unselected has none, since nothing proves it. */
export async function contracts(path: string, source: string, info?: ProofInfo, signal?: AbortSignal): Promise<Contract[]> {
  return (await annotated(path, source, info, signal)).flatMap(({ contract, extracted: proved }) => proved ? [contract] : []);
}

/**
 * The contracts LemmaScript leaves out of the proof because the file selects
 * other functions with `//@ verify` (`annotated`): annotated, never proved,
 * and with no line of their own that says so. A skipped function is not
 * among them; its `//@ skip` says so.
 */
export async function unselectedContracts(path: string, source: string, signal?: AbortSignal): Promise<Contract[]> {
  return (await annotated(path, source, undefined, signal)).flatMap(({ contract, skipped, extracted: proved }) => !proved && !skipped ? [contract] : []);
}

/** A contract's `//@` lines, the same whatever the indentation. */
function contractLines(contract: Contract): string[] {
  return contract.annotations.map(({ text }) => text);
}

/** The contracts of `source` that its base, `baseSource`, lacks or annotates differently; all of them when the base lacks the file. */
export async function changedContracts(path: string, source: string, baseSource: string | undefined, info?: ProofInfo, signal?: AbortSignal): Promise<Contract[]> {
  const before = new Map((await contracts(path, baseSource ?? "", undefined, signal)).map((item) => [item.name, contractLines(item).join("\n")]));
  return (await contracts(path, source, info, signal)).filter((item) => before.get(item.name) !== contractLines(item).join("\n"));
}

/** One contract the request added or changed, in a file that proved, with what mutation and ClaimCheck found. */
export interface ContractStrength {
  readonly path: string;
  readonly name: string;
  /** The contract's `//@` lines as written. */
  readonly lines: readonly string[];
  readonly mutation: MutationResult;
 }

/** A model's reading of one checked contract, separate from mechanical strength. */
export interface ContractReview {
  readonly folder: string;
  readonly path: string;
  readonly name: string;
  readonly text: string;
  readonly restatement?: Restatement;
  readonly assessment?: Pick<Comparison, "verdict" | "explanation">;
}

export type ClaimCheckRun = Omit<ClaimCheck, "judgments" | "restatements">;

export interface ContractComparison {
  readonly scope: "eligible_changed_contracts";
  readonly status: "completed" | "partial" | "not_run" | "disabled";
  readonly reason?: string;
  readonly contracts: readonly ContractReview[];
  readonly runs: readonly ClaimCheckRun[];
}

/** Omit units with no eligible contracts; preserve every attempted unit and its explicit failure reason. */
export function combineComparisons(comparisons: readonly ContractComparison[]): ContractComparison {
  const eligible = comparisons.filter((comparison) => comparison.reason !== "no eligible changed contract");
  const reasons = eligible.flatMap(({ reason }) => reason === undefined ? [] : [reason]);
  return { scope: "eligible_changed_contracts", status: reviewStatus(eligible.length,
    eligible.filter(({ status }) => status === "completed").length, eligible.filter(({ status }) => status === "partial").length,
    eligible.filter(({ status }) => status === "disabled").length),
  ...eligible.length === 0 ? { reason: "no eligible changed contract" } : reasons.length === 0 ? {} : { reason: reasons.join("; ") },
  contracts: eligible.flatMap(({ contracts }) => contracts), runs: eligible.flatMap(({ runs }) => runs) };
}

/**
 * Mutation and ClaimCheck for each contract a proved file's content added or
 * changed against its base; `claimcheck` is absent when there is no such
 * contract. ClaimCheck runs while the mutants prove, restating with
 * `restateWith` when set (`claimCheck`).
 */
export async function contractStrength(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, requests: readonly string[],
  files: readonly { readonly path: string; readonly source: string; readonly baseSource: string | undefined; readonly proofInfo?: ProofInfo }[],
  signal: AbortSignal, restateWith?: string, ops: OperationSink = noOperations, judging?: JudgmentContext): Promise<{ readonly contracts: readonly ContractStrength[]; readonly contractComparison: ContractComparison }> {
  const items = (await Promise.all(files.map(async ({ path, source, baseSource, proofInfo }) =>
    (await changedContracts(path, source, baseSource, proofInfo, signal)).map((contract) => ({ contract, source }))))).flat();
  if (items.length === 0) return { contracts: [], contractComparison: { scope: "eligible_changed_contracts", status: "not_run", reason: "no eligible changed contract", contracts: [], runs: [] } };
  const mutate = async (): Promise<MutationResult[]> => {
    const results: MutationResult[] = [];
    for (const { contract, source } of items) {
      results.push(await ops.run({ method: "mutation", unit: "", target: `${contract.path}#${contract.name}` },
        () => mutateContract(contract, source, signal), () => "done"));
    }
    return results;
  };
  // Both publish as they start, so the operations show them running at once.
  const [mutations, judged] = await Promise.all([mutate(), ops.run({ method: "claimcheck", unit: "",
    target: items.map(({ contract }) => `${contract.path}#${contract.name}`).join(", ") },
  () => claimCheck(ctx, requests, items.map(({ contract }) => contract), signal, restateWith, judging), () => "done")]);
  const { restatements, judgments, ...run } = judged;
  return {
    contracts: items.map(({ contract }, index) => ({ path: contract.path, name: contract.name, lines: contractLines(contract),
      mutation: mutations[index] ?? { rejected: 0, survived: [], inconclusive: 0, equivalent: 0 } })),
    contractComparison: { scope: "eligible_changed_contracts", status: judged.status, ...judged.reason === undefined ? {} : { reason: judged.reason }, runs: [{ ...run, folder: judging?.folder ?? "" }],
      contracts: items.map(({ contract }, index) => ({ folder: judging?.folder ?? "", path: contract.path, name: contract.name, text: contract.text,
        ...restatements?.[index] === undefined ? {} : { restatement: restatements[index] },
        ...judgments?.[index] === undefined ? {} : { assessment: judgments[index] } })) },
  };
}
