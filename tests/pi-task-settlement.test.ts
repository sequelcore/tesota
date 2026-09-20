import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type CandidateTask, type CandidateTaskCheck, type CandidateTaskDescription } from "../src/candidate-task.js";
import { runPiTask } from "../src/integrations/pi-task.js";
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

  await expect(running).resolves.toMatchObject({ status: "unsettled", settlement: "unconfirmed" });
  expect(task.close).toHaveBeenCalled();
}, 10_000);
