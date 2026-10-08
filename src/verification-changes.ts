import type { ChangedFile } from "./diff-lines.js";
import { type AnnotationKind, weakens } from "./verification/weakening-rule.js";

/**
 * A change, against the request's base, to the evidence its result rests on:
 * a removed or changed `requires` or `ensures`, a `requires` added to a
 * function the base had, and an added `assume`, in LemmaScript source or a
 * Dafny proof, with the line as written; and a deleted or edited test file.
 * The operator decides whether it is legitimate.
 */
export type Weakening =
  | { readonly path: string; readonly kind: "removed_contract" | "added_requires" | "added_assume"; readonly annotation: string }
  | { readonly path: string; readonly kind: "deleted_test" | "edited_test" };

/**
 * A changed file, with its content as changed and at the base where an added
 * `requires` needs them (`addsRequires`) to tell whether its function is new.
 */
export interface FileChange extends ChangedFile {
  readonly content?: string | undefined;
  readonly baseContent?: string | undefined;
}

const testPaths = [
  /(^|\/)(__tests__|tests?|specs?)\//u,
  /\.(test|spec)\.[cm]?[jt]sx?$/u,
  /(^|\/)test_[^/]+\.py$/u,
  /_test\.(go|py)$/u,
  /\.snap$/u,
];

function kindOf(path: string, line: string): AnnotationKind | undefined {
  if (path.endsWith(".dfy")) return /^\s*assume\b/u.test(line) ? "assume" : undefined;
  const word = /^\s*\/\/@\s*(\w+)/u.exec(line)?.[1];
  if (word === undefined) return undefined;
  return word === "requires" || word === "ensures" || word === "assume" ? word : "other";
}

/** Whether `file` adds a `//@ requires`, whose function's novelty needs the file's content now and at the base. */
export function addsRequires(file: ChangedFile): boolean {
  return file.status === "modified" && file.added.some(({ text }) => kindOf(file.path, text) === "requires");
}

const functionName = /\bfunction\s*\*?\s*([\w$]+)/u;

/**
 * Whether the function a `requires` at line `number` annotates, the first
 * declared from that line on, was in the base. When either content or the
 * function cannot be found, it counts as there, so the change is listed.
 */
function existed(file: FileChange, number: number): boolean {
  if (file.status === "added") return false;
  const name = file.content?.split(/\r?\n/u).slice(number - 1).map((line) => functionName.exec(line)?.[1])
    .find((found) => found !== undefined);
  if (name === undefined || file.baseContent === undefined) return true;
  return file.baseContent.split(/\r?\n/u).some((line) => functionName.exec(line)?.[1] === name);
}

/** Each of `lines`, with whether a line of the same text, spacing aside, on the other side of the diff is left to match it. */
function matching<T>(lines: readonly T[], text: (line: T) => string, others: readonly string[]): { line: T; matched: boolean }[] {
  const key = (line: string): string => line.trim().replace(/\s+/gu, " ");
  const left = new Map<string, number>();
  for (const line of others) left.set(key(line), (left.get(key(line)) ?? 0) + 1);
  return lines.map((line) => {
    const count = left.get(key(text(line))) ?? 0;
    if (count > 0) left.set(key(text(line)), count - 1);
    return { line, matched: count > 0 };
  });
}

function annotationChanges(file: FileChange): Weakening[] {
  const removed = matching(file.removed, (line) => line, file.added.map(({ text }) => text)).flatMap(({ line, matched }) => {
    const kind = kindOf(file.path, line);
    return kind === undefined || !weakens(kind, true, matched, true) ? []
      : [{ path: file.path, kind: "removed_contract", annotation: line.trim() } as const];
  });
  const added = matching(file.added, ({ text }) => text, file.removed).flatMap(({ line, matched }) => {
    const kind = kindOf(file.path, line.text);
    return kind === undefined || !weakens(kind, false, matched, kind === "requires" && existed(file, line.number)) ? []
      : [{ path: file.path, kind: kind === "requires" ? "added_requires" : "added_assume", annotation: line.text.trim() } as const];
  });
  return [...removed, ...added];
}

function testChange(file: ChangedFile): Weakening[] {
  if (file.status === "added" || !testPaths.some((pattern) => pattern.test(file.path))) return [];
  return [{ path: file.path, kind: file.status === "deleted" ? "deleted_test" : "edited_test" }];
}

/**
 * The changes that may weaken the evidence, file by file. Fixed rules, so the
 * agent cannot argue a change out of the list.
 */
export function weakenedEvidence(changes: readonly FileChange[]): Weakening[] {
  return changes.flatMap((file) => [...annotationChanges(file), ...testChange(file)]);
}
