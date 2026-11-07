import { type Contract, contracts } from "../src/proof-guarantees.js";
import { mutateContract } from "../src/proof-mutation.js";

/** The sources and helpers the proof-mutation tests share. */
export const body: string = "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
  "  if (value > high) return high;\n  return value;\n}\n";
export const strong: string = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
  "//@ ensures low <= value && value <= high ==> \\result === value\n//@ ensures value > high ==> \\result === high\n" + body;
export const weak: string = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" + body;
/** Its contract allows `return 1` in the base case, a survivor that is not equivalent. */
export const recursive: string = "//@ requires n >= 0\n//@ ensures \\result >= 0\nexport function sum(n: number): number {\n" +
  "  if (n === 0) return 0;\n  return n + sum(n - 1);\n}\n";

/**
 * The weak-contract cases registered on 2026-10-03, before any run, as
 * `AGENT_STRENGTHEN_CASES` in `src/agent-evaluation.ts` at `d0c03f66`: each
 * base proves while its function does what the request rules out, because
 * its contract is too weak to forbid it.
 */
export const registeredWeak: Readonly<Record<string, string>> = {
  "clamp.ts": "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
    "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return high;\n" +
    "  if (value > high) return high;\n  return value;\n}\n",
  "discount.ts": "//@ requires price >= 0\n//@ ensures \\result <= price\nexport function discounted(price: number): number {\n" +
    "  return price >= 100 ? price - 10 : price;\n}\n",
  "quantity.ts": "//@ requires items.length > 0\n//@ ensures \\result >= items[0]\n" +
    "export function maxQuantity(items: number[]): number {\n  return items[0];\n}\n",
};

export const moneyBody: string = "export function mayMoveMoney(hasKey: boolean, alreadyCharged: boolean): boolean {\n" +
  "  return hasKey && !alreadyCharged;\n}\n";
export const moneyStrong: string = "//@ ensures \\result === (hasKey && !alreadyCharged)\n" + moneyBody;
export const moneyWeak: string = "//@ ensures \\result === true ==> hasKey\n" + moneyBody;

/** Its `requires` rules out the only input where `return 1` would differ, and a comment separates it from the function. */
export const commentedRequires: string = "//@ pure\n//@ requires n > 0\n// reviewed\n//@ ensures \\result >= 0\nexport function f(n: number): number {\n" +
  "  if (n < 0) return 0;\n  return n;\n}\n";
/** The same contract inside a block-bodied arrow function, the only place LemmaScript reads it. */
export const arrowRequires: string = "export const h = (n: number): number => {\n  //@ requires n > 0\n  //@ ensures \\result >= 0\n" +
  "  if (n < 0) return 0;\n  return n;\n};\n";
/** The same contract above an arrow function that returns an expression. */
export const expressionRequires: string = "//@ requires n > 0\n//@ ensures \\result >= 0\nexport const g = (n: number): number => n < 0 ? 0 : n;\n";

/** The one contract in `source`, read as file `path`. */
export async function only(source: string, path = "src/rule.ts"): Promise<Contract> {
  const [contract] = (await contracts(path, source));
  if (contract === undefined) throw new Error(`no contract in ${path}`);
  return contract;
}

/** Mutation of the one contract in `source`, proved as file `path`. */
export async function mutateOnly(path: string, source: string): ReturnType<typeof mutateContract> {
  return mutateContract((await only(source, path)), source, AbortSignal.timeout(500_000));
}

/** The offsets inside the outermost braces of a source with one function. */
export const inside = (source: string): [number, number] => [source.indexOf("{") + 1, source.lastIndexOf("}")];
