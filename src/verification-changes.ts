import type { ChangedFile, DiffLine } from "./diff-lines.js";
import { removalCounts, testWeakens } from "./verification/test-weakening-rule.js";
import { type AnnotationKind, weakens } from "./verification/weakening-rule.js";

/**
 * A change, against the request's base, to the evidence its result rests on:
 * a removed or changed `requires` or `ensures`, a `requires` added to a
 * function the base had, and an added `assume`, in LemmaScript source or a
 * Dafny proof, with the line as written, which in a proof includes an
 * `{:axiom}` and a lemma left without a body; and a deleted test file, or
 * an edit to one that may weaken its tests (`testWeakens`).
 * The operator decides whether it is legitimate.
 */
export type Weakening =
  | { readonly path: string; readonly kind: "removed_contract" | "added_requires" | "added_assume"; readonly annotation: string }
  | { readonly path: string; readonly kind: "deleted_test" | "edited_test" };

/**
 * A changed file, with its content as changed and at the base where the
 * rules need them (`needsContent`): to tell whether an added `requires`
 * annotates a new function, and which lemmas a proof leaves without a body.
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

/** Whether a path holds tests, or a snapshot they compare against, by the conventions of the common test runners. */
export function isTestPath(path: string): boolean {
  return testPaths.some((pattern) => pattern.test(path));
}

function kindOf(path: string, line: string): AnnotationKind | undefined {
  if (path.endsWith(".dfy")) return /^\s*assume\b|\{:axiom\b/u.test(line.replace(/\/\/.*$/u, "")) ? "assume" : undefined;
  const word = /^\s*\/\/@\s*(\w+)/u.exec(line)?.[1];
  if (word === undefined) return undefined;
  return word === "requires" || word === "ensures" || word === "assume" ? word : "other";
}

/** Whether the rules need `file`'s content now and at the base: for a Dafny proof, or a `//@ requires` it adds. */
export function needsContent(file: ChangedFile): boolean {
  return file.path.endsWith(".dfy") ||
    file.status === "modified" && file.added.some(({ text }) => kindOf(file.path, text) === "requires");
}

const declaration = new RegExp(String.raw`^(?:(?:ghost|static|opaque|twostate|least|greatest|abstract)\s+)*` +
  String.raw`(?:lemma|method|function|predicate|datatype|codatatype|class|trait|module|import|const|type|newtype|iterator|constructor)\b`, "u");
const lemmaHeader = /^(?:(?:ghost|static|opaque|twostate|least|greatest)\s+)*lemma\s+([\w'?$]+)/u;

/**
 * The lemmas a Dafny program declares without a body, which Dafny takes as
 * axioms. Read as Dafny is conventionally written: a body opens with a `{`
 * that begins or ends a line, before the next declaration or the `}` that
 * closes the enclosing one.
 */
export function bodilessLemmas(dafny: string): string[] {
  const lines = dafny.replace(/\/\*[\s\S]*?\*\//gu, "").split(/\r?\n/u)
    .map((line) => line.replace(/\/\/.*$/u, "").replace(/\{:[^}]*\}/gu, "").trim());
  return lines.flatMap((line, k) => {
    const name = lemmaHeader.exec(line)?.[1];
    if (name === undefined) return [];
    for (const [j, text] of lines.slice(k).entries()) {
      if (j > 0 && (declaration.test(text) || text === "}")) break;
      if (text.startsWith("{") || /\{[^{}]*\}?$/u.test(text)) return [];
    }
    return [name];
  });
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
  const removed = matching(file.removed, ({ text }) => text, file.added.map(({ text }) => text)).flatMap(({ line, matched }) => {
    const kind = kindOf(file.path, line.text);
    return kind === undefined || !weakens(kind, true, matched, true) ? []
      : [{ path: file.path, kind: "removed_contract", annotation: line.text.trim() } as const];
  });
  const added = matching(file.added, ({ text }) => text, file.removed.map(({ text }) => text)).flatMap(({ line, matched }) => {
    const kind = kindOf(file.path, line.text);
    return kind === undefined || !weakens(kind, false, matched, kind === "requires" && existed(file, line.number)) ? []
      : [{ path: file.path, kind: kind === "requires" ? "added_requires" : "added_assume", annotation: line.text.trim() } as const];
  });
  return [...removed, ...added, ...axiomChanges(file)];
}

/** Lemmas a proof leaves without a body that the base gave one or did not have: as good as an added `assume`. */
function axiomChanges(file: FileChange): Weakening[] {
  if (!file.path.endsWith(".dfy") || file.content === undefined) return [];
  const before = new Set(bodilessLemmas(file.baseContent ?? ""));
  return bodilessLemmas(file.content).flatMap((name) => !weakens("assume", false, before.has(name), false) ? []
    : [{ path: file.path, kind: "added_assume", annotation: `lemma ${name} without a body` } as const]);
}

/**
 * Lines that change how a file's existing tests run, by the conventions of
 * the runners Tesota finds and the test files it reads: a focus or skip
 * marker, a setup or teardown hook, and a module mock. A mock or spy one test
 * sets up and restores is left out, as is a fixture a test asks for by name.
 */
const runChanges = [
  /\.\s*(?:only|skip|skipIf|runIf|todo)\b/u,
  /\b(?:xit|xdescribe|xtest|xcontext|fit|fdescribe|fcontext)\s*\(/u,
  /\b(?:beforeEach|beforeAll|afterEach|afterAll)\s*\(/u,
  /\b(?:vi|jest)\s*\.\s*mock\s*\(|\bmock\s*\.\s*module\s*\(/u,
  /@(?:Disabled\w*|Ignore|(?:Before|After)(?:Each|All|Class)?)\b/u,
  /#\[ignore\b/u,
  /\.\s*Skip(?:Now|f)?\s*\(|\bfunc\s+TestMain\s*\(/u,
  /\bpytest\s*\.\s*(?:mark\s*\.\s*(?:skip|skipif|xfail)\b|skip\s*\(|fixture\b.*\bautouse\s*=\s*True)|@unittest\s*\.\s*skip/u,
  /\bdef\s+(?:(?:setUp|tearDown)(?:Class|Module)?|(?:setup|teardown)_(?:method|function|class|module))\s*\(/u,
];

/** Whether a line of `path` holds only a comment. A `//@` line is a LemmaScript contract, never a comment. */
export function commentOnly(path: string, line: string): boolean {
  return (path.endsWith(".py") ? /^#/u : /^(?:\/\/(?!@)|\/\*|\*)/u).test(line.trim());
}

const namedImports = [
  /^import\s+(type\s+)?(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*(["'][^"']*["'])\s*;?$/u,
  /^from\s+()()([\w.]+)\s+import\s+([^()#]+)$/u,
];

/** A one-line import of named bindings: the module and form it imports in, and the names. */
function namedImport(line: string): { form: string; names: string[] } | undefined {
  for (const [k, pattern] of namedImports.entries()) {
    const match = pattern.exec(line.trim());
    if (match === null) continue;
    const [, type = "", fallback = "", first = "", second = ""] = match;
    const [list, module] = k === 0 ? [first, second] : [second, first];
    return { form: [k, type.trim(), fallback, module].join(" "),
      names: list.split(",").map((name) => name.trim().replace(/\s+/gu, " ")).filter((name) => name !== "") };
  }
  return undefined;
}

/** Whether an added line imports from the same module, in the same form, every name the removed `line` did. */
function widened(line: string, added: readonly DiffLine[]): boolean {
  const before = namedImport(line);
  return before !== undefined && added.some(({ text }) => {
    const after = namedImport(text);
    return after?.form === before.form && before.names.every((name) => after.names.includes(name));
  });
}

function testChange(file: ChangedFile): Weakening[] {
  if (!isTestPath(file.path)) return [];
  const removes = file.removed.some(({ text }) =>
    removalCounts(text.trim() === "", commentOnly(file.path, text), widened(text, file.added)));
  const changesRuns = file.added.some(({ text }) => !commentOnly(file.path, text) &&
    runChanges.some((pattern) => pattern.test(text)));
  return !testWeakens(file.status, removes, changesRuns) ? []
    : [{ path: file.path, kind: file.status === "deleted" ? "deleted_test" : "edited_test" }];
}

/**
 * The changes that may weaken the evidence, file by file. Fixed rules, so the
 * agent cannot argue a change out of the list.
 */
export function weakenedEvidence(changes: readonly FileChange[]): Weakening[] {
  return changes.flatMap((file) => [...annotationChanges(file), ...testChange(file)]);
}
