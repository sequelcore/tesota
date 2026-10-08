import { bodyEnd, contracts } from "./proof-guarantees.js";
import type { FileChange, Weakening } from "./verification-changes.js";
import { proofCovered } from "./verification/proof-cover-rule.js";

/** The changed lines of a file that proved that no contract's proof covers, as inclusive ranges in the file as changed. */
export interface UncoveredLines {
  readonly path: string;
  readonly lines: readonly (readonly [number, number])[];
}

/** The inclusive ranges of consecutive numbers in `numbers`, which are sorted and distinct. */
function ranges(numbers: readonly number[]): [number, number][] {
  const found: [number, number][] = [];
  for (const number of numbers) {
    const last = found.at(-1);
    if (last !== undefined && last[1] + 1 === number) last[1] = number;
    else found.push([number, number]);
  }
  return found;
}

/** Each contract's function with its lines, from its first annotation to the brace that closes it. */
function spans(path: string, source: string): { name: string; start: number; end: number }[] {
  return contracts(path, source).map(({ name, line, endLine }) => ({ name, start: line, end: bodyEnd(source, endLine) }));
}

function holds(source: string, start: number, end: number, annotation: string): boolean {
  return source.split(/\r?\n/u).slice(start - 1, end).some((line) => line.trim() === annotation);
}

/**
 * Whether the change narrowed each contract, read from the weakening list: an
 * annotation added within the contract's function, or one removed from the
 * base's function of the same name. An assumption added to the file's proof
 * may serve any of them, so it narrows them all.
 */
function narrowedContracts(path: string, source: string, baseSource: string | undefined,
  weakened: readonly Weakening[]): boolean[] {
  const current = spans(path, source);
  const proof = path.replace(/\.ts$/u, ".dfy");
  if (weakened.some((change) => change.path === proof && change.kind === "added_assume")) return current.map(() => true);
  const base = new Map(spans(path, baseSource ?? "").map((span) => [span.name, span]));
  return current.map(({ name, start, end }) => weakened.some((change) => {
    if (change.path !== path || !("annotation" in change)) return false;
    if (change.kind !== "removed_contract") return holds(source, start, end, change.annotation);
    const before = base.get(name);
    return before !== undefined && baseSource !== undefined && holds(baseSource, before.start, before.end, change.annotation);
  }));
}

/**
 * The changed lines of a TypeScript file whose proof passed that no proof
 * covers (`proofCovered`): those outside every function with a contract, and
 * those in one whose contract the change narrowed. A removed line counts at
 * the line that now follows it; blank lines are left out.
 */
export function uncoveredLines(change: FileChange, source: string, baseSource: string | undefined,
  weakened: readonly Weakening[]): UncoveredLines {
  const count = source.split(/\r?\n/u).length;
  const changed = [...new Set([...change.added, ...change.removed].filter(({ text }) => text.trim() !== "")
    .map(({ number }) => Math.min(number, count)))].sort((a, b) => a - b);
  const current = spans(change.path, source);
  const starts = current.map(({ start }) => start);
  const ends = current.map(({ end }) => end);
  const proved = current.map(() => true);
  const narrowed = narrowedContracts(change.path, source, baseSource, weakened);
  return { path: change.path,
    lines: ranges(changed.filter((line) => !proofCovered(line, starts, ends, proved, narrowed))) };
}
