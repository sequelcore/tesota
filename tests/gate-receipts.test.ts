import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Clarification, RequestInput } from "../src/clarification.js";
import { evidenceParts, evidenceText } from "../src/footer.js";
import { GateProgress } from "../src/gate.js";
import { headCommit } from "../src/git.js";
import { openCasesSystemPrompt } from "../src/open-cases.js";
import { suggestChecks } from "../src/projects.js";
import { subjectOf } from "../src/pull-request-receipt.js";
import { receiptStanding, renderReceipt, type Receipt } from "../src/receipt.js";
import { toolMayChangeFiles } from "../src/verification/gate-rule.js";
import { commit, contract, counterModel, entry, facts, folder, gate, project, repository, scripted, shape, state, useGateHarness, write } from "./gate-harness.js";
import { emptyReceipt } from "./receipts.js";

vi.mock("../src/verification/lemmascript-verifier.js", async (original) =>
  (await import("./gate-harness.js")).lemmaScriptMock(original));
vi.mock("../src/model-check.js", async (original) =>
  (await import("./gate-harness.js")).modelCheckMock(original));

useGateHarness();

it("the export still catches content edited after a passing settled receipt (#617)", async () => {
  const root = repository({ "package.json": JSON.stringify({ packageManager: "bun@1.3.11", scripts: { check: "node -e \"process.exit(0)\"" } }),
    "value.js": "1\n" });
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(root, { "value.js": "2\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.tests[0]?.evidence.outcome).toBe("passed");
  commit(root, "checked change");
  expect(await subjectOf(root, receipt, "session", "operator")).toMatchObject({ stale: [], changedAfter: [] });
  write(root, { "value.js": "999\n" });
  commit(root, "later edit");
  expect(await subjectOf(root, receipt, "session", "operator")).toMatchObject({ stale: ["bun run check"], changedAfter: ["value.js"] });
});

it("asking a question alone cannot change project files, while unknown tools remain eligible", () => {
  expect(toolMayChangeFiles("ask_user", true, false)).toBe(false);
  expect(toolMayChangeFiles("ask_user", false, false)).toBe(true);
  expect(toolMayChangeFiles("update_tasks", false, false)).toBe(false);
  expect(toolMayChangeFiles("unknown_tool", false, false)).toBe(true);
  expect(toolMayChangeFiles("agent", false, true)).toBe(false);
});

it.each([false, true])("verifies clarifications and amendments in their journal order (answer first: %s)", async (answerFirst) => {
  const root = project();
  const commit = await headCommit(root);
  const clarification: Clarification = { reply: 0, callId: "ask", at: "2026-10-20T00:00:00.000Z",
    questions: [{ question: "Which behavior?", options: [
      { label: "A", description: "Use behavior A." }, { label: "B", description: "Use behavior B." },
    ] }], answers: [{ selected: [0], text: "Explain before implementing." }] };
  const amendment = { kind: "amendment", origin: "interactive", text: "Use behavior B instead." } as const;
  const answer = { kind: "clarification", clarification } as const;
  const inputs: RequestInput[] = answerFirst ? [answer, amendment] : [amendment, answer];
  inputs.push({ kind: "amendment", origin: "extension", text: "Not operator input." });
  const prompts: string[] = [];
  const run = gate(root, undefined, { flags: { "open-cases-model": "test/lister" }, modelRegistry: {
    find: () => ({ provider: "test", id: "lister", contextWindow: 128_000, maxTokens: 4096 }), complete: (_model: unknown, context: { messages: { content: { text: string }[] }[] }) => {
      prompts.push(context.messages[0]?.content[0]?.text ?? "");
      return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "result", name: "record_open_cases", arguments: { status: "listed", cases: [] } }] });
    },
  } }, () => ({ text: "Choose the behavior.", at: clarification.at, inputs,
    base: { units: [{ folder: "", kind: "commit", commit }], checks: [{ folder: "", projects: suggestChecks(root) }] } }));
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "# Changed\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.requestContext.clarifications).toEqual([clarification]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Operator selected: A — Use behavior A.");
  expect(prompts[0]).not.toContain("Not operator input.");
  const answerAt = prompts[0]?.indexOf("Explain before implementing.") ?? -1;
  const amendmentAt = prompts[0]?.indexOf("Use behavior B instead.") ?? -1;
  expect(answerAt >= 0 && amendmentAt >= 0).toBe(true);
  expect(answerFirst ? answerAt < amendmentAt : amendmentAt < answerAt).toBe(true);
});

it.each(["tui", "print"])("settles a %s request as unchanged, without verification, when no tool or only readers started (#536)", async (mode) => {
  const root = repository({ "src/rule.ts": contract, "bun.lock": "",
    "package.json": JSON.stringify({ scripts: { check: "node -e \"require('node:fs').writeFileSync('.git/check-ran','ran')\"" } }) });
  const find = vi.fn(() => ({ provider: "openai", id: "gpt-6-sol" }));
  const run = gate(root, undefined, { mode, modelRegistry: { find }, flags: { "open-cases-model": undefined } });
  run.progress.ready("proofs_and_tests");
  await run.input("interactive", undefined, "hi");
  write(root, { "src/rule.ts": `${contract}// external change\n` });
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  const gitCalls = vi.spyOn(await import("../src/git.js"), "git");
  const diffCalls = vi.spyOn(await import("../src/git.js"), "gitOutput");
  try {
    expect(await run.settle()).toBeUndefined();
    for (const reader of ["read", "grep", "find", "ls"]) await run.tool(reader);
    expect(await run.settle()).toBeUndefined();
    expect(gitCalls).not.toHaveBeenCalled();
    expect(diffCalls).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".git", "check-ran"))).toBe(false);
    expect(run.progress.status).toEqual({ step: "unchanged" });
    expect(run.steps.map(({ step }) => step)).toEqual(["ready", "waiting", "unchanged", "unchanged"]);
  } finally { gitCalls.mockRestore(); diffCalls.mockRestore(); }
});

it("never verifies, in a read-only session, the edits a parent makes in the folder it shares (#585)", async () => {
  const root = repository({ "src/rule.ts": contract, "bun.lock": "",
    "package.json": JSON.stringify({ scripts: { check: "node -e \"require('node:fs').writeFileSync('.git/check-ran','ran')\"" } }) });
  const run = gate(root, undefined, { mode: "print", flags: { "open-cases-model": undefined } });
  await run.input("interactive", undefined, "review the change");
  // The reviewer delegates to readers of its own, while its parent edits the folder they share.
  await run.tool("agent", true);
  await run.tool("grep", true);
  write(root, { "src/rule.ts": `${contract}// the parent's half-finished edit\n` });
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  expect(await run.settle()).toBeUndefined();
  expect(existsSync(join(root, ".git", "check-ran"))).toBe(false);
});

it.each(["prove", "bash", "powershell", "mcp__files__write", "unknown", "extension-tool", "agent"])(
  "verifies changed files after %s starts, even if the call never succeeds", async (name) => {
    const root = project();
    const run = gate(root);
    await run.input();
    await run.tool(name);
    write(root, { "notes.md": "changed\n" });
    expect((entry(await run.settle()).details as Receipt).changed).toMatchObject([{ path: "notes.md" }]);
    expect(entry(await run.settle("aborted")).details).toMatchObject({ stopped: expect.any(String), codeEvidence: { proofs: [], tests: [] } });
  });

it.each(["steer", "followUp"])("keeps eligibility and send-back history through a %s and repeated settlements", async (behavior) => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/rule.ts": `${contract}// changed\n` });
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect((await run.settle())?.continue).toBe(true);
  await run.input("interactive", behavior, "also keep the change");
  run.agentStart();
  expect((entry(await run.settle()).details as Receipt).codeEvidence.proofs).toMatchObject([{ verdict: "no_progress" }]);
  scripted.delete("src/rule.ts");
  expect((entry(await run.settle()).details as Receipt).codeEvidence.proofs).toMatchObject([{ verdict: "proved" }]);
});

it.each(["interactive", "extension"])("starts a new %s request ineligible after an editing request", async (source) => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "changed\n" });
  expect(entry(await run.settle()).customType).toBe("tesota-receipt");
  await run.input(source, undefined, "hi");
  expect(await run.settle()).toBeUndefined();
  expect(run.progress.status.step).toBe("unchanged");
});

it("publishes each step for the footer: waiting, proving, sent back, testing, measuring, settled, and waiting on the next request", async () => {
  const root = project();
  const run = gate(root);
  run.progress.ready("proofs_only");
  await run.input();
  await run.tool("write");
  expect(run.progress.status).toEqual({ step: "waiting", readiness: "proofs_only" });
  writeFileSync(join(root, "src", "rule.ts"), contract.replace("return 0;", "return 1;"));
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  run.steps.length = 0;
  await run.settle();
  expect(run.steps).toEqual([{ step: "proving", path: "src/rule.ts", startedAt: expect.any(Number), tally: { proved: 0, notProved: 0 } },
    { step: "sent_back", tally: { proved: 0, notProved: 1 } }]);
  scripted.delete("src/rule.ts");
  run.steps.length = 0;
  const began = performance.now();
  const receipt = entry(await run.settle()).details as Receipt;
  const ended = performance.now();
  expect(run.steps.map(({ step }) => step)).toEqual(["proving", "testing", "measuring", "settled"]);
  for (const status of run.steps) {
    if ("startedAt" in status) {
      expect(status.startedAt).toBeGreaterThanOrEqual(began);
      expect(status.startedAt).toBeLessThanOrEqual(ended);
    }
  }
  expect(run.steps[2]).toEqual({ step: "measuring", startedAt: expect.any(Number), tally: { proved: 1, notProved: 0 } });
  expect(run.progress.status).toEqual({ step: "settled", receipt });
  await run.input();
  expect(run.progress.status).toEqual({ step: "waiting", readiness: "proofs_only" });
});

it("leaves a receipt verifying nothing when a run is stopped after a write starts", async () => {
  const root = project();
  const run = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 } });
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), contract.replace("return 0;", "return 1;"));
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  const settled = await run.settle("aborted");
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).customType).toBe("tesota-receipt");
  const receipt = entry(settled).details as Receipt;
  const blob = spawnSync("git", ["hash-object", "src/rule.ts"], { cwd: root, encoding: "utf8" }).stdout.trim();
  expect(receipt).toMatchObject({ version: 3, repository: true, base: await headCommit(root), engine: expect.stringMatching(/^0\.1\.0\+(?:[0-9a-f]{7,40}(?:\.dirty)?|unknown)$/), model: "provider/model", stopped: "the operator stopped the run before Tesota verified it", changed: [{ path: "src/rule.ts", blob }], codeEvidence: { proofs: [], tests: [], exercises: [], unverified: [], uncovered: [] }, specificationEvidence: { contracts: [], weakened: [] } });
  expect(receipt.requestReview.contractComparison.runs[0]).toBeUndefined();
  expect(receipt.requestReview.openCases).toMatchObject({ status: "not_run" });
  expect(Date.parse(receipt.settledAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
  expect(run.progress.status).toEqual({ step: "settled", receipt });
  expect(run.steps.map(({ step }) => step)).toEqual(["waiting", "settled"]);
});

it.each([
  ["the engine's reason", "quota exhausted", "quota exhausted"],
  ["its own reason when the host gives none", undefined, "the run failed before Tesota verified it"],
])("records why a run failed after a write starts: %s", async (_case, reason, stopped) => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  const settled = await run.settle("error", reason);
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).details).toMatchObject({ stopped, repository: true, base: await headCommit(root), codeEvidence: { proofs: [], tests: [] } });
});

it("says what changed could not be read when a stopped run's capture fails, never an empty inventory", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "# Changed\n" });
  renameSync(join(root, ".git"), join(root, ".git-gone"));
  const receipt = entry(await run.settle("aborted")).details as Receipt;
  expect(receipt).toMatchObject({ stopped: "the operator stopped the run before Tesota verified it", changed: "unreadable",
    reason: expect.stringContaining("Git could not") });
  expect(receiptStanding(receipt)).toBe("incomplete");
  expect(renderReceipt(receipt)).toContain("Git could not");
});
it("leaves no receipt when an aborted run only started a read", async () => {
  const run = gate(project());
  await run.input();
  // While the agent works, the footer says the gate waits for it, not that it is ready.
  expect(run.progress.status).toEqual({ step: "waiting", readiness: "nothing" });
  await run.tool("read");
  expect(await run.settle("aborted")).toBeUndefined();
  expect(run.progress.status).toEqual({ step: "ready", readiness: "nothing" });
});

it("keeps unknown bases unknown when a stopped write had no request input", async () => {
  const run = gate(folder());
  await run.tool("write");
  expect(entry(await run.settle("aborted")).details).toMatchObject({ repository: false, base: null, stopped: "the operator stopped the run before Tesota verified it", codeEvidence: { proofs: [], tests: [] } });
});

it("clears a running footer operation when the run is aborted or fails", async () => {
  const run = gate(project());
  run.progress.ready("proofs_only");
  for (const outcome of ["aborted", "error"]) {
    run.progress.publish({ step: "proving", path: "src/rule.ts", startedAt: performance.now(), tally: { proved: 0, notProved: 0 } });
    expect(await run.settle(outcome)).toBeUndefined();
    expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_only" });
  }
});

it("shows a resumed session's receipt again, unless the operator spoke after it", () => {
  const progress = new GateProgress();
  progress.ready("proofs_and_tests");
  const receipt = { ...emptyReceipt,
      codeEvidence: { ...emptyReceipt.codeEvidence, proofs: [] }
};
  const user = { type: "message", message: { role: "user", content: "a request", timestamp: 0 } };
  const settled = { type: "custom_message", customType: "tesota-receipt", content: "Tesota receipt", display: true, details: receipt };
  const gate = { type: "custom_message", customType: "tesota-gate", content: "sent back", display: true };
  progress.resume([user, gate, settled] as never);
  expect(progress.status).toEqual({ step: "settled", receipt });
  progress.reset();
  progress.resume([user, settled, user] as never);
  expect(progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
  progress.resume([user, gate] as never);
  expect(progress.status.step).toBe("ready");
  progress.resume([user, { ...settled, details: { version: 0 } }] as never);
  expect(progress.status.step).toBe("ready");
  progress.resume([user, { type: "custom", customType: "tesota-receipt", data: receipt }] as never);
  expect(progress.status).toEqual({ step: "settled", receipt });
});

it("settles a print-mode run with the receipt outside the conversation, so Pi prints the final answer (#427)", async () => {
  const root = repository({ "notes.md": "# Notes\n" });
  const printRun = gate(root, undefined, { mode: "print" });
  await printRun.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  const printed = (await printRun.settle())?.entries ?? [];
  expect(printed).toMatchObject([{ type: "custom", customType: "tesota-receipt", data: { version: 3 } }]);
  const tuiRun = gate(root, undefined, { mode: "tui" });
  await tuiRun.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes, changed again\n");
  const shown = (await tuiRun.settle())?.entries ?? [];
  expect(shown).toMatchObject([{ type: "custom_message", customType: "tesota-receipt", display: true, details: { version: 3 } }]);
});

it("goes back to ready when the gate fails midway, and settles unchanged when the run changed nothing (#536)", async () => {
  const root = project();
  const run = gate(root);
  run.progress.ready("proofs_and_tests");
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  await expect(run.settle()).rejects.toThrow("the prover broke");
  expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  await run.settle();
  expect(run.progress.status.step).toBe("sent_back");
  writeFileSync(join(root, "src", "rule.ts"), contract);
  expect(await run.settle()).toBeUndefined();
  expect(run.progress.status).toEqual({ step: "unchanged" });
});

it("records the blob of every file the run left changed, and a deleted one as null", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "new.md"), "# New\n");
  rmSync(join(root, "notes.md"));
  const blob = spawnSync("git", ["hash-object", "src/new.md"], { cwd: root, encoding: "utf8" }).stdout.trim();
  expect((entry(await run.settle()).details as Receipt).changed).toEqual([{ path: "notes.md", blob: null },
    { path: "src/new.md", blob }]);
});

it("serializes each judge's actual request selection and capacity omissions (#627)", async () => {
  const root = project();
  const commit = await headCommit(root);
  const earlier = Array.from({ length: 99 }, (_, index) => ({ run: index + 1, text: `Requirement ${index + 1}: ${"x".repeat(20_000)}`, inputs: [] }));
  const asked: string[] = [];
  const model = { provider: "test", id: "judge", contextWindow: 12_000, maxTokens: 256 };
  const complete = (_model: unknown, context: { messages: { content: { text: string }[] }[]; tools: { name: string }[] }): Promise<unknown> => {
    asked.push(context.messages[0]?.content[0]?.text ?? "");
    const name = context.tools[0]?.name;
    const arguments_ = name === "record_open_cases" ? { status: "listed", cases: [] }
      : name === "record_comparisons" ? { comparisons: [{ function: 1, verdict: "no_mismatch_identified", explanation: "as asked" }] }
        : { informalizations: [{ function: 1, preconditions: "none", postcondition: "non-negative", strength: "strong" }] };
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name, arguments: arguments_ }] });
  };
  const run = gate(root, undefined, { model, modelRegistry: { complete, find: () => ({ ...model, id: "lister", contextWindow: 7000 }) },
    flags: { "open-cases-model": "test/lister" } }, () => ({ run: 100, text: "continue", at: "2026-10-26T00:00:00Z", inputs: [],
    unverifiedRequests: earlier, base: { units: [{ folder: "", kind: "commit", commit }], checks: [{ folder: "", projects: suggestChecks(root) }] } }));
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src/rule.ts"), "//@ ensures \\result >= 0 && \\result <= 1\nexport function f(): number { return 0; }\n");
  const receipt = JSON.parse(JSON.stringify(entry(await run.settle()).details)) as Receipt;
  expect(receipt.requestReview.context?.filter(({ stage }) => stage !== "restatement").map(({ method, requests, omitted }) => [method, requests.map(({ run }) => run), omitted])).toEqual([
    ["claimcheck", [98, 99, 100], Array.from({ length: 97 }, (_, index) => index + 1)],
    ["open_cases", [99, 100], Array.from({ length: 98 }, (_, index) => index + 1)],
  ]);
  expect(asked[1]).toContain("Requirement 98:");
  expect(asked[1]).not.toContain("Requirement 97:");
  expect(asked[2]).toContain("Requirement 99:");
  expect(asked[2]).not.toContain("Requirement 98:");
  expect(renderReceipt(receipt)).toContain("Open cases left out requests 1, 2");
});

it.each(["unknown", "unsigned"])("completes with a receipt when the selected open-cases model is %s (#709 characterization)", async (failure) => {
  const root = project();
  const find = vi.fn((provider: string, id: string) => failure === "unknown" ? undefined
    : { provider, id, contextWindow: 128_000, maxTokens: 4096 });
  const complete = vi.fn(() => Promise.reject(new Error("No sign-in for openai")));
  const run = gate(root, undefined, { modelRegistry: { find, complete }, flags: { "open-cases-model": "openai/gpt-6-sol" } });
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "changed\n" });
  const settled = await run.settle();
  expect(settled?.continue).not.toBe(true);
  expect(find).toHaveBeenCalledWith("openai", "gpt-6-sol");
  const reason = failure === "unknown" ? "openai/gpt-6-sol isn't a model Tesota knows (provider/id)"
    : "openai/gpt-6-sol the model request failed: No sign-in for openai";
  expect((entry(settled).details as Receipt).requestReview.openCases).toMatchObject({ status: "not_run", reason });
  expect(facts(entry(settled).content)).toContain(reason);
});

it("lists open cases with the non-OpenAI session model unless the operator names another (#709)", async () => {
  const asked: { model: string; text: string; system: string }[] = [];
  const complete = (model: { provider: string; id: string }, context: { systemPrompt: string; messages: { content: { text: string }[] }[] }):
    Promise<unknown> => {
    asked.push({ model: `${model.provider}/${model.id}`, text: context.messages[0]?.content[0]?.text ?? "", system: context.systemPrompt });
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "record_open_cases",
      arguments: { status: "listed", cases: [{ input: "lateFee(-1)", outcomes: ["0", "-5"] }] } }] });
  };
  const find = (provider: string, id: string): object => ({ provider, id, contextWindow: 128_000, maxTokens: 4096 });
  for (const [named, model] of [[undefined, "provider/model"], ["other/lister", "other/lister"]] as const) {
    const root = project();
    const run = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 }, modelRegistry: { complete, find },
      flags: { "open-cases-model": named } });
    await run.input("interactive", undefined, "lateFee charges 5 per day late, at most 50");
    await run.tool("write");
    writeFileSync(join(root, "src", "notes.md"), "notes\n");
    const settled = entry(await run.settle());
    expect((settled.details as Receipt).requestReview.openCases).toEqual({ status: "listed", model, cases: [{ input: "lateFee(-1)", outcomes: ["0", "-5"] }] });
    expect(facts(settled.content)).toContain(`  model listed  by ${model}, cases the request may leave open`);
    expect(asked.at(-1)).toMatchObject({ model, system: openCasesSystemPrompt });
    expect(asked.at(-1)?.text).toContain("A person gave a coding agent this request:\n\nlateFee charges 5 per day late, at most 50\n\n");
  }
});

it.each([
  ["other/lister", undefined, "other/lister"],
  ["other/lister", "flag/lister", "flag/lister"],
  ["off", undefined, undefined],
  ["other/lister", "off", undefined],
  ["off", "flag/lister", "flag/lister"],
] as const)("resolves open-cases setting %s and flag %s to %s on every run (#709)", async (setting, flag, expected) => {
  state.verificationModels = setting === undefined ? {} : { openCasesModel: setting };
  const root = project();
  const complete = vi.fn(() => Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1",
    name: "record_open_cases", arguments: { status: "listed", cases: [] } }] }));
  const run = gate(root, undefined, { model: { provider: "nonopenai", id: "session", contextWindow: 128_000, maxTokens: 4096 },
    modelRegistry: { complete, find: (provider: string, id: string) => ({ provider, id, contextWindow: 128_000, maxTokens: 4096 }) },
    flags: { "open-cases-model": flag } });
  for (const text of ["first", "second"]) {
    await run.input();
    await run.tool("write");
    write(root, { "notes.md": text });
    const receipt = entry(await run.settle()).details as Receipt;
    expect(receipt.requestReview.openCases).toEqual(expected === undefined ? { status: "disabled", reason: "the operator disabled open cases" } : { status: "listed", model: expected, cases: [] });
  }
  expect(complete).toHaveBeenCalledTimes(expected === undefined ? 0 : 2);
});

it("reports missing issue contents instead of inventing an open case for the #575 request (#582)", async () => {
  const root = project();
  const reason = "Issue #575 and its comments are not supplied in the request; their requirements cannot be read.";
  const asked: string[] = [];
  const complete = (_model: unknown, context: { messages: { content: { text: string }[] }[] }): Promise<unknown> => {
    asked.push(context.messages[0]?.content[0]?.text ?? "");
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "record_open_cases",
      arguments: { status: "not_listed", reason } }] });
  };
  const run = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 },
    modelRegistry: { complete, find: (provider: string, id: string) => ({ provider, id, contextWindow: 128_000, maxTokens: 4096 }) },
    flags: { "open-cases-model": "openai/gpt-6-sol" } });
  await run.input("interactive", undefined, "Fix issue #575 (read it and its comments with gh issue view 575 --comments).");
  await run.tool("write");
  writeFileSync(join(root, "src", "notes.md"), "The agent's solution must not reach the lister.\n");
  const settled = entry(await run.settle());
  expect((settled.details as Receipt).requestReview.openCases).toMatchObject({ status: "not_run", reason: `openai/gpt-6-sol ${reason}` });
  expect(facts(settled.content)).toContain("  not listed    the cases the request leaves open:");
  expect(settled.content).not.toContain("cases the request may leave open");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("Fix issue #575 (read it and its comments with gh issue view 575 --comments).");
  expect(asked[0]).not.toContain("The agent's solution");
  expect(asked[0]).toContain("Missing reference contents are not an open case");
});

it("leaves the open cases out when the operator turns the list off, and says why when no model lists them", async () => {
  const root = project();
  const off = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 }, modelRegistry: { find: () => undefined } });
  await off.input();
  await off.tool("write");
  writeFileSync(join(root, "src", "notes.md"), "notes\n");
  expect((entry(await off.settle()).details as Receipt).requestReview.openCases).toMatchObject({ status: "disabled" });
  const missing = gate(root, undefined, { model: { provider: "provider", id: "model", contextWindow: 128_000, maxTokens: 4096 }, modelRegistry: { find: () => undefined },
    flags: { "open-cases-model": "nobody/none" } });
  await missing.input();
  await missing.tool("write");
  writeFileSync(join(root, "src", "notes.md"), "more notes\n");
  const settled = entry(await missing.settle());
  expect((settled.details as Receipt).requestReview.openCases).toMatchObject({ status: "not_run", reason: "nobody/none isn't a model Tesota knows (provider/id)" });
  expect(facts(settled.content)).toContain("  not listed    the cases the request leaves open: nobody/none isn't a model Tesota knows (provider/id)");
});

it("leaves out of the receipt's files those whose changed lines are all blank or comments, //@ lines aside", async () => {
  const root = repository({ "src/rule.ts": contract, "notes.md": "# Notes\n", "src/helper.ts": "export const one = 1;\n",
    "src/tool.py": "x = 1\n", "src/legacy.js": "export const two = 2;\n", "logo.bin": "\0\u0001" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/helper.ts": "// One, as a constant.\n\nexport const one = 1;\n", "src/note.ts": "/* Nothing yet.\n * Later.\n */\n",
    "src/tool.py": "# The tool's value.\nx = 1\n", "src/legacy.js": "//@ ensures true\nexport const two = 2;\n",
    "notes.md": "# Notes, changed\n", "logo.bin": "\0\u0002" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.codeEvidence.unverified).toEqual(["logo.bin", "notes.md", "src/legacy.js"]);
  expect(receipt.commentsOnly).toBeUndefined();
});

it("settles a change of comments and blank lines alone with a receipt and footer that say nothing needed verifying", async () => {
  const root = repository({ "src/helper.ts": "export const one = 1;\n", "src/tool.py": "x = 1\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/helper.ts": "// One, as a constant.\n\nexport const one = 1;\n", "src/tool.py": "# The tool's value.\nx = 1\n" });
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe("  no code       nothing to verify: the changes are comments or blank lines only\n  changed lines implementation +3 -0");
  expect((settled.details as Receipt).commentsOnly).toBe(true);
  // Nothing verified it, so the footer does not mark it verified.
  expect(evidenceText(evidenceParts(run.progress.status), "full")).toBe("○ receipt · nothing to verify, comments only");
});

it("settles with a receipt when the only change deletes a test", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  rmSync(join(root, "tests", "old.test.ts"));
  expect(facts(entry(await run.settle()).content)).toBe("  may weaken    tests/old.test.ts: deletes a test file\n  changed lines tests +0 -1");
});

it("says a change too large to read was not checked for weakening, instead of listing nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "x\n".repeat(9 * 1024 * 1024));
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe([
    "  not measured  Unmeasured: notes.md: file exceeds 10 MiB",
    "  not checked   weakened evidence: the change is too large to check for weakening",
    ].join("\n"));
  expect((settled.details as Receipt).specificationEvidence.weakened).toBe("too_large");
}, 60_000);

it("publishes each proof and closes a send-back attempt as returned to the agent, the next as settled (#590)", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), contract.replace(">= 0", ">= 1").replace("return 0;", "return 1;"));
  scripted.set("src/rule.ts", { outcome: "failed", output: "boom" });
  expect((await run.settle())?.continue).toBe(true);
  const ops = run.progress.operations;
  expect(ops.operations()).toMatchObject([{ method: "proof", unit: "", state: "ended", result: "failed", generation: 1,
    target: expect.stringContaining("src/rule.ts") }]);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "returned_to_agent" }]);
  scripted.set("src/rule.ts", { outcome: "passed", output: "1 verified, 0 errors" });
  run.agentStart();
  expect((await run.settle())?.continue).toBeUndefined();
  const second = ops.operations().filter(({ generation }) => generation === 2);
  expect(second.map(({ method, result }) => [method, result])).toEqual([["proof", "passed"], ["mutation", "done"], ["claimcheck", "done"],
    ["receipt", "done"]]);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "returned_to_agent" }, { generation: 2, closedAs: "settled" }]);
  expect(ops.operations().every(({ state }) => state === "ended")).toBe(true);
  expect(ops.line(performance.now())).toBeUndefined();
});
it("publishes the open-case listing, and a model check kept from an earlier check as reused (#590)", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  const run = gate(root, undefined, { flags: { "open-cases-model": "test/lister" }, modelRegistry: {
    find: () => ({ provider: "test", id: "lister", contextWindow: 128_000, maxTokens: 4096 }), complete: () => Promise.resolve({ stopReason: "toolUse",
      content: [{ type: "toolCall", id: "result", name: "record_open_cases", arguments: { status: "listed", cases: [] } }] }) } });
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  await run.settle();
  // The scripted model check publishes nothing of its own, as TLC's runner does.
  expect(shape(run).map(([method]) => method)).toEqual(["open_cases", "receipt"]);
  expect(run.progress.operations.operations().find(({ method }) => method === "open_cases")).toMatchObject({ target: "test/lister", result: "done" });
  run.agentStart();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  await run.settle();
  const reused = run.progress.operations.operations().filter(({ reused: kept }) => kept);
  expect(reused).toMatchObject([{ method: "model_main", target: "models/Counter.tla", result: "passed", durationMs: 0 }]);
});
