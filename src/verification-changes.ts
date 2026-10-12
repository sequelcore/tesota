import type { ts as TypeScript } from "ts-morph";
import type { ChangedFile, DiffLine, RemovedLine } from "./diff-lines.js";
import { commentOnlyLines, isScriptPath, typescript } from "./typescript-source.js";
import { removalCounts, testWeakens } from "./verification/test-weakening-rule.js";
import { type AnnotationKind, weakens } from "./verification/weakening-rule.js";

/**
 * A change, against the request's base, to the evidence its result rests on:
 * a removed or changed `requires` or `ensures`, a `requires` added to a
 * function the base had, and an added `assume`, in LemmaScript source or a
 * Dafny proof, with the line as written, which in a proof includes an
 * `{:axiom}` and a lemma left without a body, and in LemmaScript source an
 * `//@ extern`, which trusts a function without proving it (`function` names
 * it); an added `//@ skip` on something the base had, which leaves it out of
 * the proof (`function` names the unit it leaves out, or the one holding the
 * statement it leaves out, which `statement` marks); and a deleted test file,
 * or an edit to one that may weaken its tests (`testWeakens`). The operator
 * decides whether it is legitimate.
 */
export type Weakening =
  | { readonly path: string; readonly kind: "removed_contract" | "added_requires" | "added_assume" | "added_skip";
    readonly annotation: string; readonly function?: string; readonly statement?: true }
  | { readonly path: string; readonly kind: "deleted_test" | "edited_test" };

/**
 * A changed file, with its content as changed and at the base where the
 * rules need them (`needsContent`): to tell whether an added `requires`
 * annotates a new function, and which lemmas a proof leaves without a body.
 * A `.dfy` that LemmaScript generated also has the program it generated last
 * (`generated`, its `.dfy.gen`), so only the lines added by hand count as the
 * change's: the rest come from the source's annotations, which count there,
 * or from LemmaScript's own models of JavaScript, such as `split`.
 */
export interface FileChange extends ChangedFile {
  readonly content?: string | undefined;
  readonly baseContent?: string | undefined;
  readonly generated?: string | undefined;
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
  // `//@ extern` takes a function's contract as given, as an assumption does: LemmaScript emits it as an `{:axiom}`.
  if (word === "extern") return "assume";
  return word === "requires" || word === "ensures" || word === "assume" || word === "skip" ? word : "other";
}

/**
 * Whether the rules need `file`'s content now and at the base: for a Dafny
 * proof, for JavaScript or TypeScript, whose comment-only lines are read from
 * the parsed file (`commentLines`), or for a `//@ requires` it adds.
 */
export function needsContent(file: ChangedFile): boolean {
  return file.path.endsWith(".dfy") || isScriptPath(file.path) ||
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

/**
 * The name of a unit LemmaScript extracts on its own: a top-level function,
 * class or variable statement, whose variables are named together, or a
 * class's method. Undefined for anything else, or a unit without a name.
 */
function unitName(ts: typeof TypeScript, node: TypeScript.Node): string | undefined {
  if (ts.isVariableStatement(node)) {
    const names = node.declarationList.declarations.flatMap(({ name }) => ts.isIdentifier(name) ? [name.text] : []);
    return names.length === 0 ? undefined : names.join(", ");
  }
  if (!ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node) && !ts.isMethodDeclaration(node)) return undefined;
  return node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : undefined;
}

/** Whether `node` is a unit LemmaScript extracts on its own (`unitName`): a top-level statement or a class member. */
function isUnit(ts: typeof TypeScript, node: TypeScript.Node): boolean {
  return ts.isSourceFile(node.parent) || ts.isClassDeclaration(node.parent);
}

/** The names of the units `source` declares (`unitName`), each variable apart. */
function unitNames(path: string, source: string): Set<string> {
  const ts = typescript();
  const names = new Set<string>();
  const visit = (node: TypeScript.Node): void => {
    for (const name of unitName(ts, node)?.split(", ") ?? []) names.add(name);
    if (ts.isSourceFile(node) || ts.isClassDeclaration(node)) ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
  return names;
}

/**
 * What the `//@` line at line `number` of `source` annotates, as
 * LemmaScript's extractor reads it: the outermost node whose leading comments
 * hold the line, a unit (`unitName`) or a statement inside one, such as the
 * first statement of a function body that a `requires` there leads, named by
 * that unit. Undefined when no node leads with the line; at the end of the
 * file the line leads nothing with a name.
 */
function annotatedUnit(path: string, source: string, number: number): { name: string | undefined; statement: boolean } | undefined {
  const ts = typescript();
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const leads = (node: TypeScript.Node): boolean => (ts.getLeadingCommentRanges(source, node.pos) ?? []).some(({ pos, end }) =>
    file.getLineAndCharacterOfPosition(pos).line + 1 === number && source.slice(pos, end).startsWith("//@"));
  const find = (node: TypeScript.Node): TypeScript.Node | undefined =>
    node !== file && leads(node) ? node : ts.forEachChild(node, find);
  const led = find(file);
  if (led === undefined) return undefined;
  let unit = led;
  while (!isUnit(ts, unit)) unit = unit.parent;
  return { name: unitName(ts, unit), statement: unit !== led };
}

/**
 * Whether the unit the `//@` line at line `number` annotates
 * (`annotatedUnit`), or holds the statement it annotates, was in the base.
 * When either content or the unit's name cannot be found, it counts as
 * there, so the change is listed.
 */
function existed(file: FileChange, number: number): boolean {
  if (file.status === "added") return false;
  const name = file.content === undefined ? undefined : annotatedUnit(file.path, file.content, number)?.name;
  if (name === undefined || file.baseContent === undefined) return true;
  const before = unitNames(file.path, file.baseContent);
  return name.split(", ").some((each) => before.has(each));
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

/**
 * A line as the weakening rules match it across the diff: a `//@ skip` with
 * what it leaves out on its side (`annotatedUnit`), read from `content` at line
 * `number`; any other line, or a skip whose side was not read, as written.
 */
function skipKey(path: string, text: string, content: string | undefined, number: number): string {
  const left = content === undefined || kindOf(path, text) !== "skip" ? undefined : annotatedUnit(path, content, number);
  return left === undefined ? text : `${text.trim()} ${left.statement ? "statement of " : ""}${left.name ?? ""}`;
}

/** An added annotation line that weakens, with the unit an `//@ extern` trusts or an `//@ skip` leaves out, when found. */
function addedWeakening(file: FileChange, line: DiffLine, kind: AnnotationKind): Weakening {
  const annotation = line.text.trim();
  const unit = file.content === undefined ? undefined : annotatedUnit(file.path, file.content, line.number);
  if (kind === "skip") {
    return { path: file.path, kind: "added_skip", annotation, ...unit?.name === undefined ? {} : { function: unit.name },
      ...unit?.statement === true ? { statement: true } : {} };
  }
  const trusted = /^\/\/@\s*extern\b/u.test(annotation) ? unit?.name : undefined;
  return { path: file.path, kind: kind === "requires" ? "added_requires" : "added_assume", annotation,
    ...trusted === undefined ? {} : { function: trusted } };
}

function annotationChanges(file: FileChange): Weakening[] {
  const removed = matching(file.removed, ({ text }) => text, file.added.map(({ text }) => text)).flatMap(({ line, matched }) => {
    const kind = kindOf(file.path, line.text);
    return kind === undefined || !weakens(kind, true, matched, true) ? []
      : [{ path: file.path, kind: "removed_contract", annotation: line.text.trim() } as const];
  });
  // In a proof LemmaScript generated, a line its last program holds is LemmaScript's, not the change's (`generated`).
  const written = file.generated === undefined ? file.added
    : matching(file.added, ({ text }) => text, file.generated.split(/\r?\n/u)).flatMap(({ line, matched }) => matched ? [] : [line]);
  // Every `//@ skip` reads the same, so one moved only when it leaves out the same thing on both sides (`skipKey`).
  const added = matching(written, ({ text, number }) => skipKey(file.path, text, file.content, number),
    file.removed.map(({ text, base }) => skipKey(file.path, text, file.baseContent, base))).flatMap(({ line, matched }) => {
    const kind = kindOf(file.path, line.text);
    const had = (kind === "requires" || kind === "skip") && existed(file, line.number);
    return kind === undefined || !weakens(kind, false, matched, had) ? [] : [addedWeakening(file, line, kind)];
  });
  return [...removed, ...added, ...axiomChanges(file)];
}

/** Lemmas a proof leaves without a body that the base gave one or did not have: as good as an added `assume`. */
function axiomChanges(file: FileChange): Weakening[] {
  if (!file.path.endsWith(".dfy") || file.content === undefined) return [];
  const before = new Set([...bodilessLemmas(file.baseContent ?? ""), ...bodilessLemmas(file.generated ?? "")]);
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

/** Whether a line of `path`, in a language the parser does not read, holds only a comment. A `//@` line is an annotation, never a comment. */
function commentOnly(path: string, line: string): boolean {
  return (path.endsWith(".py") ? /^#/u : /^(?:\/\/(?!@)|\/\*|\*)/u).test(line.trim());
}

/**
 * Which of a changed file's lines hold only a comment. JavaScript and
 * TypeScript are read from the parsed file on each side (`commentOnlyLines`),
 * since a line alone shows neither a block comment nor a template around it,
 * and a `//@` line is an annotation; a side whose content was not read holds
 * no comment-only line. Other languages are read line by line.
 */
export function commentLines(file: FileChange): { added: (line: DiffLine) => boolean; removed: (line: RemovedLine) => boolean } {
  if (!isScriptPath(file.path)) {
    return { added: ({ text }) => commentOnly(file.path, text), removed: ({ text }) => commentOnly(file.path, text) };
  }
  const now = commentOnlyLines(file.path, file.content ?? "");
  const before = commentOnlyLines(file.path, file.baseContent ?? "");
  return { added: ({ number }) => now.has(number), removed: ({ base }) => before.has(base) };
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

function testChange(file: FileChange): Weakening[] {
  if (!isTestPath(file.path)) return [];
  const comments = commentLines(file);
  const removes = file.removed.some((line) =>
    removalCounts(line.text.trim() === "", comments.removed(line), widened(line.text, file.added)));
  const changesRuns = file.added.some((line) => !comments.added(line) &&
    runChanges.some((pattern) => pattern.test(line.text)));
  return !testWeakens(file.status, removes, changesRuns) ? []
    : [{ path: file.path, kind: file.status === "deleted" ? "deleted_test" : "edited_test" }];
}

/**
 * What a proof of these files, whole, takes on trust or leaves out, by the
 * same rules as a change's (`weakenedEvidence`): each `//@ assume`,
 * `//@ extern` and `//@ skip` of the source, and each `assume`, `{:axiom}`
 * and lemma without a body written into the `.dfy` by hand, not generated
 * (`generated`). Read as if every line were added to a base that had
 * everything, since `prove` has no base to compare with.
 */
export function provedOnTrust(files: readonly { readonly path: string; readonly content: string; readonly generated?: string }[]):
  OnTrust[] {
  return weakenedEvidence(files.map(({ path, content, generated }) => ({ path, status: "modified", removed: [], content, generated,
    added: content.split(/\r?\n/u).map((text, k) => ({ number: k + 1, text })) })))
    .filter((change): change is OnTrust => change.kind === "added_assume" || change.kind === "added_skip");
}

/** A line a proof takes on trust (`added_assume`) or that leaves something out of it (`added_skip`). */
export type OnTrust = Extract<Weakening, { readonly annotation: string }> & { readonly kind: "added_assume" | "added_skip" };

/**
 * The changes that may weaken the evidence, file by file. Fixed rules, so the
 * agent cannot argue a change out of the list.
 */
export function weakenedEvidence(changes: readonly FileChange[]): Weakening[] {
  return changes.flatMap((file) => [...annotationChanges(file), ...testChange(file)]);
}
