import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ClaimCheck, type Comparison, claimCheck } from "./pi-claimcheck.js";
import { type MutationResult, mutateContract } from "./proof-mutation.js";

/**
 * How strong the contracts a request added or changed are, once they proved:
 * proof-based mutation shows what behavior each contract fails to rule out,
 * and ClaimCheck has a model compare each with the operator's request.
 */

/** A LemmaScript contract: its annotations and the function they govern. */
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

/** A contract's `//@` lines, the same whatever the indentation. */
function contractLines(contract: Contract): string[] {
  return contract.text.split("\n").filter((line) => line.startsWith("//@"));
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

/** Which model ClaimCheck asked, or why it judged nothing. */
export type ClaimCheckRun = { readonly status: "judged"; readonly model: string } | Extract<ClaimCheck, { status: "not_judged" }>;

/**
 * Mutation and ClaimCheck for each contract a proved file's content added or
 * changed against its base; `claimcheck` is absent when there is no such
 * contract. ClaimCheck runs on the session's model while the mutants prove.
 */
export async function contractStrength(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, requests: readonly string[],
  files: readonly { readonly path: string; readonly source: string; readonly baseSource: string | undefined }[],
  signal: AbortSignal): Promise<{ readonly contracts: readonly ContractStrength[]; readonly claimcheck?: ClaimCheckRun }> {
  const items = files.flatMap(({ path, source, baseSource }) =>
    changedContracts(path, source, baseSource).map((contract) => ({ contract, source })));
  if (items.length === 0) return { contracts: [] };
  const mutate = async (): Promise<MutationResult[]> => {
    const results: MutationResult[] = [];
    for (const { contract, source } of items) {
      results.push(await mutateContract(contract.path, source, contract.endLine, bodyEnd(source, contract.endLine), signal));
    }
    return results;
  };
  const [mutations, judged] = await Promise.all([mutate(), claimCheck(ctx, requests, items.map(({ contract }) => contract), signal)]);
  return {
    contracts: items.map(({ contract }, index) => ({ path: contract.path, name: contract.name, lines: contractLines(contract),
      mutation: mutations[index] ?? { rejected: 0, survived: [], inconclusive: 0 },
      ...judged.status === "judged" && judged.judgments[index] !== undefined ? { judgment: judged.judgments[index] } : {} })),
    claimcheck: judged.status === "judged" ? { status: "judged", model: judged.model } : judged,
  };
}
