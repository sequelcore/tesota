import { expect, it, vi } from "vitest";
import { bodyEnd, changedContracts, contractStrength, contracts } from "../src/proof-guarantees.js";
import { renderReceipt } from "../src/receipt.js";

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

it("reads each function's contract, not annotations inside bodies or unannotated functions", () => {
  expect(contracts("src/rules.ts", base)).toEqual([
    { path: "src/rules.ts", name: "clamp", text: "//@ ensures \\result >= 0\nexport function clamp(value: number): number {",
      line: 1, endLine: 2 },
    { path: "src/rules.ts", name: "total", text: "//@ ensures \\result >= 0\nexport function total(amount: number): number {",
      line: 11, endLine: 12 },
  ]);
});

it("finds where a function's body closes, past braces inside strings and comments", () => {
  const source = "export function f(a: string): number {\n  const s = \"}\"; // }\n  if (a) {\n    return 1;\n  }\n  return 0;\n}\nconst x = 1;\n";
  expect(bodyEnd(source, 1)).toBe(7);
  expect(bodyEnd("export function g(): void;\n", 1)).toBe(1);
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
    lines: ["//@ requires amount >= 0", "//@ ensures \\result === amount"], mutation: { rejected: 3, survived: [], inconclusive: 0 },
    judgment: { verdict: "partially_justified", explanation: "It excludes negative amounts." } }] });
  expect(renderReceipt({ version: 0, repository: true, proofs: [], tests: [], exercises: [], weakened: [], unverified: [], ...strength }))
    .toContain("  model judged  by ClaimCheck on provider/model, one model for both requests, a model's judgment against the request, not a proof:\n" +
      "                total in src/rules.ts covers only part of what was asked: It excludes negative amounts.");
  expect(await contractStrength(ctx, [], [{ path: "src/rules.ts", source: base, baseSource: base }], new AbortController().signal))
    .toEqual({ contracts: [] });
  expect(complete).toHaveBeenCalledTimes(2);
});

it("says when ClaimCheck judged nothing", async () => {
  const strength = await contractStrength({ model: undefined, modelRegistry: {} as never }, [],
    [{ path: "src/rules.ts", source: changed, baseSource: base }], new AbortController().signal);
  expect(renderReceipt({ version: 0, repository: true, proofs: [], tests: [], exercises: [], weakened: [], unverified: [], ...strength }))
    .toContain("  not judged    whether the contracts express the request: ClaimCheck no model is selected");
});

it("names each model when a second one restated", () => {
  expect(renderReceipt({ version: 0, repository: true, proofs: [], tests: [], exercises: [], weakened: [], unverified: [], contracts: [],
    claimcheck: { status: "judged", restatedBy: "other/restater", comparedBy: "provider/model" } }))
    .toContain("  model judged  by ClaimCheck on other/restater restating and provider/model comparing, a model's judgment");
});
