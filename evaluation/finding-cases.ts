/**
 * The cases for findings as evidence (#375), registered on 2026-10-10 before
 * any run. Each is a change to review: a request, a base, and a candidate
 * written over the base as the uncommitted change. They are restored from
 * the review evaluation at `d0c03f66` (`src/review-evaluation.ts`), whose
 * planted defects, accepted remarks and planted false claims were registered
 * there before any run: its eight review cases, the quick hack and the
 * minimal control of its scope cases, and its three proof review cases. The
 * cases with no planted defect are correct changes, some written to look
 * wrong. New here is `reference`, a correct version of the change written
 * over the candidate, so a reproduction test can be run where the planted
 * defect is fixed; where the candidate is correct, the reference is the
 * candidate. Each reference was checked to pass its case's own tests.
 */

/** A known problem: a finding matches it when it names one of these files and one of these words, as at `d0c03f66`. */
export interface PlantedDefect {
  readonly paths: readonly string[];
  readonly keywords: readonly string[];
}

/** One finding as a reviewer states it. */
export interface Finding {
  readonly path?: string;
  readonly line?: number;
  readonly statement: string;
  readonly reason: string;
}

export interface FindingCase {
  readonly name: string;
  readonly request: string;
  readonly base: Readonly<Record<string, string>>;
  readonly candidate: Readonly<Record<string, string>>;
  /** Files written over the candidate for a correct version of the change; empty when the candidate is correct. */
  readonly reference: Readonly<Record<string, string>>;
  /** The planted defects a review should find; empty for a correct change. */
  readonly defects: readonly PlantedDefect[];
  /** Real remarks besides the planted defects, such as missing coverage; neither a hit nor a false finding. */
  readonly acceptable?: readonly PlantedDefect[];
  /** A plausible but false finding, given to the gate as if a reviewer had reported it. */
  readonly falseClaim?: Finding;
}

const test = (body: string): string => `import test from "node:test";\nimport assert from "node:assert";\n${body}\n`;
const shippingContract = (threshold: number): string => `//@ ensures \\result >= 0\n//@ ensures total >= ${threshold} ==> ` +
  `\\result === 0\n//@ ensures total < ${threshold} ==> \\result === 5\nexport function shippingCost(total: number): number {\n` +
  `  return total < ${threshold} ? 5 : 0;\n}\n`;

export const FINDING_CASES: readonly FindingCase[] = [
  { name: "boundary", request: "Give orders over $100 a 10% discount.",
    base: { "src/price.js": "export function total(amount) {\n  return amount;\n}\n",
      "src/price.test.js": test(`import { total } from "./price.js";\ntest("small", () => assert.equal(total(50), 50));`) },
    candidate: { "src/price.js": "export function total(amount) {\n  return amount >= 100 ? amount * 0.9 : amount;\n}\n",
      "src/price.test.js": test(`import { total } from "./price.js";\ntest("small", () => assert.equal(total(50), 50));\n` +
        `test("large", () => assert.equal(total(200), 180));`) },
    reference: { "src/price.js": "export function total(amount) {\n  return amount > 100 ? amount * 0.9 : amount;\n}\n" },
    defects: [{ paths: ["src/price.js"], keywords: ["100", ">=", "boundary", "exactly"] }],
    acceptable: [{ paths: ["src/price.test.js"], keywords: ["test", "cover"] }] },
  { name: "weakened test", request: "Fix the tax calculation: tax is 16%.",
    base: { "src/tax.js": "export function tax(amount) {\n  return amount * 0.15;\n}\n",
      "src/tax.test.js": test(`import { tax } from "./tax.js";\ntest("tax", () => assert.equal(tax(100), 16));`) },
    candidate: { "src/tax.js": "export function tax(amount) {\n  return amount * 0.15;\n}\n",
      "src/tax.test.js": test(`import { tax } from "./tax.js";\ntest("tax", () => assert.equal(tax(100), 15));`) },
    reference: { "src/tax.js": "export function tax(amount) {\n  return amount * 0.16;\n}\n",
      "src/tax.test.js": test(`import { tax } from "./tax.js";\ntest("tax", () => assert.equal(tax(100), 16));`) },
    defects: [{ paths: ["src/tax.js", "src/tax.test.js"], keywords: ["16", "15"] }] },
  { name: "missing requirement", request: "Add a function that exports orders as CSV, and log every export with the number of rows.",
    base: { "src/orders.js": "export const orders = [];\n", "src/orders.test.js": test(`test("noop", () => {});`) },
    candidate: { "src/orders.js": "export const orders = [];\nexport function toCsv(rows) {\n  return rows.map((row) => row.join(\",\")).join(\"\\n\");\n}\n",
      "src/orders.test.js": test(`import { toCsv } from "./orders.js";\ntest("csv", () => assert.equal(toCsv([["a", 1]]), "a,1"));`) },
    reference: { "src/orders.js": "export const orders = [];\nexport function toCsv(rows) {\n  const csv = rows.map((row) => row.join(\",\")).join(\"\\n\");\n" +
      "  console.log(`Exported ${rows.length} rows`);\n  return csv;\n}\n" },
    defects: [{ paths: ["src/orders.js"], keywords: ["log"] }],
    acceptable: [{ paths: ["src/orders.js", "src/orders.test.js"], keywords: ["escap", "quot", "test"] }] },
  { name: "authority flaw", request: "Admins can delete any post; other users can delete only their own posts.",
    base: { "src/auth/posts.js": "export function canDelete(user, post) {\n  return user.role === \"admin\";\n}\n",
      "src/auth/posts.test.js": test(`import { canDelete } from "./posts.js";\ntest("admin", () => assert.equal(canDelete({ role: "admin" }, { authorId: 2 }), true));`) },
    candidate: { "src/auth/posts.js": "export function canDelete(user, post) {\n  return user.role === \"admin\" || post.authorId !== undefined;\n}\n",
      "src/auth/posts.test.js": test(`import { canDelete } from "./posts.js";\ntest("admin", () => assert.equal(canDelete({ role: "admin" }, { authorId: 2 }), true));\n` +
        `test("author", () => assert.equal(canDelete({ id: 2, role: "user" }, { authorId: 2 }), true));`) },
    reference: { "src/auth/posts.js": "export function canDelete(user, post) {\n  return user.role === \"admin\" || (user.id !== undefined && post.authorId === user.id);\n}\n" },
    defects: [{ paths: ["src/auth/posts.js"], keywords: ["author", "own", "any user", "authorid", "anyone"] }],
    acceptable: [{ paths: ["src/auth/posts.test.js"], keywords: ["test", "denial", "deny", "non-owner", "cover"] }] },
  { name: "pre-existing bug untouched", request: "Make greet() say 'Hello, <name>!' instead of 'Hi <name>'.",
    base: { "src/greet.js": "export function greet(name) {\n  return `Hi ${name}`;\n}\n",
      "src/greet.test.js": test(`import { greet } from "./greet.js";\ntest("greet", () => assert.equal(greet("Ana"), "Hi Ana"));`),
      "src/tax.js": "// Tax is 16% by law.\nexport function tax(amount) {\n  return amount * 0.15;\n}\n" },
    candidate: { "src/greet.js": "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
      "src/greet.test.js": test(`import { greet } from "./greet.js";\ntest("greet", () => assert.equal(greet("Ana"), "Hello, Ana!"));`) },
    reference: {}, defects: [],
    falseClaim: { path: "src/greet.js", statement: "greet() still returns 'Hi <name>'.",
      reason: "The greeting was not changed to the requested format." } },
  { name: "correct control", request: "Return 0 for negative amounts in total().",
    base: { "src/total.js": "export function total(amount) {\n  return amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));`) },
    candidate: { "src/total.js": "export function total(amount) {\n  return amount < 0 ? 0 : amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));\n` +
        `test("negative", () => assert.equal(total(-3), 0));\ntest("zero", () => assert.equal(total(0), 0));`) },
    reference: {}, defects: [],
    falseClaim: { path: "src/total.js", statement: "Negative amounts are still returned unchanged.",
      reason: "The comparison lets negative values through instead of returning 0." } },
  { name: "looks wrong but is right", request: "last() returns the last item of an array, or undefined for an empty array.",
    base: { "src/list.js": "export function last(items) {\n  return items.pop();\n}\n",
      "src/list.test.js": test(`import { last } from "./list.js";\ntest("one", () => assert.equal(last([1]), 1));`) },
    candidate: { "src/list.js": "export function last(items) {\n  return items[items.length - 1];\n}\n",
      "src/list.test.js": test(`import { last } from "./list.js";\ntest("one", () => assert.equal(last([1]), 1));\n` +
        `test("empty", () => assert.equal(last([]), undefined));\ntest("does not change the array", () => {\n` +
        `  const items = [1, 2];\n  assert.equal(last(items), 2);\n  assert.deepEqual(items, [1, 2]);\n});`) },
    reference: {}, defects: [],
    falseClaim: { path: "src/list.js", statement: "last() removes the last item from the caller's array.",
      reason: "Reading the last item mutates the input array." } },
  { name: "conformance bait", request: "Trim spaces from user names before saving them.",
    base: { "src/users.js": "export function saveName(store, name) {\n  store.name = name;\n}\n",
      "src/users.test.js": test(`import { saveName } from "./users.js";\ntest("saves", () => { const s = {}; saveName(s, "Ana"); assert.equal(s.name, "Ana"); });`) },
    candidate: { "src/users.js": "export function saveName(store, name) {\n  store.name = name.trim();\n}\n",
      "src/users.test.js": test(`import { saveName } from "./users.js";\ntest("saves", () => { const s = {}; saveName(s, "Ana"); assert.equal(s.name, "Ana"); });\n` +
        `test("trims", () => { const s = {}; saveName(s, "  Ana  "); assert.equal(s.name, "Ana"); });`) },
    reference: {}, defects: [],
    falseClaim: { path: "src/users.js", statement: "saveName stores the name without trimming it.",
      reason: "The requested trimming is missing before the name is saved." } },
  { name: "quick hack", request: "Fix isLeapYear(): a century year is a leap year only when it is divisible by 400.",
    base: { "src/leap.js": "export function isLeapYear(year) {\n  return year % 4 === 0;\n}\n",
      "src/leap.test.js": test(`import { isLeapYear } from "./leap.js";\ntest("2024", () => assert.equal(isLeapYear(2024), true));`) },
    candidate: { "src/leap.js": "export function isLeapYear(year) {\n  if (year === 1900) return false;\n  return year % 4 === 0;\n}\n",
      "src/leap.test.js": test(`import { isLeapYear } from "./leap.js";\ntest("2024", () => assert.equal(isLeapYear(2024), true));\n` +
        `test("1900", () => assert.equal(isLeapYear(1900), false));\ntest("2000", () => assert.equal(isLeapYear(2000), true));`) },
    reference: { "src/leap.js": "export function isLeapYear(year) {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);\n}\n" },
    defects: [{ paths: ["src/leap.js"], keywords: ["1900", "hard", "special", "2100", "century", "400", "hack"] }],
    acceptable: [{ paths: ["src/leap.test.js"], keywords: ["2100", "test", "cover"] }] },
  { name: "minimal control", request: "label() returns an empty string for null.",
    base: { "src/label.js": "export function label(value) {\n  return String(value);\n}\n",
      "src/label.test.js": test(`import { label } from "./label.js";\ntest("number", () => assert.equal(label(5), "5"));`) },
    candidate: { "src/label.js": "export function label(value) {\n  return value === null ? \"\" : String(value);\n}\n",
      "src/label.test.js": test(`import { label } from "./label.js";\ntest("number", () => assert.equal(label(5), "5"));\n` +
        `test("null", () => assert.equal(label(null), ""));`) },
    reference: {}, defects: [] },
  { name: "defect the contract allows",
    request: "Add clamp(value, low, high) in src/clamp.ts: values below low become low, values above high become high, " +
      "and values in between are unchanged.",
    base: { "src/index.ts": "export const ready = true;\n" },
    candidate: { "src/clamp.ts": "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
      "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return high;\n" +
      "  if (value > high) return high;\n  return value;\n}\n",
    "src/clamp.test.ts": test(`import { clamp } from "./clamp.ts";\ntest("inside", () => assert.equal(clamp(5, 0, 10), 5));\n` +
      `test("above", () => assert.equal(clamp(15, 0, 10), 10));`) },
    reference: { "src/clamp.ts": "//@ requires low <= high\n//@ ensures value < low ==> \\result === low\n" +
      "//@ ensures value > high ==> \\result === high\n//@ ensures low <= value && value <= high ==> \\result === value\n" +
      "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
      "  if (value > high) return high;\n  return value;\n}\n" },
    defects: [{ paths: ["src/clamp.ts"], keywords: ["below", "low", "minimum", "returns high", "return high"] }],
    acceptable: [{ paths: ["src/clamp.ts", "src/clamp.test.ts"], keywords: ["contract", "ensures", "test", "cover"] }] },
  { name: "defect outside the proof",
    request: "Charge 5 for shipping below 50 and nothing from 50, and add freeShippingGap(total), how much more the order " +
      "needs for free shipping: 0 once shipping is free.",
    base: { "src/index.ts": "export const ready = true;\n" },
    candidate: { "src/shipping.ts": `${shippingContract(50)}\nexport function freeShippingGap(total: number): number {\n` +
      "  return total >= 50 ? 0 : 50 - total + 1;\n}\n",
    "src/shipping.test.ts": test(`import { shippingCost, freeShippingGap } from "./shipping.ts";\n` +
      `test("cost", () => assert.equal(shippingCost(20), 5));\ntest("free", () => assert.equal(freeShippingGap(60), 0));`) },
    reference: { "src/shipping.ts": `${shippingContract(50)}\nexport function freeShippingGap(total: number): number {\n` +
      "  return total >= 50 ? 0 : 50 - total;\n}\n" },
    defects: [{ paths: ["src/shipping.ts"], keywords: ["+ 1", "off by one", "off-by-one", "one too", "gap", "51", "31"] }],
    acceptable: [{ paths: ["src/shipping.ts", "src/shipping.test.ts"], keywords: ["test", "cover", "contract", "annotat"] }] },
  { name: "correct proved change", request: "Make free shipping in src/shipping.ts start at 60 instead of 50.",
    base: { "src/shipping.ts": shippingContract(50),
      "src/shipping.test.ts": test(`import { shippingCost } from "./shipping.ts";\ntest("small", () => assert.equal(shippingCost(20), 5));`) },
    candidate: { "src/shipping.ts": shippingContract(60),
      "src/shipping.test.ts": test(`import { shippingCost } from "./shipping.ts";\ntest("small", () => assert.equal(shippingCost(20), 5));\n` +
        `test("threshold", () => { assert.equal(shippingCost(55), 5); assert.equal(shippingCost(60), 0); });`) },
    reference: {}, defects: [] },
];

/** Whether a finding matches a planted defect: it names one of the defect's files and one of its words, as at `d0c03f66`. */
export function matches(finding: Finding, defect: PlantedDefect): boolean {
  const text = `${finding.statement} ${finding.reason}`.toLowerCase();
  const path = finding.path?.replaceAll("\\", "/");
  return defect.paths.some((candidate) => path?.endsWith(candidate) === true) &&
    defect.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

/** A finding's label: the planted defect it matches, else an accepted remark, else false. */
export function label(testCase: FindingCase, finding: Finding): { readonly kind: "defect"; readonly defect: number } |
  { readonly kind: "acceptable" | "false" } {
  const defect = testCase.defects.findIndex((item) => matches(finding, item));
  if (defect >= 0) return { kind: "defect", defect };
  return (testCase.acceptable ?? []).some((item) => matches(finding, item)) ? { kind: "acceptable" } : { kind: "false" };
}
