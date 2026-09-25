import { expect, it } from "vitest";
import { claimcheckReport, comparePrompt, contracts, informalizePrompt } from "../src/integrations/pi-claimcheck.js";

const source = [
  "//@ ensures denied ==> \\result === false",
  "//@ ensures !denied && allowed ==> \\result === true",
  "export function canAccess(denied: boolean, allowed: boolean): boolean {",
  "  //@ invariant true",
  "  return !denied && allowed;",
  "}",
  "",
  "export function helper(): number { return 1; }",
  "//@ requires n >= 0",
  "//@ ensures \\result >= 0",
  "function double(n: number): number { return n * 2; }",
].join("\n");
const items = contracts("src/policy.ts", source);
const requests = ["Denied paths must always win over allowed ones."];

it("reads each function's contract, not annotations inside bodies or unannotated functions", () => {
  expect(items).toEqual([
    { path: "src/policy.ts", name: "canAccess", text: "//@ ensures denied ==> \\result === false\n" +
      "//@ ensures !denied && allowed ==> \\result === true\nexport function canAccess(denied: boolean, allowed: boolean): boolean {" },
    { path: "src/policy.ts", name: "double", text: "//@ requires n >= 0\n//@ ensures \\result >= 0\nfunction double(n: number): number { return n * 2; }" },
  ]);
});

it("restates contracts without ever showing the requests, then compares them with the requests", () => {
  const first = informalizePrompt(items);
  expect(first).toContain("canAccess");
  expect(first).not.toContain("Denied paths must always win");
  const informalizations = [{ name: "canAccess", preconditions: "none", postcondition: "denied gives false", strength: "strong" as const }];
  const second = comparePrompt(requests, items, informalizations);
  expect(second).toContain("1. Denied paths must always win over allowed ones.");
  expect(second).toContain("- Postcondition: denied gives false");
  expect(second).toContain("### double (src/policy.ts)");
  expect(second).toContain("- Postcondition: (missing)");
});

it("reports contracts that miss the request, and is unfinished when a contract was not compared", () => {
  const tree = "t".repeat(40);
  const done = { status: "completed" as const, reply: "" };
  expect(claimcheckReport(tree, items, [
    { name: "canAccess", verdict: "justified", disposition: "fixable", explanation: "Matches." },
    { name: "double", verdict: "vacuous", disposition: "operator", explanation: "Always true for doubles of non-negatives." },
  ], done)).toEqual({ reviewer: "ClaimCheck method", tree, status: "completed",
    summary: "1 of 2 proved contracts express what was asked.", findings: [
      { severity: "high", disposition: "operator", path: "src/policy.ts",
        statement: "The proved contract of double proves nothing beyond its assumptions.",
        reason: "Always true for doubles of non-negatives." }] });
  expect(claimcheckReport(tree, items, [{ name: "canAccess", verdict: "justified", disposition: "fixable", explanation: "" }], done))
    .toMatchObject({ status: "incomplete", reason: "no comparison for double" });
  expect(claimcheckReport(tree, items, undefined, { status: "cancelled" })).toMatchObject({ status: "incomplete" });
});
