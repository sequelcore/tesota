import { expect, it } from "vitest";
import { type Comparison, claimCheck, claimcheckResult, comparePrompt, informalizePrompt } from "../src/pi-claimcheck.js";
import { contracts } from "../src/proof-guarantees.js";

const source = [
  "//@ ensures denied ==> \\result === false",
  "//@ ensures !denied && allowed ==> \\result === true",
  "export function canAccess(denied: boolean, allowed: boolean): boolean {",
  "  return !denied && allowed;",
  "}",
  "//@ requires n >= 0",
  "//@ ensures \\result >= 0",
  "function double(n: number): number { return n * 2; }",
].join("\n");
const items = contracts("src/policy.ts", source);
const requests = ["Denied paths must always win over allowed ones."];
const models = { restatedBy: "p/r", comparedBy: "p/c" };
const justified = (fn: number): Comparison => ({ function: fn, verdict: "justified", explanation: "Matches." });

/** A session whose model answers each request with `replies` in turn, recording what it was asked. */
function session(...replies: object[]): { ctx: Parameters<typeof claimCheck>[0]; asked: string[]; models: string[] } {
  const asked: string[] = [];
  const models: string[] = [];
  const complete = (model: { id: string }, context: { messages: { content: { text: string }[] }[] }): Promise<unknown> => {
    asked.push(context.messages[0]?.content[0]?.text ?? "");
    models.push(model.id);
    const reply = replies[asked.length - 1];
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ stopReason: "toolUse", content: [], ...reply });
  };
  const find = (provider: string, id: string): object | undefined =>
    provider === "other" && id === "restater" ? { provider, id } : undefined;
  return { ctx: { model: { provider: "provider", id: "model" } as never, modelRegistry: { complete, find } as never }, asked, models };
}

const call = (name: string, args: object): object => ({ content: [{ type: "toolCall", id: "1", name, arguments: args }] });
const informalized = call("record_informalizations", { informalizations: [
  { function: 1, preconditions: "none", postcondition: "denied gives false", strength: "strong" },
  { function: 2, preconditions: "n >= 0", postcondition: "result >= 0", strength: "weak" }] });

it("restates contracts without ever showing the request, then compares them with the request", () => {
  const first = informalizePrompt(items);
  expect(first).toContain("### Function 1: canAccess (src/policy.ts)");
  expect(first).not.toContain("Denied paths must always win");
  const second = comparePrompt(requests, items, [{ function: 1, preconditions: "none", postcondition: "denied gives false",
    strength: "strong" }]);
  expect(second).toContain("1. Denied paths must always win over allowed ones.");
  expect(second).toContain("- Postcondition: denied gives false");
  expect(second).toContain("### Function 2: double (src/policy.ts)");
  expect(second).toContain("- Postcondition: (missing)");
});

it("keeps the judgments in the contracts' order, and judges nothing when a contract was not compared", () => {
  const vacuous: Comparison = { function: 2, verdict: "vacuous", explanation: "Always true for doubles of non-negatives." };
  expect(claimcheckResult(models, items, [vacuous, justified(1)])).toEqual({ status: "judged", ...models, judgments: [
    { verdict: "justified", explanation: "Matches." }, { verdict: "vacuous", explanation: "Always true for doubles of non-negatives." }] });
  expect(claimcheckResult(models, items, [justified(1)])).toEqual({ status: "not_judged", reason: "no comparison for double" });
});

it("asks the session's model in two requests, the first without the request, and names the model that judged", async () => {
  const { ctx, asked } = session(informalized, call("record_comparisons", { comparisons: [justified(1),
    { function: 2, verdict: "partially_justified", explanation: "Says nothing of doubling." }] }));
  expect(await claimCheck(ctx, requests, items, new AbortController().signal)).toEqual({ status: "judged",
    restatedBy: "provider/model", comparedBy: "provider/model",
    judgments: [{ verdict: "justified", explanation: "Matches." }, { verdict: "partially_justified", explanation: "Says nothing of doubling." }] });
  expect(asked).toHaveLength(2);
  expect(asked[0]).not.toContain(requests[0]);
  expect(asked[1]).toContain(requests[0]);
});

it("restates with the second model when one is set, and judges nothing when the registry lacks it", async () => {
  const comparisons = call("record_comparisons", { comparisons: [justified(1), justified(2)] });
  const second = session(informalized, comparisons);
  expect(await claimCheck(second.ctx, requests, items, new AbortController().signal, "other/restater"))
    .toMatchObject({ status: "judged", restatedBy: "other/restater", comparedBy: "provider/model" });
  expect(second.models).toEqual(["restater", "model"]);
  for (const setting of ["other/missing", "restater"]) {
    const missing = session(informalized, comparisons);
    expect(await claimCheck(missing.ctx, requests, items, new AbortController().signal, setting)).toEqual({ status: "not_judged",
      reason: `its restating model ${setting} is not a provider/id in Pi's model registry` });
    expect(missing.asked).toEqual([]);
  }
});

it("judges nothing, and says why, without a model or a usable answer", async () => {
  const signal = new AbortController().signal;
  expect(await claimCheck({ model: undefined, modelRegistry: {} as never }, requests, items, signal))
    .toEqual({ status: "not_judged", reason: "no model is selected" });
  expect(await claimCheck(session({ stopReason: "error", errorMessage: "rate limited" }).ctx, requests, items, signal))
    .toEqual({ status: "not_judged", reason: "the model request failed: rate limited" });
  expect(await claimCheck(session(new Error("offline")).ctx, requests, items, signal))
    .toEqual({ status: "not_judged", reason: "the model request failed: offline" });
  expect(await claimCheck(session(informalized, call("record_comparisons", { comparisons: [{ function: 1, verdict: "fine" }] })).ctx,
    requests, items, signal)).toEqual({ status: "not_judged", reason: "the model did not record its answer" });
  expect(await claimCheck(session({ content: [{ type: "text", text: "They look right." }] }).ctx, requests, items, signal))
    .toEqual({ status: "not_judged", reason: "the model did not record its answer" });
  const stopped = new AbortController();
  stopped.abort();
  expect(await claimCheck(session({ stopReason: "aborted" }).ctx, requests, items, stopped.signal))
    .toEqual({ status: "not_judged", reason: "was stopped" });
});
