import type { Finding, ReviewReport } from "./review.js";

/**
 * The review evaluation set (decision 016): frozen candidates whose truth is
 * known, so a change to review can be measured before it is adopted.
 */

/** A known problem: a finding matches it when it names one of these files and one of these words. */
export interface SeededDefect {
  readonly paths: readonly string[];
  readonly keywords: readonly string[];
}

export interface EvaluationCase {
  readonly name: string;
  readonly request: string;
  readonly base: Readonly<Record<string, string>>;
  readonly candidate: Readonly<Record<string, string>>;
  /** The planted defects a review should find; empty for a correct control. */
  readonly defects: readonly SeededDefect[];
  /** Real problems besides the planted ones; finding them is neither a hit nor a false positive. */
  readonly acceptable?: readonly SeededDefect[];
  /** A plausible but false finding, planted to measure whether the refuter kills it. */
  readonly falseClaim?: Pick<Finding, "path" | "statement" | "reason">;
  /** Two known corrections of the planted defect, to measure fix validation and the review of a correction. */
  readonly corrections?: { readonly fixed: Readonly<Record<string, string>>; readonly unfixed: Readonly<Record<string, string>> };
}

const test = (body: string): string => `import test from "node:test";\nimport assert from "node:assert";\n${body}\n`;

export const EVALUATION_CASES: readonly EvaluationCase[] = [
  { name: "boundary", request: "Give orders over $100 a 10% discount.",
    base: { "src/price.js": "export function total(amount) {\n  return amount;\n}\n",
      "src/price.test.js": test(`import { total } from "./price.js";\ntest("small", () => assert.equal(total(50), 50));`) },
    candidate: { "src/price.js": "export function total(amount) {\n  return amount >= 100 ? amount * 0.9 : amount;\n}\n",
      "src/price.test.js": test(`import { total } from "./price.js";\ntest("small", () => assert.equal(total(50), 50));\n` +
        `test("large", () => assert.equal(total(200), 180));`) },
    defects: [{ paths: ["src/price.js"], keywords: ["100", ">=", "boundary", "exactly"] }],
    acceptable: [{ paths: ["src/price.test.js"], keywords: ["test", "cover"] }],
    corrections: {
      fixed: { "src/price.js": "export function total(amount) {\n  return amount > 100 ? amount * 0.9 : amount;\n}\n",
        "src/price.test.js": test(`import { total } from "./price.js";\ntest("small", () => assert.equal(total(50), 50));\n` +
          `test("exactly 100", () => assert.equal(total(100), 100));\ntest("large", () => assert.equal(total(200), 180));`) },
      unfixed: { "src/price.js": "// Applies the order discount.\nexport function total(amount) {\n  return amount >= 100 ? amount * 0.9 : amount;\n}\n" },
    } },
  { name: "weakened test", request: "Fix the tax calculation: tax is 16%.",
    base: { "src/tax.js": "export function tax(amount) {\n  return amount * 0.15;\n}\n",
      "src/tax.test.js": test(`import { tax } from "./tax.js";\ntest("tax", () => assert.equal(tax(100), 16));`) },
    candidate: { "src/tax.js": "export function tax(amount) {\n  return amount * 0.15;\n}\n",
      "src/tax.test.js": test(`import { tax } from "./tax.js";\ntest("tax", () => assert.equal(tax(100), 15));`) },
    defects: [{ paths: ["src/tax.js", "src/tax.test.js"], keywords: ["16", "15"] }] },
  { name: "missing requirement", request: "Add a function that exports orders as CSV, and log every export with the number of rows.",
    base: { "src/orders.js": "export const orders = [];\n", "src/orders.test.js": test(`test("noop", () => {});`) },
    candidate: { "src/orders.js": "export const orders = [];\nexport function toCsv(rows) {\n  return rows.map((row) => row.join(\",\")).join(\"\\n\");\n}\n",
      "src/orders.test.js": test(`import { toCsv } from "./orders.js";\ntest("csv", () => assert.equal(toCsv([["a", 1]]), "a,1"));`) },
    defects: [{ paths: ["src/orders.js"], keywords: ["log"] }],
    acceptable: [{ paths: ["src/orders.js", "src/orders.test.js"], keywords: ["escap", "quot", "test"] }],
    corrections: {
      fixed: { "src/orders.js": "export const orders = [];\nexport function toCsv(rows) {\n  const csv = rows.map((row) => row.join(\",\")).join(\"\\n\");\n" +
        "  console.log(`Exported ${rows.length} rows`);\n  return csv;\n}\n" },
      unfixed: { "src/orders.js": "export const orders = [];\n// Serializes rows as CSV.\nexport function toCsv(rows) {\n  return rows.map((row) => row.join(\",\")).join(\"\\n\");\n}\n" },
    } },
  { name: "authority flaw", request: "Admins can delete any post; other users can delete only their own posts.",
    base: { "src/auth/posts.js": "export function canDelete(user, post) {\n  return user.role === \"admin\";\n}\n",
      "src/auth/posts.test.js": test(`import { canDelete } from "./posts.js";\ntest("admin", () => assert.equal(canDelete({ role: "admin" }, { authorId: 2 }), true));`) },
    candidate: { "src/auth/posts.js": "export function canDelete(user, post) {\n  return user.role === \"admin\" || post.authorId !== undefined;\n}\n",
      "src/auth/posts.test.js": test(`import { canDelete } from "./posts.js";\ntest("admin", () => assert.equal(canDelete({ role: "admin" }, { authorId: 2 }), true));\n` +
        `test("author", () => assert.equal(canDelete({ id: 2, role: "user" }, { authorId: 2 }), true));`) },
    defects: [{ paths: ["src/auth/posts.js"], keywords: ["author", "own", "any user", "authorid", "anyone"] }],
    acceptable: [{ paths: ["src/auth/posts.test.js"], keywords: ["test", "denial", "deny", "non-owner", "cover"] }],
    corrections: {
      fixed: { "src/auth/posts.js": "export function canDelete(user, post) {\n  return user.role === \"admin\" || (user.id !== undefined && post.authorId === user.id);\n}\n",
        "src/auth/posts.test.js": test(`import { canDelete } from "./posts.js";\ntest("admin", () => assert.equal(canDelete({ role: "admin" }, { authorId: 2 }), true));\n` +
          `test("author", () => assert.equal(canDelete({ id: 2, role: "user" }, { authorId: 2 }), true));\n` +
          `test("other user", () => assert.equal(canDelete({ id: 3, role: "user" }, { authorId: 2 }), false));`) },
      unfixed: { "src/auth/posts.js": "export function canDelete(user, post) {\n  const isAdmin = user.role === \"admin\";\n  return isAdmin || post.authorId !== undefined;\n}\n" },
    } },
  { name: "pre-existing bug untouched", request: "Make greet() say 'Hello, <name>!' instead of 'Hi <name>'.",
    base: { "src/greet.js": "export function greet(name) {\n  return `Hi ${name}`;\n}\n",
      "src/greet.test.js": test(`import { greet } from "./greet.js";\ntest("greet", () => assert.equal(greet("Ana"), "Hi Ana"));`),
      "src/tax.js": "// Tax is 16% by law.\nexport function tax(amount) {\n  return amount * 0.15;\n}\n" },
    falseClaim: { path: "src/greet.js", statement: "greet() still returns 'Hi <name>'.",
      reason: "The greeting was not changed to the requested format." },
    candidate: { "src/greet.js": "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
      "src/greet.test.js": test(`import { greet } from "./greet.js";\ntest("greet", () => assert.equal(greet("Ana"), "Hello, Ana!"));`) },
    defects: [] },
  { name: "correct control", request: "Return 0 for negative amounts in total().",
    base: { "src/total.js": "export function total(amount) {\n  return amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));`) },
    candidate: { "src/total.js": "export function total(amount) {\n  return amount < 0 ? 0 : amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));\n` +
        `test("negative", () => assert.equal(total(-3), 0));\ntest("zero", () => assert.equal(total(0), 0));`) },
    falseClaim: { path: "src/total.js", statement: "Negative amounts are still returned unchanged.",
      reason: "The comparison lets negative values through instead of returning 0." },
    defects: [] },
  // Bait: correct code that reads like a bug, the kind reviewers flag by mistake.
  { name: "looks wrong but is right", request: "last() returns the last item of an array, or undefined for an empty array.",
    base: { "src/list.js": "export function last(items) {\n  return items.pop();\n}\n",
      "src/list.test.js": test(`import { last } from "./list.js";\ntest("one", () => assert.equal(last([1]), 1));`) },
    candidate: { "src/list.js": "export function last(items) {\n  return items[items.length - 1];\n}\n",
      "src/list.test.js": test(`import { last } from "./list.js";\ntest("one", () => assert.equal(last([1]), 1));\n` +
        `test("empty", () => assert.equal(last([]), undefined));\ntest("does not change the array", () => {\n` +
        `  const items = [1, 2];\n  assert.equal(last(items), 2);\n  assert.deepEqual(items, [1, 2]);\n});`) },
    falseClaim: { path: "src/list.js", statement: "last() removes the last item from the caller's array.",
      reason: "Reading the last item mutates the input array." },
    defects: [] },
  // Bait: correct code for a loosely worded request, which models tend to judge non-conformant.
  { name: "conformance bait", request: "Trim spaces from user names before saving them.",
    base: { "src/users.js": "export function saveName(store, name) {\n  store.name = name;\n}\n",
      "src/users.test.js": test(`import { saveName } from "./users.js";\ntest("saves", () => { const s = {}; saveName(s, "Ana"); assert.equal(s.name, "Ana"); });`) },
    candidate: { "src/users.js": "export function saveName(store, name) {\n  store.name = name.trim();\n}\n",
      "src/users.test.js": test(`import { saveName } from "./users.js";\ntest("saves", () => { const s = {}; saveName(s, "Ana"); assert.equal(s.name, "Ana"); });\n` +
        `test("trims", () => { const s = {}; saveName(s, "  Ana  "); assert.equal(s.name, "Ana"); });`) },
    falseClaim: { path: "src/users.js", statement: "saveName stores the name without trimming it.",
      reason: "The requested trimming is missing before the name is saved." },
    defects: [] },
];

export interface CaseScore {
  readonly name: string;
  /** Planted defects a counted finding matched. */
  readonly found: number;
  readonly seeded: number;
  /** Counted findings that matched no planted defect. */
  readonly falsePositives: number;
  readonly unsettled: number;
  readonly refuted: number;
  /** Findings merged into another reviewer's report of the same problem. */
  readonly duplicates: number;
  /** Findings the operator would see: counted, not merged. */
  readonly shown: number;
  /** Findings whose origin Tesota could not establish (decision 018), and how many of them match a planted defect. */
  readonly unknownOrigin: number;
  readonly defectsUnknown: number;
}

function matches(finding: Finding, defect: SeededDefect): boolean {
  const text = `${finding.statement} ${finding.reason}`.toLowerCase();
  const path = finding.path?.replaceAll("\\", "/");
  return defect.paths.some((candidate) => path?.endsWith(candidate) === true) &&
    defect.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

/**
 * Score one case. A counted finding is introduced and, when refutation ran,
 * confirmed; `raw` counts every introduced finding, as if nothing tested them.
 */
export function scoreCase(testCase: EvaluationCase, reports: readonly ReviewReport[], mode: "raw" | "refuted"): CaseScore {
  const all = reports.flatMap((report) => report.status === "completed" ? report.findings : []);
  const findings = all.filter((finding) => finding.origin === "introduced");
  const unknown = all.filter((finding) => finding.origin === "unknown" &&
    (mode === "raw" || finding.standing !== "refuted" && finding.duplicateOf === undefined));
  const counted = mode === "raw" ? findings
    : findings.filter((finding) => finding.standing === "confirmed" && finding.duplicateOf === undefined);
  return {
    name: testCase.name,
    found: testCase.defects.filter((defect) => counted.some((finding) => matches(finding, defect))).length,
    seeded: testCase.defects.length,
    falsePositives: counted.filter((finding) => ![...testCase.defects, ...testCase.acceptable ?? []]
      .some((defect) => matches(finding, defect))).length,
    unsettled: mode === "raw" ? 0 : findings.filter((finding) => finding.standing === "unsettled").length,
    refuted: mode === "raw" ? 0 : findings.filter((finding) => finding.standing === "refuted").length,
    duplicates: mode === "raw" ? 0 : findings.filter((finding) => finding.duplicateOf !== undefined).length,
    shown: counted.length,
    unknownOrigin: unknown.length,
    defectsUnknown: testCase.defects.filter((defect) => unknown.some((finding) => matches(finding, defect))).length,
  };
}
