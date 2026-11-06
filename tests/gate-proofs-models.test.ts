import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RecordedRequest } from "../src/gate.js";
import { headCommit } from "../src/git.js";
import { selectModel } from "../src/model-selection.js";
import { subjectOf } from "../src/pull-request-receipt.js";
import { entryReceipt, receiptDecisions, receiptFindings, receiptStanding, type Receipt } from "../src/receipt.js";
import { gateVerdict, keepsWorking } from "../src/verification/gate-rule.js";
import { commit, contract, counterModel, entry, expectStaleReceipt, facts, gate, modelCalls, project, repository, scripted, scriptedModels, state, useGateHarness, write } from "./gate-harness.js";

vi.mock("../src/verification/lemmascript-verifier.js", async (original) =>
  (await import("./gate-harness.js")).lemmaScriptMock(original));
vi.mock("../src/model-check.js", async (original) =>
  (await import("./gate-harness.js")).modelCheckMock(original));

useGateHarness();

it("does not retain proof coverage or contract findings when a command changes the proved source (#617)", async () => {
  const root = repository({ "src/rule.ts": contract,
    "package.json": JSON.stringify({ packageManager: "bun@1.3.11", scripts: { check: "node check.cjs" } }),
    "check.cjs": `require('node:fs').writeFileSync('src/rule.ts', ${JSON.stringify(contract.replace("return 0", "return 999"))});`,
  });
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(root, { "src/rule.ts": contract.replace("return 0", "return 2") });
  const settled = entry(await run.settle());
  const receipt = settled.details as Receipt;
  expect(receipt.codeEvidence.proofs).toMatchObject([{ path: "src/rule.ts", verdict: "operator", evidence: { outcome: "not_started" } }]);
  expect(receipt.specificationEvidence.contracts).toEqual([]);
  expect(receipt.codeEvidence.unverified).toContain("src/rule.ts");
  expect(receipt.codeEvidence.uncovered).toEqual([]);
  expect(settled.content).toContain("Evidence is stale");
  expectStaleReceipt(receipt, "proof", "Proof stale", "src/rule.ts");
  expect(settled.content).not.toContain("  proved        src/rule.ts");
});

it("records the proof files its own proving wrote, so a commit holding them exports and a later edit still doesn't (#737)", async () => {
  state.regenerates = true;
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(root, { "src/rule.ts": contract.replace("return 0", "return 2") });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.proofs).toMatchObject([{ path: "src/rule.ts", evidence: { outcome: "passed", files: ["src/rule.ts", "src/rule.dfy"] } }]);
  expect(receipt.changed === "unreadable" ? "unreadable" : receipt.changed.map(({ path }) => path))
    .toEqual(["src/rule.dfy", "src/rule.dfy.gen", "src/rule.ts"]);
  commit(root, "checked change with its proof");
  expect(await subjectOf(root, receipt, "session", "operator")).toMatchObject({ stale: [], changedAfter: [] });
  write(root, { "src/rule.dfy": "// edited after the run\n" });
  commit(root, "later edit");
  expect(await subjectOf(root, receipt, "session", "operator")).toMatchObject({ stale: ["src/rule.ts"], changedAfter: ["src/rule.dfy"] });
});

it("sends a failed or vacuous proof back, and lets the operator resolve one that could not run", () => {
  expect(gateVerdict("passed", "", [])).toBe("proved");
  expect(gateVerdict("failed", "A", [])).toBe("send_back");
  expect(gateVerdict("vacuous", "B", ["A"])).toBe("send_back");
  expect(gateVerdict("failed", "A", ["A", "B"])).toBe("no_progress");
  expect(gateVerdict("not_started", "A", [])).toBe("operator");
  expect(gateVerdict("timed_out", "A", ["A"])).toBe("operator");
  expect(keepsWorking(["proved", "operator", "no_progress"])).toBe(false);
  expect(keepsWorking(["proved", "send_back"])).toBe(true);
});

it("keeps the agent working while a changed contract fails, and settles with a receipt once it proves", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  expect(await run.settle()).toBeUndefined();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}export const changed = true;\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  writeFileSync(join(root, "src", "rule.dfy.gen"), "// regenerated\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: src/rule.ts does not prove yet.");
  expect(entry(failed).content).toContain("This is not finished yet.");
  expect(entry(failed).content).toContain("and run prove again.");
  // The operator's view of what went back: the proof and its evidence.
  expect(entry(failed).details).toMatchObject({ round: "proofs", proofs: [{ path: "src/rule.ts", evidence: { outcome: "failed", output: "1 verified, 1 error" } }] });
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect((await run.settle())?.continue).toBe(true);
  scripted.delete("src/rule.ts");
  const proved = await run.settle();
  expect(proved?.continue).toBeUndefined();
  expect(entry(proved).customType).toBe("tesota-receipt");
  expect(facts(entry(proved).content)).toBe(["  proved        src/rule.ts", "                Proved in LemmaScript's model: numbers are exact integers or reals, not floating-point, so rounding, NaN and Infinity aren't covered; nor are await and other unsupported features",
    "                content sha256 ccc652fa505b947431e0e61131cecc92a08ca3084e7c79b4171999fc6f20a74f",
    "  not verified  src/rule.ts line 3: outside the contracts that proved, and no verifier covers them",
    "  not verified  notes.md: no verifier covers it",
    "  changed lines implementation +1 -0 · other +2 -1"].join("\n"));
  const receipt = entry(proved).details as Receipt;
  expect(receipt.codeEvidence.proofs.map(({ path, verdict, evidence }) => [path, verdict, evidence.contentHash]))
    .toEqual([["src/rule.ts", "proved", "ccc652fa505b947431e0e61131cecc92a08ca3084e7c79b4171999fc6f20a74f"]]);
  expect(receipt).toMatchObject({ version: 3, base: await headCommit(root), engine: expect.stringMatching(/^0\.1\.0\+(?:[0-9a-f]{7,40}(?:\.dirty)?|unknown)$/) });
  expect(receipt.model).toBeUndefined();
  expect(Date.parse(receipt.settledAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
});

it("lists the changed lines of a proved file that no contract covers, and not those of a contract that proved", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract.replace("return 0;", "return 1;")}\nexport function g(): number {\n` +
    "  return 1;\n}\n");
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toContain("  not verified  src/rule.ts lines 4-6: outside the contracts that proved, and no verifier covers them");
  expect((settled.details as Receipt).codeEvidence.uncovered).toEqual([{ path: "src/rule.ts", lines: [[4, 6]] }]);
});

it("measures the strength of the contracts the request changed once they prove, judged against what the operator asked", async () => {
  const root = repository({ "src/rule.ts": contract,
    "src/other.ts": "//@ ensures \\result >= 0\nexport function g(): number {\n  return 1;\n}\n" });
  const asked: string[] = [];
  const complete = (_model: unknown, context: { messages: { content: { text: string }[] }[]; tools: { name: string }[] }): Promise<unknown> => {
    asked.push(context.messages[0]?.content[0]?.text ?? "");
    const name = context.tools[0]?.name;
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name, arguments: name === "record_comparisons"
      ? { comparisons: [{ function: 1, verdict: "mismatch", explanation: "It allows any non-negative result." }] }
      : { informalizations: [{ function: 1, preconditions: "none", postcondition: "non-negative", strength: "weak" }] } }] });
  };
  const run = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 }, modelRegistry: { complete } });
  await run.input("interactive", undefined, "f returns zero");
  await run.tool("write");
  await run.input("interactive", "steer", "and only zero");
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result >= 0\n//@ ensures \\result <= 1\n" +
    "export function f(): number {\n  return 0;\n}\n");
  writeFileSync(join(root, "src", "other.ts"), "//@ ensures \\result >= 0\nexport function g(): number {\n  return 2;\n}\n");
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toContain("  contract      f in src/rule.ts: all 1 decided changes to its code fail the proof");
  expect(facts(settled.content)).toContain("restatement model: provider/model; comparison model: provider/model");
  expect(facts(settled.content)).toContain("f in src/rule.ts: the model identified a mismatch: It allows any non-negative result.");
  expect(settled.content).not.toContain("g in src/other.ts");
  expect(asked[1]).toContain("1. f returns zero\n2. and only zero");
  expect((settled.details as Receipt).requestReview.contractComparison.contracts.map(({ name, assessment }) => [name, assessment?.verdict])).toEqual([["f", "mismatch"]]);
});

it.each([
  [undefined, undefined, "nonopenai/session"],
  ["other/restater", undefined, "other/restater"],
  ["other/restater", "flag/restater", "flag/restater"],
] as const)("resolves ClaimCheck setting %s and flag %s to %s (#709)", async (setting, flag, expected) => {
  state.verificationModels = setting === undefined ? {} : { claimcheckModel: setting };
  const root = project();
  const asked: string[] = [];
  const run = gate(root, undefined, { model: { provider: "nonopenai", id: "session", contextWindow: 128_000, maxTokens: 4096 },
    flags: { "claimcheck-model": flag }, modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, contextWindow: 128_000, maxTokens: 4096 }),
      complete: (model: { provider: string; id: string }, context: { tools: { name: string }[] }) => {
        asked.push(`${model.provider}/${model.id}`);
        const name = context.tools[0]?.name;
        const arguments_ = name === "record_informalizations" ? { informalizations: [{ function: 1, preconditions: "none",
          postcondition: "returns zero", strength: "strong", flags: [] }] }
          : { comparisons: [{ function: 1, verdict: "no_mismatch_identified", explanation: "Matches." }] };
        return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name, arguments: arguments_ }] });
      },
    } });
  for (const comment of ["first", "second"]) {
    await run.input();
    await run.tool("write");
    write(root, { "src/rule.ts": `//@ ensures \\result === 0\nexport function ${comment}(): number { return 0; }\n` });
    const receipt = entry(await run.settle()).details as Receipt;
    expect(receipt.requestReview.contractComparison.runs[0]).toMatchObject({ status: "completed", restatedBy: expected, comparedBy: "nonopenai/session" });
  }
  expect(asked).toEqual([expected, "nonopenai/session", expected, "nonopenai/session"]);
});

it.each([
  ["restating", "other/unsigned", "other"],
  ["comparing", "nonopenai/session", "nonopenai"],
] as const)("completes and names the unsigned ClaimCheck %s model in the receipt (#709)", async (phase, expectedModel, provider) => {
  const root = project();
  const run = gate(root, undefined, { model: { provider: "nonopenai", id: "session", contextWindow: 128_000, maxTokens: 4096 },
    flags: { "claimcheck-model": "other/unsigned" }, modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, contextWindow: 128_000, maxTokens: 4096 }),
      complete: (model: { provider: string }) => phase === "restating" || model.provider === "nonopenai"
        ? Promise.reject(new Error(`No sign-in for ${provider}`))
        : Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "record_informalizations",
          arguments: { informalizations: [{ function: 1, preconditions: "none", postcondition: "true", strength: "trivial" }] } }] }),
    } });
  await run.input();
  await run.tool("write");
  write(root, { "src/rule.ts": `//@ ensures true\n${contract}` });
  const settled = await run.settle();
  expect(settled?.continue).not.toBe(true);
  expect((entry(settled).details as Receipt).requestReview.contractComparison).toMatchObject({ status: phase === "comparing" ? "partial" : "not_run",
    reason: `${expectedModel} the model request failed: No sign-in for ${provider}` });
  expect(entry(settled).content).toContain(`${expectedModel} the model request failed: No sign-in for ${provider}`);
});

it("restates with the model the claimcheck-model flag names", async () => {
  const root = project();
  const run = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 }, flags: { "claimcheck-model": "other/missing" },
    modelRegistry: { find: () => undefined } });
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `//@ ensures true\n${contract}`);
  expect(entry(await run.settle()).content).toContain("its restating model other/missing isn't a model Tesota knows (provider/id)");
});

it("sends a weak contract back once, then lists it in the receipt", async () => {
  state.mutantOutcome = "passed";
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result <= 5\nexport function f(): number {\n  return 0;\n}\n");
  const sent = await run.settle();
  expect(sent?.continue).toBe(true);
  expect(entry(sent).content).toMatch(/^Tesota: the contract of f in src\/rule\.ts proves, but these changes to its code prove too, so it does not rule them out:\n {2}line 3: 0 became 1\n\nStrengthen the contract/u);
  expect(entry(sent).details).toMatchObject({ round: "contracts", contracts: [{ path: "src/rule.ts", name: "f", mutation: { survived: [{ line: 3, before: "0", after: "1" }] } }] });
  const settled = entry(await run.settle());
  expect(settled.customType).toBe("tesota-receipt");
  expect(facts(settled.content)).toContain("  weak contract f in src/rule.ts");
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result <= 6\nexport function f(): number {\n  return 0;\n}\n");
  expect((await run.settle())?.continue).toBe(true);
});

it("stops on any failure already sent back, alternating ones included, and forgets them on the operator's input only", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "A" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  scripted.set("src/rule.ts", { outcome: "failed", output: "B" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  scripted.set("src/rule.ts", { outcome: "failed", output: "A" });
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toContain(
    "  NOT proved    src/rule.ts: an obligation fails, repeating a failure already sent back");
  expect((entry(stuck).details as Receipt).codeEvidence.proofs.map(({ verdict }) => verdict)).toEqual(["no_progress"]);
  await run.input("extension", "followUp");
  expect((await run.settle())?.continue).toBeUndefined();
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed again\n`);
  expect((await run.settle())?.continue).toBe(true);
});

it("reports a proof that could not run to the operator instead of sending it back", async () => {
  const root = project();
  const run = gate(root);
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "not_started", output: "Dafny is not installed, so nothing was proved." });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).content).toContain(
    "  NOT proved    src/rule.ts: the proof could not run: Dafny is not installed, so nothing was proved.");
});

it("tells the agent to finish its turn instead of running prove when prove is not active", async () => {
  const root = project();
  const run = gate(root, ["read", "edit"]);
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = entry(await run.settle()).content;
  expect(failed).toContain("and finish your turn, and Tesota will prove the file again.");
  expect(failed).not.toContain("prove again");
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect(entry(await run.settle()).content).toContain("Fix that and finish your turn, and Tesota will prove the file again.");
});

it("proves a contract file whose .dfy alone changed, and leaves runs that did not complete alone", async () => {
  const root = project();
  const run = gate(root);
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  expect(await run.settle("aborted")).toBeUndefined();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.dfy"), "// hand-written proof line\n");
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});

it("proves a contract file whose .dfy alone changed where LemmaScript's proof-dir keeps it, and only there (#403)", async () => {
  const root = repository({ "lemmascript.json": JSON.stringify({ "proof-dir": "proofs" }), "src/rule.ts": contract,
    "proofs/src/rule.dfy": "// proof\n", "notes.md": "# Notes\n" });
  const run = gate(root);
  await run.tool("write");
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  // LemmaScript keeps this project's proofs under proofs/, so a .dfy beside the source is not its proof.
  writeFileSync(join(root, "src", "rule.dfy"), "// stray\n");
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  expect(entry(await run.settle()).customType).toBe("tesota-receipt");
  writeFileSync(join(root, "proofs", "src", "rule.dfy"), "// proof\n// hand-written proof line\n");
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});

it("puts each change that may weaken the evidence in the receipt, committed or not", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  const rule = ["//@ requires x >= 0", "//@ ensures \\result >= 0", "//@ ensures \\result >= x",
    "export function f(x: number): number { return x; }", "", "export function g(y: number): number { return y; }", ""];
  writeFileSync(join(root, "src", "rule.ts"), rule.join("\n"));
  writeFileSync(join(root, "src", "rule.dfy"), "method f(x: int) returns (r: int)\n{\n  r := x;\n}\n");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it('f', () => {});\n");
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), ["//@ requires x >= 1", "//@ ensures   \\result >= x", "//@ assume x < 10",
    "export function f(x: number): number { return x; }", "", "//@ skip", "//@ requires y > 0",
    "export function g(y: number): number { return y; }", "", "//@ skip", "//@ requires z > 0",
    "export function h(z: number): number { return z; }", ""].join("\n"));
  rmSync(join(root, "tests", "old.test.ts"));
  commit(root, "agent");
  // LemmaScript's own model of `split`, which its generated program holds, is not the change's assumption.
  const model = "function {:axiom} StringSplit(s: string, d: string): seq<string>\n";
  writeFileSync(join(root, "src", "rule.dfy"), `${model}method f(x: int) returns (r: int)\n{\n  assume false;\n  r := x;\n}\n` +
    "\nlemma Free()\n  ensures false\n");
  writeFileSync(join(root, "src", "rule.dfy.gen"), `${model}method f(x: int) returns (r: int)\n{\n  r := x;\n}\n`);
  writeFileSync(join(root, "src", "extra.dfy"), "lemma {:axiom} Given()\n  ensures false\n");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it.skip('f', () => {});\n");
  writeFileSync(join(root, "src", "new.ts"), "//@ assume false\nexport const a = 1;\n");
  writeFileSync(join(root, "tests", "new.test.ts"), "it('new', () => {});\n");
  const settled = entry(await run.settle());
  expect(facts(settled.content).split("\n").filter((line) => line.startsWith("  may weaken"))).toEqual([
    "  may weaken    src/extra.dfy: trusts Given without proving it (lemma {:axiom} Given())",
    "  may weaken    src/extra.dfy: takes lemma Given as true without proving it (lemma Given without a body)",
    "  may weaken    src/new.ts: takes false as true without proving it (//@ assume false)",
    "  may weaken    src/rule.dfy: takes false as true without proving it (assume false;)",
    "  may weaken    src/rule.dfy: takes lemma Free as true without proving it (lemma Free without a body)",
    "  may weaken    src/rule.ts: removes or changes //@ requires x >= 0",
    "  may weaken    src/rule.ts: removes or changes //@ ensures \\result >= 0",
    "  may weaken    src/rule.ts: adds //@ requires x >= 1 to a function the base had",
    "  may weaken    src/rule.ts: takes x < 10 as true without proving it (//@ assume x < 10)",
    "  may weaken    src/rule.ts: leaves g out of the proof (//@ skip)",
    "  may weaken    src/rule.ts: adds //@ requires y > 0 to a function the base had",
    "  may weaken    tests/old.test.ts: deletes a test file",
    "  may weaken    tests/rule.test.ts: edits a test file; read from the diff, a heuristic flag, not a verdict",
  ].map((line) => `${line}`));
  // How the edit may weaken each test, under its flag.
  expect(facts(settled.content)).toContain("read from the diff, a heuristic flag, not a verdict\n                f: skips it (it.skip)\n");
  expect((settled.details as Receipt).specificationEvidence.weakened).toContainEqual(
    { path: "tests/old.test.ts", kind: "deleted_test" });
  // The proof holds only given the assumptions added to its source and its .dfy, not those of another file.
  expect(facts(settled.content)).toContain("  proved        src/rule.ts, trusting 3 unproved parts the change added");
});

it.each([
  ["models/Fault.cfg", "SPECIFICATION Spec\nCONSTANT DifferentFault = TRUE\n"],
  ["models/Counter.tla", "---- MODULE Counter ----\n====\n"],
  ["models/Counter.cfg", undefined],
  ["models/Counter.tla", undefined],
])("retains selected input identity when replacement/deletion of %s is ignored (#791)", async (path, content) => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  const selection = await selectModel(root, "models/Counter.tla");
  const request: RecordedRequest = { text: "Keep the selected lock-removal check", at: new Date().toISOString(), inputs: [],
    base: { units: [{ folder: "", kind: "commit", commit: await headCommit(root) }], requiredModel: selection } };
  const run = gate(root, undefined, {}, () => request);
  await run.input();
  await run.tool("write");
  if (content === undefined) rmSync(join(root, path));
  else write(root, { [path]: content });
  const feedback = await run.settle();
  expect(feedback?.continue).toBe(true);
  expect(entry(feedback).content).toContain("selected model inputs changed");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.requiredModel).toMatchObject({ selection, state: "changed" });
  expect(receiptFindings(receipt)).toContainEqual(expect.objectContaining({ check: "model", label: "Required model changed", standing: "gap" }));
  expect(receiptStanding(receipt)).not.toBe("verified");
  expect(modelCalls.get("models/Counter.tla") ?? 0).toBe(0);
});

it("checks a required unchanged model without a writing tool and permits changed implementation (#791)", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  const selection = await selectModel(root, "models/Counter.tla");
  const request: RecordedRequest = { text: "Check the selected model", at: new Date().toISOString(), inputs: [],
    base: { units: [{ folder: "", kind: "commit", commit: await headCommit(root) }], requiredModel: selection } };
  const run = gate(root, undefined, {}, () => request);
  await run.input();
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.requiredModel).toMatchObject({ selection, state: "checked" });
  expect(modelCalls.get("models/Counter.tla")).toBe(1);
  await run.input();
  await run.tool("write");
  write(root, { "src/counter.ts": "export const n = 1;\n" });
  const changed = entry(await run.settle()).details as Receipt;
  expect(changed.requiredModel).toMatchObject({ selection, state: "checked" });
  expect(modelCalls.get("models/Counter.tla")).toBe(2);
});

it("retains an unchecked selection when cancelled before any writing tool (#791)", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  const selection = await selectModel(root, "models/Counter.tla");
  const request: RecordedRequest = { text: "Check the selected model", at: new Date().toISOString(), inputs: [],
    base: { units: [{ folder: "", kind: "commit", commit: await headCommit(root) }], requiredModel: selection } };
  const run = gate(root, undefined, {}, () => request);
  await run.input();
  const receipt = entry(await run.settle("aborted")).details as Receipt;
  expect(receipt.requiredModel).toMatchObject({ selection, state: "unchecked" });
  expect(modelCalls.size).toBe(0);
  expect(receiptStanding(receipt)).toBe("incomplete");
});

it("leaves a model's own files out of missing-proof limits (#758)", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/counter.ts": "export const n = 1;\n",
    "models/Counter.tla": `${counterModel()["models/Counter.tla"]}CONSTANT N\n`,
    "models/Counter.cfg": "SPECIFICATION Spec\nCONSTANT N = 1\n",
    "models/Fault.cfg": "SPECIFICATION Spec\nCONSTANT N = 2\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.models?.map(({ path, verdict }) => [path, verdict])).toEqual([["models/Counter.tla", "proved"]]);
  expect(receipt.codeEvidence.unverified).toEqual(["src/counter.ts"]);
  expect(receiptFindings(receipt).filter(({ standing, check }) => standing === "gap" && check === "coverage").map(({ subject }) => subject))
    .toEqual(["src/counter.ts"]);
});

it.each(["failed", "weak", "unchecked"] as const)("keeps a %s model's own files unverified by standing (#758)", async (status) => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  scriptedModels.set("models/Counter.tla", () => status === "unchecked"
    ? { outcome: "not_started", run: "not_started", faults: [] }
    : { outcome: "failed", run: status === "weak" ? "passed" : "violated",
      faults: [{ path: "models/Fault.cfg", description: "lock removed", verdict: "passes", output: "", durationMs: 1 }] });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "models/Counter.tla": `${counterModel()["models/Counter.tla"]}CONSTANT N\n`,
    "models/Counter.cfg": "SPECIFICATION Spec\nCONSTANT N = 1\n",
    "models/Fault.cfg": "SPECIFICATION Spec\nCONSTANT N = 2\n" });
  const first = await run.settle();
  const receipt = entry(first?.continue ? await run.settle() : first).details as Receipt;
  expect(receiptStanding(receipt)).toBe(status === "unchecked" ? "unverified" : "failed");
  expect(receipt.codeEvidence.unverified).toEqual([]);
  // Model failure or inability to run must stand independently of the mock's staleness gap.
  const withoutModelGap = { ...receipt,
      codeEvidence: { ...receipt.codeEvidence, models: (receipt.codeEvidence.models ?? []).map((model) => ({ ...model,
              staleness: "current" as const, stale: [] })) }
};
  expect(receiptStanding(withoutModelGap)).not.toBe("verified");
});

it("publishes captured previews as transcript metadata without changing receipt v2", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  scriptedModels.set("models/Counter.tla", () => ({ outcome: "passed", run: "passed", faults: [],
    capture: { status: "captured", manifest: "/sessions/run.manifest.json", preview: { reached: 9, violating: 0,
      partial: false, kind: "graph", entries: ["1 -> 2"], omitted: false } } }));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const settled = await run.settle();
  const published = JSON.parse(JSON.stringify(settled?.entries?.[0]));
  expect(published.customType).toBe("tesota-receipt-graphs");
  expect(published.details.graphs).toMatchObject([{ subject: "models/Counter.tla", capture: { status: "captured", preview: { reached: 9 } } }]);
  const receipt = entryReceipt(published) as Receipt;
  expect(receipt.version).toBe(3);
  expect(receipt.codeEvidence.models?.[0]?.capture).toBeUndefined();
  expect(receipt.codeEvidence.models?.[0]?.verdict).toBe("proved");
});

it("model-checks a model when the request changes the code it covers, and leaves it alone otherwise", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", "notes.md": "# Notes\n", ...counterModel() });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes, edited\n");
  const untouched = entry(await run.settle()).details as Receipt;
  expect(untouched.codeEvidence.models).toBeUndefined();
  expect(modelCalls.size).toBe(0);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const settled = entry(await run.settle());
  const receipt = settled.details as Receipt;
  expect(receipt.codeEvidence.models?.map(({ path, verdict, evidence }) => [path, verdict, evidence.verifier])).toEqual([["models/Counter.tla", "proved", "tlc"]]);
  expect(run.steps.some((status) => status.step === "checking" && status.path === "models/Counter.tla")).toBe(true);
  expect(receiptFindings(receipt).filter(({ check }) => check === "model").map(({ standing, label }) => [standing, label]))
    .toEqual([["holds", "Model-checked"], ["gap", "Model possibly stale"]]);
  expect(facts(settled.content)).toContain("  model-checked models/Counter.tla: Safe holds in all 9 reachable states; caught 1 of 1 planted fault; " +
    "not linked to the code");
  expect(settled.content).toContain("Leaves out: crashes");
});

it("sends back a model whose planted fault passes, keeps each check of unchanged content, and reports the repeat as too weak", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel(), ...counterModel("Other") });
  scriptedModels.set("models/Counter.tla", () => ({ outcome: "failed", run: "passed",
    faults: [{ path: "models/Fault.cfg", description: "lock removed", verdict: "passes", output: "", durationMs: 1 }] }));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const sent = await run.settle();
  expect(sent?.continue).toBe(true);
  expect(entry(sent).content).toMatch(/^Tesota: the model models\/Counter\.tla passes, but these planted faults pass too, so the model cannot tell them from the code:\n {2}models\/Fault\.cfg: lock removed/u);
  expect(entry(sent).details).toMatchObject({ round: "models", models: [{ path: "models/Counter.tla" }], unheaded: [] });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.models?.map(({ path, verdict }) => [path, verdict])).toEqual([["models/Counter.tla", "no_progress"], ["models/Other.tla", "proved"]]);
  expect(modelCalls.get("models/Other.tla")).toBe(1);
  expect(modelCalls.get("models/Counter.tla")).toBe(1);
  expect(receiptFindings(receipt).find(({ label }) => label === "Model too weak")).toMatchObject({ standing: "decide",
    detail: "models/Fault.cfg passes" });
});

it("never fails a run when TLC cannot check a model, and says why", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  scriptedModels.set("models/Counter.tla", () => ({ outcome: "not_started", run: "not_started", faults: [] }));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.models?.[0]?.verdict).toBe("operator");
  expect(receiptFindings(receipt).find(({ check }) => check === "model")).toMatchObject({ standing: "gap", label: "Model not checked" });
  expect(receiptDecisions(receipt)).toBe(0);
});

it("asks once for a header on a TLA+ model the request wrote without one, then lists it as not checked", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "spec/Race.tla": "---- MODULE Race ----\n====\n", "spec/Race.cfg": "INIT Init\n", "spec/Helper.tla": "---- MODULE Helper ----\n====\n" });
  const sent = await run.settle();
  expect(sent?.continue).toBe(true);
  expect(entry(sent).content).toMatch(/^Tesota: spec\/Race\.tla looks like a model with no tesota-model header/u);
  expect(entry(sent).details).toMatchObject({ round: "models", models: [], unheaded: ["spec/Race.tla"] });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.unheaded).toEqual(["spec/Race.tla"]);
  expect(receiptFindings(receipt).find(({ check }) => check === "model")).toMatchObject({ standing: "gap", subject: "spec/Race.tla" });
});
