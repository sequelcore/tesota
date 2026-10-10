import { expect, it, vi } from "vitest";
import { changedContracts, contractStrength, contracts } from "../src/proof-guarantees.js";
import { renderReceipt } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

/** Every mutant fails its proof: what mutation finds is under test in proof-mutation.test.ts. */
vi.mock("../src/verification/lemmascript-verifier.js", async (original) => ({
  ...await original<typeof import("../src/verification/lemmascript-verifier.js")>(),
  proveSource: () => Promise.resolve("failed"),
}));

const base = [
  "//@ ensures \\result >= 0",
  "export function clamp(value: number): number {",
  "  if (value < 0) return 1;",
  "  return value;",
  "}",
  "",
  "export function helper(value: number): number {",
  "  return value;",
  "}",
  "",
  "//@ ensures \\result >= 0",
  "export function total(amount: number): number {",
  "  //@ invariant amount >= 0",
  "  return amount < 0 ? 1 : amount;",
  "}",
  "",
].join("\n");
// The request fixes clamp's body, and gives total a precondition and a stronger ensures.
const changed = base.replace("return 1;", "return 0;").replace("//@ ensures \\result >= 0\nexport function total",
  "//@ requires amount >= 0\n//@ ensures \\result === amount\nexport function total");

it("reads each function's contract, not proof annotations inside bodies or unannotated functions", () => {
  expect(contracts("src/rules.ts", base)).toMatchObject([
    { path: "src/rules.ts", name: "clamp", text: "//@ ensures \\result >= 0\nexport function clamp(value: number): number {",
      line: 1, endLine: 2, bodyEnd: 5, annotations: [{ line: 1, text: "//@ ensures \\result >= 0" }], readsAbove: true,
      parameters: ["value"] },
    { path: "src/rules.ts", name: "total", text: "//@ ensures \\result >= 0\nexport function total(amount: number): number {",
      line: 11, endLine: 12, bodyEnd: 15 },
  ]);
});

it("keeps a contract across comment lines before its function, as LemmaScript does, and drops it after a code line", () => {
  const commented = "//@ ensures \\result > 0\n// reviewed\n\n/**\n * Doc.\n */\n/* reviewed\n   again\n*/\nexport function f(): number {\n" +
    "  return 1;\n}\n";
  expect(contracts("src/rule.ts", commented)).toMatchObject([{ path: "src/rule.ts", name: "f",
    text: "//@ ensures \\result > 0\nexport function f(): number {", line: 1, endLine: 10, bodyEnd: 12 }]);
  expect(contracts("src/rule.ts", commented.replace("// reviewed", "const k = 1;"))).toEqual([]);
});

it("reads the function annotations before a body's first statement, where LemmaScript's specification places them", () => {
  const source = ["//@ requires n > 0", "export function f(n: number): number {", "  // first the contract", "  //@ ensures \\result > n",
    "  //@ assume n < 10", "  const k = n + 1;", "  //@ ensures \\result > 0", "  return k;", "}", "",
    "export function g({ n }: { n: number }): number {", "  //@ ensures \\result === n", "  return n;", "}", ""].join("\n");
  expect(contracts("src/rule.ts", source)).toMatchObject([
    { name: "f", line: 1, endLine: 2, bodyEnd: 9, annotations: [{ line: 1, text: "//@ requires n > 0" }, { line: 4, text: "//@ ensures \\result > n" }],
      text: "//@ requires n > 0\nexport function f(n: number): number {\n//@ ensures \\result > n", parameters: ["n"] },
    { name: "g", line: 11, endLine: 11, bodyEnd: 14, parameters: undefined },
  ]);
});

it("reads the contracts of default-exported functions and arrow functions, as LemmaScript extracts them", () => {
  // An arrow function with a block body has its contract read only inside the body, so h's above it is not one.
  const source = ["//@ ensures \\result > 0", "export default function f(): number {", "  return 1;", "}", "",
    "//@ ensures \\result === n + 1", "export const g = (n: number): number => n + 1;", "",
    "//@ ensures \\result >= 0", "const h = (n: number): number => {", "  return n < 0 ? 0 : n;", "};", "",
    "const i = (n: number): number => {", "  //@ ensures \\result >= 0", "  return n < 0 ? 0 : n;", "};", "",
    "//@ ensures \\result > 0", "const k = 1;", ""].join("\n");
  expect(contracts("src/rule.ts", source).map(({ name, line, endLine, bodyEnd, readsAbove }) =>
    ({ name, line, endLine, bodyEnd, readsAbove }))).toEqual([
    { name: "f", line: 1, endLine: 2, bodyEnd: 4, readsAbove: true },
    { name: "g", line: 6, endLine: 7, bodyEnd: 7, readsAbove: true },
    { name: "i", line: 14, endLine: 14, bodyEnd: 17, readsAbove: false },
  ]);
  const g = contracts("src/rule.ts", source)[1];
  expect(g === undefined ? "" : source.slice(...g.body)).toBe("n + 1");
});

it("measures the strength of a contract a comment separates from its function", async () => {
  const source = "//@ ensures \\result > 0\n// reviewed\nexport function f(): number {\n  return 1;\n}\n";
  const strength = await contractStrength({ model: undefined, modelRegistry: {} as never }, [],
    [{ path: "src/rule.ts", source, baseSource: undefined }], new AbortController().signal);
  expect(strength.contracts).toMatchObject([{ name: "f", lines: ["//@ ensures \\result > 0"] }]);
  expect(strength.contracts[0]?.mutation.rejected).toBeGreaterThan(0);
});

it("finds where a function's body closes, past braces inside strings and comments", () => {
  const source = "//@ ensures \\result >= 0\nexport function f(a: string): number {\n  const s = \"}\"; // }\n  if (a) {\n    return 1;\n  }\n" +
    "  return 0;\n}\nconst x = 1;\n";
  expect(contracts("src/rule.ts", source)[0]?.bodyEnd).toBe(8);
});

it("takes only the contracts the request added or changed, whatever their indentation", () => {
  expect(changedContracts("src/rules.ts", changed, base).map(({ name }) => name)).toEqual(["total"]);
  expect(changedContracts("src/rules.ts", base.replace("//@ ensures", "  //@ ensures"), base)).toEqual([]);
  expect(changedContracts("src/rules.ts", changed, undefined).map(({ name }) => name)).toEqual(["clamp", "total"]);
});

it("mutates and has a model judge only the changed contracts, and labels the verdict a model's judgment", async () => {
  const complete = vi.fn((_model: unknown, context: { tools: { name: string }[] }) => Promise.resolve({ stopReason: "toolUse",
    content: [{ type: "toolCall", id: "1", name: context.tools[0]?.name, arguments: context.tools[0]?.name === "record_comparisons"
      ? { comparisons: [{ function: 1, verdict: "partially_justified", explanation: "It excludes negative amounts." }] }
      : { informalizations: [{ function: 1, preconditions: "amount >= 0", postcondition: "returns amount", strength: "moderate" }] } }] }));
  const ctx = { model: { provider: "provider", id: "model" } as never, modelRegistry: { complete } as never };
  const strength = await contractStrength(ctx, ["total keeps negative amounts"], [{ path: "src/rules.ts", source: changed, baseSource: base }],
    new AbortController().signal);
  expect(strength).toEqual({ claimcheck: { status: "judged", restatedBy: "provider/model", comparedBy: "provider/model" }, contracts: [{ path: "src/rules.ts", name: "total",
    lines: ["//@ requires amount >= 0", "//@ ensures \\result === amount"], mutation: { rejected: 3, survived: [], inconclusive: 0, equivalent: 0 },
    judgment: { verdict: "partially_justified", explanation: "It excludes negative amounts." } }] });
  expect(renderReceipt({ ...emptyReceipt, ...strength }))
    .toContain("  model judged  by ClaimCheck on provider/model, one model for both requests, a model's judgment against the request, not a proof:\n" +
      "                total in src/rules.ts covers only part of what was asked: It excludes negative amounts.");
  expect(await contractStrength(ctx, [], [{ path: "src/rules.ts", source: base, baseSource: base }], new AbortController().signal))
    .toEqual({ contracts: [] });
  expect(complete).toHaveBeenCalledTimes(2);
});

it("says when ClaimCheck judged nothing", async () => {
  const strength = await contractStrength({ model: undefined, modelRegistry: {} as never }, [],
    [{ path: "src/rules.ts", source: changed, baseSource: base }], new AbortController().signal);
  expect(renderReceipt({ ...emptyReceipt, ...strength }))
    .toContain("  not judged    whether the contracts express the request: ClaimCheck no model is selected");
});

it("names each model when a second one restated", () => {
  expect(renderReceipt({ ...emptyReceipt, contracts: [],
    claimcheck: { status: "judged", restatedBy: "other/restater", comparedBy: "provider/model" } }))
    .toContain("  model judged  by ClaimCheck on other/restater restating and provider/model comparing, a model's judgment");
});
