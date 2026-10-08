import type { ChangedFile } from "./diff-lines.js";
import { type AnnotationKind, weakens } from "./verification/weakening-rule.js";

/**
 * A change, against the request's base, to the evidence its result rests on:
 * a removed or changed `requires` or `ensures` and an added `assume`, with the
 * `//@` line as written, and a deleted or edited test file. The operator
 * decides whether it is legitimate.
 */
export type Weakening =
  | { readonly path: string; readonly kind: "removed_contract" | "added_assume"; readonly annotation: string }
  | { readonly path: string; readonly kind: "deleted_test" | "edited_test" };

const testPaths = [
  /(^|\/)(__tests__|tests?|specs?)\//u,
  /\.(test|spec)\.[cm]?[jt]sx?$/u,
  /(^|\/)test_[^/]+\.py$/u,
  /_test\.(go|py)$/u,
  /\.snap$/u,
];

function kindOf(line: string): AnnotationKind | undefined {
  const word = /^\s*\/\/@\s*(\w+)/u.exec(line)?.[1];
  if (word === undefined) return undefined;
  return word === "requires" || word === "ensures" || word === "assume" ? word : "other";
}

/** Each of `lines`, with whether a line of the same text, spacing aside, on the other side of the diff is left to match it. */
function matching(lines: readonly string[], others: readonly string[]): { line: string; matched: boolean }[] {
  const key = (line: string): string => line.trim().replace(/\s+/gu, " ");
  const left = new Map<string, number>();
  for (const line of others) left.set(key(line), (left.get(key(line)) ?? 0) + 1);
  return lines.map((line) => {
    const count = left.get(key(line)) ?? 0;
    if (count > 0) left.set(key(line), count - 1);
    return { line, matched: count > 0 };
  });
}

function annotationChanges(file: ChangedFile): Weakening[] {
  const found = (lines: readonly string[], others: readonly string[], removed: boolean): Weakening[] =>
    matching(lines, others).flatMap(({ line, matched }) => {
      const kind = kindOf(line);
      return kind === undefined || !weakens(kind, removed, matched) ? []
        : [{ path: file.path, kind: removed ? "removed_contract" : "added_assume", annotation: line.trim() }];
    });
  return [...found(file.removed, file.added, true), ...found(file.added, file.removed, false)];
}

function testChange(file: ChangedFile): Weakening[] {
  if (file.status === "added" || !testPaths.some((pattern) => pattern.test(file.path))) return [];
  return [{ path: file.path, kind: file.status === "deleted" ? "deleted_test" : "edited_test" }];
}

/**
 * The changes that may weaken the evidence, file by file. Fixed rules, so the
 * agent cannot argue a change out of the list.
 */
export function weakenedEvidence(changes: readonly ChangedFile[]): Weakening[] {
  return changes.flatMap((file) => [...annotationChanges(file), ...testChange(file)]);
}
