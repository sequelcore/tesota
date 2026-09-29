/**
 * The working agent's evaluation for issue #165, registered before any run:
 * requests already fixed, partly fixed and not fixed, where the right result
 * is no change, a finished fix and a fix; and questions whose replies are
 * measured in words, with the facts each must still state, so a shorter reply
 * that drops what was asked does not count as better.
 */

export type AgentCaseKind = "already fixed" | "partly fixed" | "unfixed";

export interface AgentFixCase {
  readonly name: string;
  readonly kind: AgentCaseKind;
  readonly request: string;
  readonly base: Readonly<Record<string, string>>;
  /** Run after the agent finishes, never shown to it: it passes only when the request is met. */
  readonly hiddenTest: string;
}

/** One fact a reply must state: it counts when any of its phrasings appears. */
export type Fact = readonly string[];

export interface AgentQuestion {
  readonly question: string;
  readonly facts: readonly Fact[];
}

const test = (body: string): string => `import test from "node:test";\nimport assert from "node:assert";\n${body}\n`;

export const AGENT_FIX_CASES: readonly AgentFixCase[] = [
  { name: "leap year already fixed", kind: "already fixed",
    request: "Fix isLeapYear(): a century year is a leap year only when it is divisible by 400.",
    base: { "src/leap.js": "export function isLeapYear(year) {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);\n}\n",
      "src/leap.test.js": test(`import { isLeapYear } from "./leap.js";\ntest("2024", () => assert.equal(isLeapYear(2024), true));`) },
    hiddenTest: test(`import { isLeapYear } from "../src/leap.js";\ntest("rule", () => {\n  assert.equal(isLeapYear(2024), true);\n` +
      `  assert.equal(isLeapYear(1900), false);\n  assert.equal(isLeapYear(2100), false);\n  assert.equal(isLeapYear(2000), true);\n});`) },
  { name: "slug partly fixed", kind: "partly fixed",
    request: "Make slugify() lowercase the text and replace each space with a hyphen.",
    base: { "src/slug.js": "export function slugify(text) {\n  return text.toLowerCase();\n}\n",
      "src/slug.test.js": test(`import { slugify } from "./slug.js";\ntest("lowercase", () => assert.equal(slugify("Hello"), "hello"));`) },
    hiddenTest: test(`import { slugify } from "../src/slug.js";\ntest("slug", () => {\n  assert.equal(slugify("Hello World"), "hello-world");\n` +
      `  assert.equal(slugify("A B C"), "a-b-c");\n});`) },
  { name: "negative total unfixed", kind: "unfixed",
    request: "Return 0 for negative amounts in total().",
    base: { "src/total.js": "export function total(amount) {\n  return amount;\n}\n",
      "src/total.test.js": test(`import { total } from "./total.js";\ntest("positive", () => assert.equal(total(5), 5));`) },
    hiddenTest: test(`import { total } from "../src/total.js";\ntest("total", () => {\n  assert.equal(total(-3), 0);\n` +
      `  assert.equal(total(5), 5);\n});`) },
];

/** A small shop repository the questions are asked about. */
export const QUESTION_REPOSITORY: Readonly<Record<string, string>> = {
  "src/price.js": "export function total(amount) {\n  return amount > 100 ? amount * 0.9 : amount;\n}\n",
  "src/tax.js": "export function tax(amount) {\n  return amount * 0.16;\n}\n",
  "src/shipping.js": "export function shippingCost(total) {\n  return total < 50 ? 5 : 0;\n}\n",
  "src/format.js": "export function money(value) {\n  return \"$\" + value.toFixed(2);\n}\n",
  "src/orders.js": "export function toCsv(rows) {\n  const csv = rows.map((row) => row.join(\",\")).join(\"\\n\");\n" +
    "  console.log(`Exported ${rows.length} rows`);\n  return csv;\n}\n",
  "src/users.js": "export function saveName(store, name) {\n  store.name = name.trim();\n}\n",
  "src/shipping.test.js": test(`import { shippingCost } from "./shipping.js";\ntest("small", () => assert.equal(shippingCost(20), 5));`),
};

export const AGENT_QUESTIONS: readonly AgentQuestion[] = [
  { question: "What discount does total() give, and above what amount?", facts: [["10%", "0.9", "10 %", "ten percent"], ["100"]] },
  { question: "What is the tax rate in tax()?", facts: [["16"]] },
  { question: "How much is shipping for an order of 30?", facts: [["5"]] },
  { question: "Is shipping charged on an order of exactly 50?", facts: [["no", "free", "not"]] },
  { question: "What does money(5) return?", facts: [["$5.00"]] },
  { question: "Which file defines toCsv?", facts: [["orders.js"]] },
  { question: "Does saveName() trim the name before saving it?", facts: [["yes", "trims"]] },
  { question: "What does toCsv log?", facts: [["rows"]] },
  { question: "Which function formats money, and in which file?", facts: [["money"], ["format.js"]] },
  { question: "Does total() change amounts of 100 or less?", facts: [["no", "unchanged", "not"]] },
  { question: "What does tax(200) return?", facts: [["32"]] },
  { question: "What separator does toCsv put between fields?", facts: [["comma", "\",\""]] },
  { question: "Which test file covers shippingCost?", facts: [["shipping.test.js"]] },
  { question: "Is the currency symbol in money() configurable?", facts: [["no", "not", "hard"]] },
  { question: "In one sentence, what does this repository do?", facts: [["order", "shop", "price", "pricing"]] },
];

/** Words in a reply, as whitespace-separated tokens. */
export function wordCount(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

/** How many of the facts a reply states. */
export function factsStated(facts: readonly Fact[], reply: string): number {
  const text = reply.toLowerCase();
  return facts.filter((fact) => fact.some((phrasing) => text.includes(phrasing.toLowerCase()))).length;
}

/** Changed paths that are production code, as FixedBench counts them: not tests and not documentation. */
export function productionChanges(paths: readonly string[]): string[] {
  return paths.filter((path) => !/\.test\.[cm]?js$|\.md$/u.test(path));
}

/** The value at a quantile of sorted values, by the nearest rank; undefined when there are none. */
export function quantile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * The only commands the agent may run: Node's test runner on paths in its
 * copy. Everything else is refused, as `live:delegation` refuses all.
 */
export function allowedCommand(command: string): boolean {
  return /^node --test(?: [\w./*"'-]+)*$/u.test(command.trim());
}
