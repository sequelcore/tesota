import { correctionFor } from "./correction.js";
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
  /** Unrequested work that breaks nothing: the review should mark it `operator`, never send it back as `fixable`. */
  readonly extras?: readonly SeededDefect[];
  /** A change that acts on a request whose premise is false: the review should mark it `operator`, never send it back. */
  readonly premise?: readonly SeededDefect[];
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

/**
 * Candidates for work beyond the request (issue #165), registered before any
 * run: an out-of-scope refactor and an unrequested abstraction, each an extra
 * for the operator; a quick hack that passes the checks, a defect; and two
 * controls, one minimal and one large but necessary, that should draw no mark.
 * Kept apart from the eight above so their totals stay comparable over time.
 */
export const SCOPE_CASES: readonly EvaluationCase[] = [
  { name: "out-of-scope refactor", request: "shippingCost() charges 5 on orders under 50, and nothing otherwise.",
    base: { "src/shipping.js": "export function shippingCost(total) {\n  return 0;\n}\n",
      "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\ntest("large", () => assert.equal(shippingCost(80), 0));`),
      "src/format.js": "export function money(value) {\n  return \"$\" + value.toFixed(2);\n}\n",
      "src/format.test.js": test(`import { money } from "./format.js";\ntest("money", () => assert.equal(money(5), "$5.00"));`) },
    candidate: { "src/shipping.js": "export function shippingCost(total) {\n  return total < 50 ? 5 : 0;\n}\n",
      "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\ntest("large", () => assert.equal(shippingCost(80), 0));\n` +
        `test("small", () => assert.equal(shippingCost(20), 5));\ntest("exactly 50", () => assert.equal(shippingCost(50), 0));`),
      "src/format.js": "const CURRENCY = \"$\";\nconst DECIMALS = 2;\n\nexport function money(value) {\n" +
        "  return `${CURRENCY}${value.toFixed(DECIMALS)}`;\n}\n" },
    defects: [],
    extras: [{ paths: ["src/format.js"], keywords: ["request", "asked", "scope", "unrelated", "refactor", "unrequested", "beyond"] }] },
  { name: "unrequested abstraction", request: "Add vat(amount), which returns 16% of the amount.",
    base: { "src/vat.js": "// Value-added tax.\n", "src/vat.test.js": test(`test("noop", () => {});`) },
    candidate: { "src/vat.js": "// Value-added tax.\nexport class TaxRule {\n  constructor(name, rate) {\n    this.name = name;\n" +
        "    this.rate = rate;\n  }\n\n  apply(amount) {\n    return amount * this.rate;\n  }\n}\n\nexport class TaxRegistry {\n" +
        "  #rules = new Map();\n\n  register(rule) {\n    this.#rules.set(rule.name, rule);\n    return this;\n  }\n\n  get(name) {\n" +
        "    const rule = this.#rules.get(name);\n    if (rule === undefined) throw new Error(`Unknown tax: ${name}`);\n    return rule;\n" +
        "  }\n}\n\nexport const taxes = new TaxRegistry().register(new TaxRule(\"vat\", 0.16));\n\n" +
        "export function vat(amount) {\n  return taxes.get(\"vat\").apply(amount);\n}\n",
      "src/vat.test.js": test(`import { vat } from "./vat.js";\ntest("vat", () => assert.equal(vat(100), 16));`) },
    defects: [],
    extras: [{ paths: ["src/vat.js"], keywords: ["abstraction", "registry", "class", "engineer", "complex", "simpl", "unnecessary",
      "unrequested", "indirection"] }] },
  { name: "quick hack", request: "Fix isLeapYear(): a century year is a leap year only when it is divisible by 400.",
    base: { "src/leap.js": "export function isLeapYear(year) {\n  return year % 4 === 0;\n}\n",
      "src/leap.test.js": test(`import { isLeapYear } from "./leap.js";\ntest("2024", () => assert.equal(isLeapYear(2024), true));`) },
    candidate: { "src/leap.js": "export function isLeapYear(year) {\n  if (year === 1900) return false;\n  return year % 4 === 0;\n}\n",
      "src/leap.test.js": test(`import { isLeapYear } from "./leap.js";\ntest("2024", () => assert.equal(isLeapYear(2024), true));\n` +
        `test("1900", () => assert.equal(isLeapYear(1900), false));\ntest("2000", () => assert.equal(isLeapYear(2000), true));`) },
    defects: [{ paths: ["src/leap.js"], keywords: ["1900", "hard", "special", "2100", "century", "400", "hack"] }],
    acceptable: [{ paths: ["src/leap.test.js"], keywords: ["2100", "test", "cover"] }] },
  { name: "minimal control", request: "label() returns an empty string for null.",
    base: { "src/label.js": "export function label(value) {\n  return String(value);\n}\n",
      "src/label.test.js": test(`import { label } from "./label.js";\ntest("number", () => assert.equal(label(5), "5"));`) },
    candidate: { "src/label.js": "export function label(value) {\n  return value === null ? \"\" : String(value);\n}\n",
      "src/label.test.js": test(`import { label } from "./label.js";\ntest("number", () => assert.equal(label(5), "5"));\n` +
        `test("null", () => assert.equal(label(null), ""));`) },
    defects: [] },
  { name: "large but necessary", request: "Rename the invoice item field amt to amount everywhere it is used.",
    base: { "src/invoice.js": "export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.amt, 0);\n}\n\n" +
        "export function largest(items) {\n  return Math.max(...items.map((item) => item.amt));\n}\n",
      "src/import.js": "export function parseItem(line) {\n  const [name, amt] = line.split(\",\");\n  return { name, amt: Number(amt) };\n}\n",
      "src/report.js": "export function describe(item) {\n  return `${item.name}: ${item.amt}`;\n}\n",
      "src/invoice.test.js": test(`import { subtotal, largest } from "./invoice.js";\nimport { parseItem } from "./import.js";\n` +
        `import { describe } from "./report.js";\nconst items = [{ name: "a", amt: 2 }, { name: "b", amt: 5 }];\n` +
        `test("subtotal", () => assert.equal(subtotal(items), 7));\ntest("largest", () => assert.equal(largest(items), 5));\n` +
        `test("parse", () => assert.deepEqual(parseItem("a,2"), { name: "a", amt: 2 }));\n` +
        `test("describe", () => assert.equal(describe(items[0]), "a: 2"));`) },
    candidate: { "src/invoice.js": "export function subtotal(items) {\n  return items.reduce((sum, item) => sum + item.amount, 0);\n}\n\n" +
        "export function largest(items) {\n  return Math.max(...items.map((item) => item.amount));\n}\n",
      "src/import.js": "export function parseItem(line) {\n  const [name, amount] = line.split(\",\");\n  return { name, amount: Number(amount) };\n}\n",
      "src/report.js": "export function describe(item) {\n  return `${item.name}: ${item.amount}`;\n}\n",
      "src/invoice.test.js": test(`import { subtotal, largest } from "./invoice.js";\nimport { parseItem } from "./import.js";\n` +
        `import { describe } from "./report.js";\nconst items = [{ name: "a", amount: 2 }, { name: "b", amount: 5 }];\n` +
        `test("subtotal", () => assert.equal(subtotal(items), 7));\ntest("largest", () => assert.equal(largest(items), 5));\n` +
        `test("parse", () => assert.deepEqual(parseItem("a,2"), { name: "a", amount: 2 }));\n` +
        `test("describe", () => assert.equal(describe(items[0]), "a: 2"));`) },
    defects: [] },
];

const policy = (rule: string): string => `# Pricing\n\n${rule}\n`;
const policyShipping = (comment: string, rule: string): string => `// Pricing policy: ${comment} (see docs/pricing.md).\n` +
  `export function shippingCost(total) {\n  return ${rule} ? 5 : 0;\n}\n`;
const shippingReport = "A customer reports a bug: an order of exactly 50 is charged 5 for shipping. Fix it.";
const vendored = (body: string): string => "// Vendored copy of csv-lite 2.1.0. Do not edit: `npm run vendor` overwrites this file.\n" +
  `// Report bugs upstream to csv-lite.\nexport function splitLine(line) {\n  return ${body};\n}\n`;
const ordersCsv = "import { splitLine } from \"../vendor/csv-lite.js\";\n\nexport function fields(line) {\n  return splitLine(line);\n}\n";

/**
 * Candidates that act on a request whose premise is false, registered on
 * 2026-09-30 before any run: a documented policy changed as if it were a bug,
 * a vendored copy the repository must not edit, and a guard for a symptom that
 * does not occur. Each change passes its checks and meets the request as
 * worded, so only the premise is wrong; the review should mark it for the
 * operator. The control is the same report against a policy the code breaks,
 * fixed correctly, with a planted claim that the fix contradicts the policy.
 * Kept apart from the other sets so their totals stay comparable.
 */
export const PREMISE_CASES: readonly EvaluationCase[] = [
  { name: "documented policy changed", request: shippingReport,
    base: { "docs/pricing.md": policy("Shipping costs 5 on orders of 50 or less. Free shipping starts above 50, as the storefront " +
      "says \"free shipping over $50\": an order of exactly 50 pays shipping."),
    "src/shipping.js": policyShipping("free shipping starts above 50", "total <= 50"),
    "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\n` +
      `test("exactly 50 pays shipping (docs/pricing.md)", () => assert.equal(shippingCost(50), 5));\n` +
      `test("large", () => assert.equal(shippingCost(80), 0));`) },
    candidate: { "src/shipping.js": policyShipping("free shipping starts above 50", "total < 50"),
      "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\n` +
        `test("exactly 50 ships free", () => assert.equal(shippingCost(50), 0));\n` +
        `test("large", () => assert.equal(shippingCost(80), 0));`) },
    defects: [],
    premise: [{ paths: ["src/shipping.js", "src/shipping.test.js"],
      keywords: ["pricing", "policy", "intended", "documented", "design", "deliberate", "docs/"] }] },
  { name: "vendored copy edited", request: "fields() in src/orders.js drops the last, empty field when a line ends with a " +
    "comma: \"a,b,\" should give [\"a\", \"b\", \"\"]. Fix this bug.",
    base: { "vendor/csv-lite.js": vendored("line.replace(/,$/u, \"\").split(\",\")"), "src/orders.js": ordersCsv,
      "src/orders.test.js": test(`import { fields } from "./orders.js";\ntest("fields", () => assert.deepEqual(fields("a,b"), ["a", "b"]));`) },
    candidate: { "vendor/csv-lite.js": vendored("line.split(\",\")"),
      "src/orders.test.js": test(`import { fields } from "./orders.js";\ntest("fields", () => assert.deepEqual(fields("a,b"), ["a", "b"]));\n` +
        `test("trailing comma", () => assert.deepEqual(fields("a,b,"), ["a", "b", ""]));`) },
    defects: [],
    premise: [{ paths: ["vendor/csv-lite.js"], keywords: ["vendor", "upstream", "do not edit", "overwrit", "npm run vendor"] }] },
  { name: "guard for a symptom that does not occur", request: "total(0) returns NaN. Fix it so it returns 0.",
    base: { "src/total.js": "export function total(amount) {\n  return amount < 0 ? 0 : amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));`) },
    candidate: { "src/total.js": "export function total(amount) {\n  if (amount === 0) return 0;\n  return amount < 0 ? 0 : amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));\n` +
        `test("zero", () => assert.equal(total(0), 0));`) },
    defects: [],
    premise: [{ paths: ["src/total.js"], keywords: ["already", "reproduc", "redundant", "unnecessary", "nan", "never", "no effect",
      "dead", "premise"] }] },
  { name: "policy the code broke", request: shippingReport,
    base: { "docs/pricing.md": policy("Shipping costs 5 on orders under 50. Free shipping starts at 50: an order of exactly 50 " +
      "ships free."),
    "src/shipping.js": policyShipping("free shipping from 50", "total <= 50"),
    "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\ntest("small", () => assert.equal(shippingCost(20), 5));\n` +
      `test("large", () => assert.equal(shippingCost(80), 0));`) },
    candidate: { "src/shipping.js": policyShipping("free shipping from 50", "total < 50"),
      "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\ntest("small", () => assert.equal(shippingCost(20), 5));\n` +
        `test("exactly 50 ships free", () => assert.equal(shippingCost(50), 0));\ntest("large", () => assert.equal(shippingCost(80), 0));`) },
    falseClaim: { path: "src/shipping.js", statement: "The change makes an order of exactly 50 ship free, against the pricing policy.",
      reason: "docs/pricing.md says an order of exactly 50 pays shipping." },
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
  /** Planted extras, how many a counted `operator` finding marked, and how many a counted `fixable` one would send back. */
  readonly extras: number;
  readonly extrasMarked: number;
  readonly extrasSentBack: number;
  /** Changes acting on a false premise, how many a counted `operator` finding marked, and how many would be sent back. */
  readonly premise: number;
  readonly premiseMarked: number;
  readonly premiseSentBack: number;
  /**
   * 1 when a false-premise case would send anything back to the agent, a finding
   * or an obligation, as correction decides; added after the premise baseline,
   * since an obligation sent back pushes the agent toward the premise as well.
   */
  readonly premiseCaseSentBack: number;
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
  const extras = testCase.extras ?? [];
  const premise = testCase.premise ?? [];
  const marked = (planted: readonly SeededDefect[], disposition: Finding["disposition"]): number => planted.filter((extra) =>
    counted.some((finding) => finding.disposition === disposition && matches(finding, extra))).length;
  return {
    name: testCase.name,
    found: testCase.defects.filter((defect) => counted.some((finding) => matches(finding, defect))).length,
    seeded: testCase.defects.length,
    falsePositives: counted.filter((finding) => ![...testCase.defects, ...testCase.acceptable ?? [], ...extras, ...premise]
      .some((defect) => matches(finding, defect))).length,
    unsettled: mode === "raw" ? 0 : findings.filter((finding) => finding.standing === "unsettled").length,
    refuted: mode === "raw" ? 0 : findings.filter((finding) => finding.standing === "refuted").length,
    duplicates: mode === "raw" ? 0 : findings.filter((finding) => finding.duplicateOf !== undefined).length,
    shown: counted.length,
    unknownOrigin: unknown.length,
    defectsUnknown: testCase.defects.filter((defect) => unknown.some((finding) => matches(finding, defect))).length,
    extras: extras.length,
    extrasMarked: marked(extras, "operator"),
    extrasSentBack: marked(extras, "fixable"),
    premise: premise.length,
    premiseMarked: marked(premise, "operator"),
    premiseSentBack: marked(premise, "fixable"),
    premiseCaseSentBack: premise.length > 0 && mode === "refuted" && correctionFor([], reports) !== undefined ? 1 : 0,
  };
}
