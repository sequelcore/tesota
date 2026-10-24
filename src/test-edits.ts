import { posix } from "node:path";
import type { ts as TypeScript } from "ts-morph";
import type { RemovedLine } from "./diff-lines.js";
import { typescript } from "./typescript-source.js";
import { assertionChange, type CheckChange } from "./verification/test-weakening-rule.js";

/**
 * What a test edit did to one test that may weaken it, read from the
 * JavaScript or TypeScript file on each side by the conventions Bun, Vitest
 * and Jest share: an `expect` assertion removed, loosened, its `not` dropped
 * or changed otherwise (`assertionChange`), its subject and the matcher
 * after it given for a loosened one or a dropped `not`, and the whole
 * assertion on each side for one changed otherwise; the test or group skipped or
 * focused (`marker` as written, such as `it.skip`, `xit` or
 * `{ skip: true }`); the module the file tests mocked (`module` as the mock
 * names it); or the test deleted. A heuristic, never a verdict.
 */
export type TestEdit =
  | { readonly kind: "removed_assertion"; readonly assertion: string }
  | { readonly kind: "loosened_assertion" | "dropped_not"; readonly subject: string; readonly before: string; readonly after: string }
  | { readonly kind: "changed_assertion"; readonly before: string; readonly after: string }
  | { readonly kind: "skipped" | "focused"; readonly marker: string }
  | { readonly kind: "mocked_subject"; readonly module: string }
  | { readonly kind: "deleted_test" };

/** A test's edits that may weaken it: `test` names it with its groups, `a › b`; none for code outside every test. */
export interface WeakenedTest {
  readonly test?: string;
  readonly edits: readonly TestEdit[];
}

interface Block { readonly key: string; readonly name: string; readonly parent: string | undefined; readonly skip?: string; readonly focus?: string }

interface Assertion {
  readonly test: string | undefined;
  readonly subject: string;
  readonly modifiers: readonly string[];
  readonly matcher: string;
  readonly args: readonly string[];
  readonly start: number;
  readonly end: number;
}

interface Side {
  readonly blocks: Map<string, Block>;
  readonly assertions: Assertion[];
  readonly mocks: { readonly test: string | undefined; readonly module: string }[];
  readonly imports: string[];
}

const testRoots = /^(?:it|test|describe|suite|context|[xf](?:it|test|describe|context))$/u;
const testModifiers = new Set(["skip", "only", "todo", "each", "skipIf", "runIf", "if", "concurrent", "sequential", "failing", "fails",
  "serial", "shuffle"]);
const skips = new Set(["skip", "todo", "skipIf", "runIf", "if"]);
/** Modifiers that return the function that takes the test, never a test themselves. */
const factories = new Set(["each", "skipIf", "runIf", "if"]);

/**
 * How strict a matcher is, only to say an assertion was loosened
 * (`ranked_weaker`), never that it was made stricter: 5 an exact value, 4 a
 * strict deep equality, 3 a deep equality or snapshot, 2 a partial check such
 * as a substring, a bound or a property, 1 only that something is there or
 * truthy; 0 for one Tesota does not rank.
 */
const strengths: Readonly<Record<string, number>> = Object.fromEntries([
  [5, "toBe toBeNull toBeUndefined toBeNaN toBeTrue toBeFalse"],
  [4, "toStrictEqual"],
  [3, "toEqual toMatchSnapshot toMatchInlineSnapshot toMatchFileSnapshot toHaveBeenCalledTimes toHaveBeenNthCalledWith " +
    "toHaveBeenLastCalledWith toHaveBeenCalledExactlyOnceWith toHaveReturnedTimes toHaveNthReturnedWith toHaveLastReturnedWith " +
    "toThrowErrorMatchingSnapshot toThrowErrorMatchingInlineSnapshot"],
  [2, "toMatchObject toContain toContainEqual toMatch toHaveProperty toBeCloseTo toBeGreaterThan toBeGreaterThanOrEqual toBeLessThan " +
    "toBeLessThanOrEqual toHaveLength toHaveBeenCalledWith toHaveReturnedWith toThrow toThrowError toBeInstanceOf toBeTypeOf toSatisfy " +
    "toBeOneOf toHaveBeenCalledOnce"],
  [1, "toBeDefined toBeTruthy toBeFalsy toHaveBeenCalled toHaveReturned"],
].flatMap(([level, names]) => String(names).split(" ").map((name) => [name, Number(level)])));

const spaced = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** A callee's name and the modifiers after it: `it.skip` and `it.each(table)` alike. */
function chain(ts: typeof TypeScript, node: TypeScript.Expression): { root: string; props: string[] } | undefined {
  if (ts.isIdentifier(node)) return { root: node.text, props: [] };
  const inner = ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) ? chain(ts, node.expression)
    : ts.isTaggedTemplateExpression(node) ? chain(ts, node.tag) : undefined;
  return inner === undefined || !ts.isPropertyAccessExpression(node) ? inner : { ...inner, props: [...inner.props, node.name.text] };
}

/** An options argument's `skip`, `todo` or `only` set to `true`, as Vitest and Node read it. */
function optionMarker(ts: typeof TypeScript, file: TypeScript.SourceFile, node: TypeScript.CallExpression, names: readonly string[]):
  string | undefined {
  for (const argument of node.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    const set = argument.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
      names.includes(property.name.text) && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
    if (set !== undefined) return `{ ${spaced(set.getText(file))} }`;
  }
  return undefined;
}

/** A test or group the call declares, with its name and any skip or focus marker; undefined for any other call. */
function testCall(ts: typeof TypeScript, file: TypeScript.SourceFile, node: TypeScript.CallExpression):
  { name: string; skip?: string; focus?: string } | undefined {
  const called = chain(ts, node.expression);
  const [first] = node.arguments;
  if (called === undefined || first === undefined || !testRoots.test(called.root) || !called.props.every((prop) => testModifiers.has(prop)) ||
    ts.isPropertyAccessExpression(node.expression) && factories.has(node.expression.name.text)) return undefined;
  const name = ts.isStringLiteralLike(first) ? first.text : spaced(first.getText(file));
  const marked = (set: ReadonlySet<string>, prefix: string): string | undefined => called.root.startsWith(prefix) && called.root.length > 2
    ? called.root : called.props.filter((prop) => set.has(prop)).map((prop) => `${called.root}.${prop}`)[0];
  const skip = marked(skips, "x") ?? optionMarker(ts, file, node, ["skip", "todo"]);
  const focus = marked(new Set(["only"]), "f") ?? optionMarker(ts, file, node, ["only"]);
  return { name, ...skip === undefined ? {} : { skip }, ...focus === undefined ? {} : { focus } };
}

/** An `expect(subject)` call's matcher and the modifiers before it, such as `not` and `resolves`; undefined for any other call. */
function assertionCall(ts: typeof TypeScript, file: TypeScript.SourceFile, node: TypeScript.CallExpression):
  Omit<Assertion, "test" | "start" | "end"> | undefined {
  const props: string[] = [];
  let at: TypeScript.Expression = node.expression;
  while (ts.isPropertyAccessExpression(at)) {
    props.unshift(at.name.text);
    at = at.expression;
  }
  const matcher = props.pop();
  if (matcher === undefined || !ts.isCallExpression(at)) return undefined;
  const callee = at.expression;
  const expects = ts.isIdentifier(callee) ? callee.text === "expect"
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "expect";
  return expects ? { subject: spaced(at.getText(file)), modifiers: props, matcher, args: node.arguments.map((arg) => spaced(arg.getText(file))) }
    : undefined;
}

/** A module mock's specifier: `vi.mock`, `jest.mock` and their `doMock`, and Bun's `mock.module`. */
function mockCall(ts: typeof TypeScript, node: TypeScript.CallExpression): string | undefined {
  const [first] = node.arguments;
  if (first === undefined || !ts.isStringLiteralLike(first) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const { expression: owner, name } = node.expression;
  if (!ts.isIdentifier(owner)) return undefined;
  const mocks = (owner.text === "vi" || owner.text === "jest") && ["mock", "doMock", "unstable_mockModule"].includes(name.text) ||
    owner.text === "mock" && name.text === "module";
  return mocks ? first.text : undefined;
}

/** A module as a test file names it, from the project's root when relative, without its script extension or `/index`. */
function resolved(path: string, specifier: string): string {
  const joined = specifier.startsWith(".") ? posix.join(posix.dirname(path), specifier) : specifier;
  return joined.replace(/\.[cm]?[jt]sx?$/u, "").replace(/\/index$/u, "");
}

/** The tests, assertions, mocks and imports of one side of a test file. */
function read(path: string, source: string): Side {
  const ts = typescript();
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const side: Side = { blocks: new Map(), assertions: [], mocks: [], imports: [] };
  const visit = (node: TypeScript.Node, test: string | undefined): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) side.imports.push(resolved(path, node.moduleSpecifier.text));
    if (!ts.isCallExpression(node)) return ts.forEachChild(node, (child) => visit(child, test));
    // `await import("./price")` after a mock, as Bun's `mock.module` is used, and `require`.
    const [specifier] = node.arguments;
    if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") &&
      specifier !== undefined && ts.isStringLiteralLike(specifier)) side.imports.push(resolved(path, specifier.text));
    const declared = testCall(ts, file, node);
    if (declared !== undefined) {
      const name = test === undefined ? declared.name : `${side.blocks.get(test)?.name ?? ""} › ${declared.name}`;
      let key = name;
      for (let n = 2; side.blocks.has(key); n += 1) key = `${name}#${n}`;
      side.blocks.set(key, { ...declared, key, name, parent: test });
      for (const argument of node.arguments) visit(argument, key);
      return;
    }
    const assertion = assertionCall(ts, file, node);
    if (assertion !== undefined) {
      const statement = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
      const whole = ts.isExpressionStatement(statement) ? statement : node;
      side.assertions.push({ ...assertion, test, start: whole.getStart(file), end: whole.getEnd() });
    }
    const module = mockCall(ts, node);
    if (module !== undefined) side.mocks.push({ test, module });
    ts.forEachChild(node, (child) => visit(child, test));
  };
  visit(file, undefined);
  return side;
}

const numeric = (text: string | undefined): number | undefined =>
  text !== undefined && /^-?\d+(?:\.\d+)?$/u.test(text) ? Number(text) : undefined;
const literal = (text: string | undefined): string | undefined => /^(["'`])((?:\\.|(?!\1)[^\\$])*)\1$/u.exec(text ?? "")?.[2];
type Implication = Extract<CheckChange, "same" | "stricter" | "weaker" | "other">;
const order = (before: number | undefined, after: number | undefined, stricter: (b: number, a: number) => boolean): Implication =>
  before === undefined || after === undefined || before === after ? "other" : stricter(before, after) ? "stricter" : "weaker";
const prefixed = (shorter: readonly string[], longer: readonly string[]): boolean =>
  shorter.length < longer.length && shorter.every((arg, k) => arg === longer[k]);

/**
 * How a matcher's arguments changed, where the matcher stayed the same:
 * `stricter` when the new check implies the old one, such as more
 * `toBeCloseTo` digits, a tighter bound, a longer `toMatch` or `toThrow`
 * string, or an added `toThrow` message or `toHaveProperty` value; `weaker`
 * the other way round.
 */
function argumentChange(matcher: string, before: readonly string[], after: readonly string[]): Implication {
  if (before.join("\0") === after.join("\0")) return "same";
  if (matcher === "toBeCloseTo" && before[0] === after[0]) return order(numeric(before[1] ?? "2"), numeric(after[1] ?? "2"), (b, a) => a > b);
  if (matcher.startsWith("toBeGreaterThan")) return order(numeric(before[0]), numeric(after[0]), (b, a) => a > b);
  if (matcher.startsWith("toBeLessThan")) return order(numeric(before[0]), numeric(after[0]), (b, a) => a < b);
  const was = literal(before[0]);
  const now = literal(after[0]);
  // A string `toMatch` or `toThrow` checks for a substring; `toContain` on an array checks for a whole item, so it is not here.
  if (/^(?:toMatch|toThrow|toThrowError)$/u.test(matcher) && was !== undefined && now !== undefined && before.length === 1 &&
    after.length === 1) return was === now ? "same" : now.includes(was) ? "stricter" : was.includes(now) ? "weaker" : "other";
  if (/^(?:toThrow|toThrowError|toHaveProperty)$/u.test(matcher)) {
    return prefixed(before, after) ? "stricter" : prefixed(after, before) ? "weaker" : "other";
  }
  return "other";
}

/** Matchers each of which, given the same arguments, implies those before it. */
const exactness = ["toMatchObject", "toEqual", "toStrictEqual", "toBe"];

/** Whether a value written as a literal is truthy, or undefined when it is not written as one. */
function truthy(text: string): boolean | undefined {
  if (/^(?:false|null|undefined|NaN|-?0(?:\.0+)?|0n)$/u.test(text) || literal(text) === "") return false;
  return text === "true" || numeric(text) !== undefined || literal(text) !== undefined || /^[[{]/u.test(text) ? true : undefined;
}

/** Whether an exact check (`toBe`, `toEqual`, `toStrictEqual`) of one literal implies a presence check without arguments. */
function impliesPresence(exact: Assertion, presence: Assertion): boolean {
  const [value] = exact.args;
  if (!exactness.slice(1).includes(exact.matcher) || exact.args.length !== 1 || value === undefined || presence.args.length > 0) return false;
  const truth = truthy(value);
  return presence.matcher === "toBeDefined" ? truth !== undefined && value !== "undefined"
    : presence.matcher === "toBeTruthy" ? truth === true : presence.matcher === "toBeFalsy" && truth === false;
}

/**
 * How an assertion's check changed, read without its `not` (`CheckChange`):
 * stricter or weaker only where one check implies the other, by its
 * arguments (`argumentChange`), along `toMatchObject`, `toEqual`,
 * `toStrictEqual` and `toBe` with the same arguments, or between a presence
 * check and an exact literal it admits; otherwise weaker only by rank
 * (`strengths`).
 */
function checkChange(before: Assertion, after: Assertion): CheckChange {
  if (others(before) !== others(after)) return "other";
  if (before.matcher === after.matcher) return argumentChange(before.matcher, before.args, after.args);
  const [was, now] = [exactness.indexOf(before.matcher), exactness.indexOf(after.matcher)];
  if (was !== -1 && now !== -1 && before.args.join("\0") === after.args.join("\0")) return now > was ? "stricter" : "weaker";
  if (impliesPresence(after, before)) return "stricter";
  if (impliesPresence(before, after)) return "weaker";
  const [rank, next] = [strengths[before.matcher] ?? 0, strengths[after.matcher] ?? 0];
  return next > 0 && rank > next ? "ranked_weaker" : "other";
}

const written = ({ modifiers, matcher, args }: Assertion): string => [...modifiers, matcher].join(".") + `(${args.join(", ")})`;
const whole = (assertion: Assertion): string => `${assertion.subject}.${written(assertion)}`;
const others = (assertion: Assertion): string => assertion.modifiers.filter((modifier) => modifier !== "not").join(".");

/** What became of one assertion of the base, against the change's assertions on the same subject in the same test, if any. */
function changed(before: Assertion, after: Assertion | undefined): TestEdit | "tightened" | undefined {
  if (after === undefined) return { kind: "removed_assertion", assertion: whole(before) };
  if (after.subject !== before.subject) return { kind: "changed_assertion", before: whole(before), after: whole(after) };
  const outcome = assertionChange(before.modifiers.includes("not"), after.modifiers.includes("not"), checkChange(before, after));
  if (outcome === "kept") return undefined;
  if (outcome === "tightened") return outcome;
  if (outcome === "changed") return { kind: "changed_assertion", before: whole(before), after: whole(after) };
  return { kind: outcome === "loosened" ? "loosened_assertion" : "dropped_not", subject: before.subject, before: written(before),
    after: written(after) };
}

/** Whether `module` is one the file tests: an import named as the file is, without `.test` or `.spec`. */
function subjectOf(path: string, imports: readonly string[], module: string): boolean {
  const stem = posix.basename(path).replace(/\.(?:test|spec)(?=\.[^.]+$)/u, "").replace(/\.[^.]+$/u, "");
  return imports.includes(module) && posix.basename(module) === stem;
}

/**
 * How a change to a JavaScript or TypeScript test file, read on both sides,
 * may weaken each of its tests (`TestEdit`), and which of its removed lines
 * only hold assertions it made stricter (`tightened`), which then count for
 * nothing (`removalCounts`). Each assertion of the base is matched first
 * with one written the same in the same test, then with the first left on
 * the same subject there, then with the first left with the same matcher and
 * arguments; the tests are matched by name within their groups.
 */
export function testEdits(path: string, baseContent: string, content: string):
  { readonly tests: WeakenedTest[]; readonly tightened: (line: RemovedLine) => boolean } {
  const before = read(path, baseContent);
  const now = read(path, content);
  const found = new Map<string | undefined, TestEdit[]>();
  const add = (test: string | undefined, edit: TestEdit): void => void found.set(test, [...found.get(test) ?? [], edit]);
  for (const block of before.blocks.values()) {
    if (!now.blocks.has(block.key) && (block.parent === undefined || now.blocks.has(block.parent))) add(block.key, { kind: "deleted_test" });
  }
  for (const block of now.blocks.values()) {
    const was = before.blocks.get(block.key);
    if (block.skip !== undefined && was?.skip === undefined) add(block.key, { kind: "skipped", marker: block.skip });
    if (block.focus !== undefined && was?.focus === undefined) add(block.key, { kind: "focused", marker: block.focus });
  }
  const left = [...now.assertions];
  const take = (match: (assertion: Assertion) => boolean): Assertion | undefined => {
    const at = left.findIndex(match);
    return at === -1 ? undefined : left.splice(at, 1)[0];
  };
  const kept = before.assertions.filter((assertion) => assertion.test !== undefined && !now.blocks.has(assertion.test) ||
    take((other) => other.test === assertion.test && other.subject === assertion.subject && written(other) === written(assertion)) !== undefined);
  const tightened: Assertion[] = [];
  for (const assertion of before.assertions.filter((each) => !kept.includes(each))) {
    const edit = changed(assertion, take((other) => other.test === assertion.test && other.subject === assertion.subject) ??
      take((other) => other.test === assertion.test && written(other) === written(assertion)));
    if (edit === "tightened") tightened.push(assertion);
    else if (edit !== undefined) add(assertion.test, edit);
  }
  const mocked = new Set(before.mocks.map(({ module }) => resolved(path, module)));
  for (const { test, module } of now.mocks) {
    if (!mocked.has(resolved(path, module)) && subjectOf(path, now.imports, resolved(path, module))) add(test, { kind: "mocked_subject", module });
  }
  const tests = [...found].map(([key, edits]) => ({ ...key === undefined ? {} : { test: now.blocks.get(key)?.name ??
    before.blocks.get(key)?.name ?? key }, edits }));
  const lines = baseContent.split("\n");
  const starts = lines.reduce<number[]>((at, line) => [...at, (at.at(-1) ?? 0) + line.length + 1], [0]);
  return { tests, tightened: ({ base }) => {
    const start = starts[base - 1];
    const text = lines[base - 1];
    if (start === undefined || text === undefined || tightened.length === 0) return false;
    // By UTF-16 index, as the parser's positions are.
    return text.split("").every((character, k) => /\s/u.test(character) ||
      tightened.some((assertion) => assertion.start <= start + k && start + k < assertion.end));
  } };
}
