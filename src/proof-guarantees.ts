import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ts as TypeScript } from "ts-morph";
import { type ClaimCheck, type Comparison, claimCheck } from "./pi-claimcheck.js";
import { type MutationResult, mutateContract } from "./proof-mutation.js";
import { typescript } from "./typescript-source.js";

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

/**
 * The annotations LemmaScript's specification places before a function
 * body's first statement (§2.1); the statement annotations allowed there too,
 * such as `assert` and `assume`, belong to the proof.
 */
const functionAnnotation = /^\/\/@ (?:verify|requires|ensures|contract|decreases|type)(?:\s|$)/u;

/**
 * Each top-level function's contract, read where LemmaScript reads it: the
 * `//@` comments leading the declaration, and the function annotations
 * leading its body's first statement. An arrow function's leading comments
 * are its statement's when it returns an expression, and none when it has a
 * block body. Any comment or blank line between an annotation and what it
 * leads keeps it attached, and code detaches it.
 */
export function contracts(path: string, source: string): Contract[] {
  const ts = typescript();
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lines = source.split(/\r?\n/u);
  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1;
  const leading = (position: number, keep: (text: string) => boolean): { line: number; text: string }[] =>
    (ts.getLeadingCommentRanges(source, position) ?? []).flatMap(({ kind, pos, end }) => {
      const text = source.slice(pos, end).trim();
      return kind === ts.SyntaxKind.SingleLineCommentTrivia && text.startsWith("//@") && keep(text) ? [{ line: lineOf(pos), text }] : [];
    });
  return file.statements.flatMap((statement) => declared(ts, statement).flatMap(({ name, fn }) => {
    const block = fn.body !== undefined && ts.isBlock(fn.body) ? fn.body : undefined;
    const readsAbove = ts.isFunctionDeclaration(fn) || block === undefined;
    const first = block?.statements[0];
    const above = leading(readsAbove ? statement.pos : fn.pos, () => true);
    const inside = first === undefined ? [] : leading(first.pos, (text) => functionAnnotation.test(text));
    const annotations = [...above, ...inside];
    const start = annotations[0];
    if (start === undefined) return [];
    const endLine = lineOf(statement.getStart(file));
    const body: [number, number] = block !== undefined ? [block.getStart(file) + 1, block.getEnd() - 1]
      : fn.body !== undefined ? [fn.body.getStart(file), fn.body.getEnd()] : [statement.getEnd(), statement.getEnd()];
    return [{ path, name: name.text, line: Math.min(start.line, endLine), endLine, bodyEnd: lineOf(statement.getEnd()),
      text: [...above.map(({ text }) => text), (lines[endLine - 1] ?? "").trim(), ...inside.map(({ text }) => text)].join("\n"),
      annotations, readsAbove, nameAt: name.getStart(file), body,
      parameters: fn.parameters.every(({ name: parameter }) => ts.isIdentifier(parameter))
        ? fn.parameters.map(({ name: parameter }) => parameter.getText(file)) : undefined }];
  }));
}

/** A contract's `//@` lines, the same whatever the indentation. */
function contractLines(contract: Contract): string[] {
  return contract.annotations.map(({ text }) => text);
}

/** The contracts of `source` that its base, `baseSource`, lacks or annotates differently; all of them when the base lacks the file. */
export function changedContracts(path: string, source: string, baseSource: string | undefined): Contract[] {
  const before = new Map(contracts(path, baseSource ?? "").map((item) => [item.name, contractLines(item).join("\n")]));
  return contracts(path, source).filter((item) => before.get(item.name) !== contractLines(item).join("\n"));
}

/** One contract the request added or changed, in a file that proved, with what mutation and ClaimCheck found. */
export interface ContractStrength {
  readonly path: string;
  readonly name: string;
  /** The contract's `//@` lines as written. */
  readonly lines: readonly string[];
  readonly mutation: MutationResult;
  /** ClaimCheck's verdict on it, when ClaimCheck judged the contracts: a model's judgment, never a proof. */
  readonly judgment?: Pick<Comparison, "verdict" | "explanation">;
}

/** Which models ClaimCheck asked, or why it judged nothing. */
export type ClaimCheckRun = Omit<Extract<ClaimCheck, { status: "judged" }>, "judgments"> | Extract<ClaimCheck, { status: "not_judged" }>;

/**
 * Mutation and ClaimCheck for each contract a proved file's content added or
 * changed against its base; `claimcheck` is absent when there is no such
 * contract. ClaimCheck runs while the mutants prove, restating with
 * `restateWith` when set (`claimCheck`).
 */
export async function contractStrength(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, requests: readonly string[],
  files: readonly { readonly path: string; readonly source: string; readonly baseSource: string | undefined }[],
  signal: AbortSignal, restateWith?: string): Promise<{ readonly contracts: readonly ContractStrength[]; readonly claimcheck?: ClaimCheckRun }> {
  const items = files.flatMap(({ path, source, baseSource }) =>
    changedContracts(path, source, baseSource).map((contract) => ({ contract, source })));
  if (items.length === 0) return { contracts: [] };
  const mutate = async (): Promise<MutationResult[]> => {
    const results: MutationResult[] = [];
    for (const { contract, source } of items) {
      results.push(await mutateContract(contract, source, signal));
    }
    return results;
  };
  const [mutations, judged] = await Promise.all([mutate(), claimCheck(ctx, requests, items.map(({ contract }) => contract), signal,
    restateWith)]);
  return {
    contracts: items.map(({ contract }, index) => ({ path: contract.path, name: contract.name, lines: contractLines(contract),
      mutation: mutations[index] ?? { rejected: 0, survived: [], inconclusive: 0, equivalent: 0 },
      ...judged.status === "judged" && judged.judgments[index] !== undefined ? { judgment: judged.judgments[index] } : {} })),
    claimcheck: judged.status === "judged"
      ? { status: "judged", restatedBy: judged.restatedBy, comparedBy: judged.comparedBy } : judged,
  };
}
