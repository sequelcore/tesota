import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type CandidateTask, type CandidateTaskCheck, type CandidateTaskDescription } from "../src/candidate-task.js";
import { createPiTaskBudget, PI_TASK_LIMITS, runPiTask } from "../src/integrations/pi-task.js";
import { taskRequestSchemas } from "../src/task-contract.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const description: CandidateTaskDescription = {
  task: "typescript-change", baseline: "a".repeat(40), definitionSha256: "b".repeat(64),
  objective: "Change the value.", completionConditions: ["The new value is exported."], instructions: "Change only admitted files.",
  readFiles: ["src/value.ts"], writeFiles: ["src/value.ts"], checks: ["scope-integrity", "typescript-no-emit/v1"],
  outcome: "human_review_required", limits: { reads: 8, edits: 2, checks: 3, fileBytes: 64 * 1024 },
};

function check(outcome: CandidateTaskCheck["outcome"], settlement: CandidateTaskCheck["settlement"]): CandidateTaskCheck {
  return {
    task: "typescript-change", status: outcome === "passed" ? "passed" : "check_failed", outcome, settlement,
    provenance: "issued", diagnostics: [outcome === "operational_failed" ? "TypeScript no-emit did not complete." : "Check result."],
    typecheck: outcome === "check_failed" ? null : {
      profile: "typescript-no-emit/v1", status: "timed_out", reason: "timeout", diagnostics: [], process: "unconfirmed",
      container: "absent", binding: {} as never, authority: "none", provenance: "issued",
    }, baseline: "a".repeat(40), writeSetSha256: outcome === "check_failed" ? "1".repeat(64) : "2".repeat(64),
    taskAcceptance: "not_evaluated", sourceInputsSha256: "d".repeat(64),
  };
}

function budgetTask(cause: "initial_implementation" | "semantic_revision") {
  return {
    describe: () => ({ ...description, executionCause: cause }),
    requestSchemas: () => taskRequestSchemas(["src/value.ts"], ["src/value.ts"]),
    read: vi.fn(async () => ({ content: "old", sha256: sha256("old") })),
    replace: vi.fn(async () => {}), check: vi.fn(async () => check("check_failed", "observed")),
    usage: vi.fn(() => ({ reads: 0, edits: 0, checks: 0 })), close: vi.fn(),
  } as unknown as CandidateTask;
}

it("shares exact model and tool ceilings across real disposable Pi agents", async () => {
  const modelBudget = createPiTaskBudget();
  modelBudget.modelInvocations = PI_TASK_LIMITS.modelInvocations - 1;
  modelBudget.toolCalls = PI_TASK_LIMITS.toolCalls - 1;
  const r0Task = budgetTask("initial_implementation");
  const r0Provider = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  r0Provider.setResponses([fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" }))]);
  let r0ProviderCalls = 0;
  await runPiTask(r0Task, r0Provider.getModel(), (...args) => {
    r0ProviderCalls += 1;
    return r0Provider.provider.streamSimple(...args);
  }, new AbortController().signal, modelBudget);
  expect(modelBudget).toMatchObject({ modelInvocations: PI_TASK_LIMITS.modelInvocations,
    toolCalls: PI_TASK_LIMITS.toolCalls });
  expect(r0ProviderCalls).toBe(1);
  expect(r0Task.read).toHaveBeenCalledOnce();

  const r1Task = budgetTask("semantic_revision");
  const r1Provider = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  r1Provider.setResponses([fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" }))]);
  let r1ProviderCalls = 0;
  const modelDenied = await runPiTask(r1Task, r1Provider.getModel(), (...args) => {
    r1ProviderCalls += 1;
    return r1Provider.provider.streamSimple(...args);
  }, new AbortController().signal, modelBudget);
  expect(modelDenied).toMatchObject({ denied: true, denialStage: "model_admission",
    modelInvocations: PI_TASK_LIMITS.modelInvocations, toolCalls: PI_TASK_LIMITS.toolCalls });
  expect(r1ProviderCalls).toBe(0);
  expect(r1Task.read).not.toHaveBeenCalled();

  const toolBudget = createPiTaskBudget();
  toolBudget.toolCalls = PI_TASK_LIMITS.toolCalls - 1;
  const firstToolTask = budgetTask("initial_implementation");
  const firstToolProvider = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  firstToolProvider.setResponses([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" })), fauxAssistantMessage("done"),
  ]);
  await runPiTask(firstToolTask, firstToolProvider.getModel(), firstToolProvider.provider.streamSimple,
    new AbortController().signal, toolBudget);
  expect(toolBudget.toolCalls).toBe(PI_TASK_LIMITS.toolCalls);
  expect(firstToolTask.read).toHaveBeenCalledOnce();

  const nextToolTask = budgetTask("semantic_revision");
  const nextToolProvider = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  nextToolProvider.setResponses([fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" }))]);
  await runPiTask(nextToolTask, nextToolProvider.getModel(), nextToolProvider.provider.streamSimple,
    new AbortController().signal, toolBudget);
  expect(toolBudget.toolCalls).toBe(PI_TASK_LIMITS.toolCalls + 1);
  expect(nextToolTask.read).not.toHaveBeenCalled();
});

it("preserves an unconfirmed check effect and blocks a later task check", async () => {
  const oldContent = "export const value = 'old';\n";
  const checks = [check("check_failed", "observed"), check("operational_failed", "unconfirmed")];
  const task = {
    describe: () => description,
    requestSchemas: () => taskRequestSchemas(["src/value.ts"], ["src/value.ts"]),
    read: vi.fn(async () => ({ content: oldContent, sha256: sha256(oldContent) })),
    replace: vi.fn(async () => {}),
    check: vi.fn(async () => {
      const next = checks.shift();
      if (next === undefined) throw new Error("Unexpected later check");
      return next;
    }),
    close: vi.fn(),
  } as unknown as CandidateTask;
  const faux = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tesota_read", { path: "src/value.ts" })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage(fauxToolCall("tesota_replace", {
      path: "src/value.ts", expectedSha256: sha256(oldContent), content: "export const value = 'new';\n",
    })),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
    fauxAssistantMessage(fauxToolCall("tesota_check", {})),
  ]);

  const result = await runPiTask(task, faux.getModel(), faux.provider.streamSimple, new AbortController().signal);

  expect(result).toMatchObject({ status: "unsettled", settlement: "unconfirmed" });
  expect(task.check).toHaveBeenCalledTimes(2);
  expect(task.close).toHaveBeenCalled();
});

it("reports an active check as unconfirmed when cancellation cannot observe its settlement", async () => {
  const task = {
    describe: () => description,
    requestSchemas: () => taskRequestSchemas(["src/value.ts"], ["src/value.ts"]),
    read: vi.fn(),
    replace: vi.fn(),
    check: vi.fn(async () => await new Promise<CandidateTaskCheck>((_resolve) => undefined)),
    close: vi.fn(),
  } as unknown as CandidateTask;
  const faux = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("tesota_check", {}))]);
  const cancellation = new AbortController();

  const running = runPiTask(task, faux.getModel(), faux.provider.streamSimple, cancellation.signal);
  await vi.waitFor(() => expect(task.check).toHaveBeenCalledOnce());
  cancellation.abort();

  await expect(running).resolves.toMatchObject({ status: "unsettled", settlement: "unconfirmed",
    modelInvocations: 1, toolCalls: 1 });
  expect(task.close).toHaveBeenCalled();
}, 10_000);

it.each(["tesota_read", "tesota_replace"] as const)("reports an active %s effect as unconfirmed", async (tool) => {
  const never = async (): Promise<never> => await new Promise<never>((_resolve) => undefined);
  const task = {
    describe: () => description,
    requestSchemas: () => taskRequestSchemas(["src/value.ts"], ["src/value.ts"]),
    read: vi.fn(never),
    replace: vi.fn(never),
    check: vi.fn(),
    close: vi.fn(),
  } as unknown as CandidateTask;
  const faux = fauxProvider({ models: [{ id: "offline", name: "Offline" }] });
  faux.setResponses([fauxAssistantMessage(tool === "tesota_read"
    ? fauxToolCall(tool, { path: "src/value.ts" })
    : fauxToolCall(tool, { path: "src/value.ts", expectedSha256: "a".repeat(64), content: "new" }))]);
  const cancellation = new AbortController();

  const running = runPiTask(task, faux.getModel(), faux.provider.streamSimple, cancellation.signal);
  await vi.waitFor(() => expect(tool === "tesota_read" ? task.read : task.replace).toHaveBeenCalledOnce());
  cancellation.abort();

  await expect(running).resolves.toMatchObject({ status: "unsettled", settlement: "unconfirmed",
    modelInvocations: 1, toolCalls: 1 });
  expect(task.close).toHaveBeenCalledWith(true);
}, 10_000);
