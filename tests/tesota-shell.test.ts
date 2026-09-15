import { expect, it, vi } from "vitest";
import { runTesotaShell } from "../src/tesota-shell.js";
import { PROPOSAL_LIMITS } from "../src/task-proposal-contract.js";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import type { TaskStartProgress } from "../src/task-start.js";

const baseline = "a".repeat(40);

function answerResult(message = "The shell is bounded.", observedBaseline = baseline) {
  return { status: "completed" as const, exitCode: 0, turn: { kind: "answer" as const,
    answer: { kind: "answer" as const, message, evidenceFiles: ["src/tesota-shell.ts"], uncertainties: [] },
    baseline: observedBaseline } };
}

function clarificationResult() {
  return { status: "completed" as const, exitCode: 0, turn: { kind: "clarification" as const,
    clarification: { kind: "clarification" as const, question: "Which guide should change?",
      reason: "Two guides match the request." }, baseline } };
}

function proposalResult() {
  const id = "9877887d-1475-4439-a0a6-c1c85091fc9e";
  return { status: "completed" as const, exitCode: 0, turn: { kind: "task_proposal" as const, proposedTask: { directory: "proposal",
    record: { format: "tesota-task-proposal" as const, version: 1 as const, id,
      recordedAt: "2026-09-12T00:00:00.000Z", source: "C:\\work\\tesota", baseline,
      request: "Update the value", authority: "none" as const, provenance: "model_proposed" as const,
      status: "ready" as const, proposal: { objective: "Update the value", completionConditions: ["It is correct"],
        readFiles: ["src/value.ts"], writeFiles: ["src/value.ts"],
        checks: ["scope-integrity" as const, "typescript-no-emit/v1" as const],
        uncertainties: [] }, dirtyPaths: [], dirtyConflicts: [], checks: [{ id: "scope-integrity" as const,
        definition: "application_owned_declarative_only" as const, executable: false as const },
      { id: "typescript-no-emit/v1" as const,
        definition: "application_owned_declarative_only" as const, executable: false as const }],
      discovery: { provider: "test", model: "test", inferenceTransport: "configured_provider" as const,
        modelControlledNetwork: false as const, modelInvocations: 1, toolCalls: 1, operations: 1,
        exposedBytes: 1, limits: PROPOSAL_LIMITS } } } } };
}

it("starts a Tesota-owned conversation and sends the natural-language request to discovery", async () => {
  const output: string[] = [];
  const progress: TesotaShellProgress[] = [];
  const discover = vi.fn(async () => answerResult());
  const answers = ["  Corrige la experiencia del shell.  ", ""];

  const result = await runTesotaShell({
    write: (text) => { output.push(text); },
    ask: async (prompt) => {
      output.push(prompt);
      return answers.shift() ?? "";
    },
    discover,
    start: vi.fn(),
    report: (event) => { progress.push(event); },
  });

  expect(result).toBe(0);
  expect(discover).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledWith({ request: "Corrige la experiencia del shell." });
  expect(output.join("")).toBe(
    "> \n" +
    "The shell is bounded.\nEvidence: src/tesota-shell.ts\nBaseline: " + baseline + "\nAuthority: none; nothing changed.\n" +
    "Read-only turn complete. No execution authority was created.\n" +
    "> Tesota session ended. Nothing changed.\n",
  );
  expect(progress).toEqual([{ phase: "discovering", operation: "repository_discovery" }]);
});

it("ends without inference when the operator enters no request", async () => {
  const output: string[] = [];
  const discover = vi.fn(async () => answerResult());

  const result = await runTesotaShell({
    write: (text) => { output.push(text); },
    ask: async () => "   ",
    discover,
    start: vi.fn(),
  });

  expect(result).toBe(0);
  expect(discover).not.toHaveBeenCalled();
  expect(output.at(-1)).toBe("No request entered. Nothing changed.\n");
});

it("reports a blocked proposal without claiming executable progress", async () => {
  const output: string[] = [];

  const result = await runTesotaShell({
    write: (text) => { output.push(text); },
    ask: async () => "Update the docs",
    discover: async () => ({ ...proposalResult(), exitCode: 1,
      turn: { ...proposalResult().turn, proposedTask: { ...proposalResult().turn.proposedTask,
        record: { ...proposalResult().turn.proposedTask.record, status: "blocked_dirty" as const } } } }),
    start: vi.fn(),
  });

  expect(result).toBe(1);
  expect(output.at(-1)).toBe("Request blocked or unavailable. Nothing changed.\n");
});

it("continues a ready proposal into the approval flow without asking for its id", async () => {
  const output: string[] = [];
  const start = vi.fn(async (_id: string, _report: (progress: TaskStartProgress) => void) => 0);
  const progress: TesotaShellProgress[] = [];
  const result = await runTesotaShell({ write: (text) => output.push(text),
    ask: async () => "Update the guide", discover: async () => proposalResult(), start: async (id, report) => {
      report({ phase: "executing", operation: "candidate_task" });
      return start(id, report);
    }, report: (event) => { progress.push(event); } });
  expect(result).toBe(0);
  expect(start).toHaveBeenCalledWith("9877887d-1475-4439-a0a6-c1c85091fc9e", expect.any(Function));
  expect(progress).toContainEqual({ phase: "executing", operation: "candidate_task" });
  expect(output.join("")).toContain("Proposal ready. Execution still requires your approval.\n");
});

it("continues one clarification in the same shell session without granting authority", async () => {
  const output: string[] = [];
  const answers = ["Update the guide", "docs/guide.md"];
  const discover = vi.fn()
    .mockResolvedValueOnce(clarificationResult())
    .mockResolvedValueOnce(answerResult("The requested guide is already clear."));

  const progress: TesotaShellProgress[] = [];
  const result = await runTesotaShell({ write: (text) => output.push(text),
    ask: async () => answers.shift() ?? "", discover, start: vi.fn(), report: (event) => { progress.push(event); } });

  expect(result).toBe(0);
  expect(discover).toHaveBeenNthCalledWith(1, { request: "Update the guide" });
  expect(discover).toHaveBeenNthCalledWith(2, { request: "Update the guide", clarification: {
    question: "Which guide should change?", answer: "docs/guide.md", baseline } });
  expect(progress).toContainEqual({ phase: "awaiting_clarification", operation: "operator_answer" });
  expect(output.join("")).toContain("The requested guide is already clear.");
});

it("stops after an unanswered clarification without starting work", async () => {
  const output: string[] = [];
  const answers = ["Update the guide", "   "];
  const start = vi.fn();
  const result = await runTesotaShell({ write: (text) => output.push(text),
    ask: async () => answers.shift() ?? "", discover: async () => clarificationResult(), start });
  expect(result).toBe(0);
  expect(start).not.toHaveBeenCalled();
  expect(output.at(-1)).toBe("Clarification cancelled. Nothing changed.\n");
});

it("invalidates a clarification continuation when the committed baseline changes", async () => {
  const output: string[] = [];
  const answers = ["Update the guide", "docs/guide.md"];
  const discover = vi.fn()
    .mockResolvedValueOnce(clarificationResult())
    .mockResolvedValueOnce({ status: "unavailable" as const, exitCode: 1,
      reason: "baseline_changed" as const });
  const result = await runTesotaShell({ write: (text) => output.push(text),
    ask: async () => answers.shift() ?? "", discover, start: vi.fn() });
  expect(result).toBe(1);
  expect(output.at(-1)).toBe("The committed baseline changed during clarification. Start a new request. Nothing changed.\n");
});
