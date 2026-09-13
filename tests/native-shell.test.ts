import { expect, it, vi } from "vitest";
import { askNativeShellRequest, runNativeShell } from "../src/native-shell.js";
import { PROPOSAL_LIMITS } from "../src/task-proposal-contract.js";
import type { TaskStartProgress } from "../src/task-start.js";

const baseline = "a".repeat(40);

function answerResult(message = "The shell is bounded.", observedBaseline = baseline) {
  return { exitCode: 0, turn: { kind: "answer" as const,
    answer: { kind: "answer" as const, message, evidenceFiles: ["src/native-shell.ts"], uncertainties: [] },
    baseline: observedBaseline } };
}

function clarificationResult() {
  return { exitCode: 0, turn: { kind: "clarification" as const,
    clarification: { kind: "clarification" as const, question: "Which guide should change?",
      reason: "Two guides match the request." }, baseline } };
}

function proposalResult() {
  const id = "9877887d-1475-4439-a0a6-c1c85091fc9e";
  return { exitCode: 0, turn: { kind: "task_proposal" as const, proposedTask: { directory: "proposal",
    record: { format: "tesota-task-proposal" as const, version: 1 as const, id,
      recordedAt: "2026-09-12T00:00:00.000Z", source: "C:\\work\\tesota", baseline,
      request: "Update the guide", authority: "none" as const, provenance: "model_proposed" as const,
      status: "ready" as const, proposal: { objective: "Update the guide", completionConditions: ["It is clear"],
        readFiles: ["docs/guide.md"], writeFiles: ["docs/guide.md"], checks: ["repository-check" as const],
        uncertainties: [] }, dirtyPaths: [], dirtyConflicts: [], checks: [{ id: "repository-check" as const,
        definition: "application_owned_declarative_only" as const, executable: false as const }],
      discovery: { provider: "test", model: "test", inferenceTransport: "configured_provider" as const,
        modelControlledNetwork: false as const, modelInvocations: 1, toolCalls: 1, operations: 1,
        exposedBytes: 1, limits: PROPOSAL_LIMITS } } } } };
}

it("starts a Tesota-owned conversation and sends the natural-language request to discovery", async () => {
  const output: string[] = [];
  const discover = vi.fn(async () => answerResult());
  const answers = ["  Corrige la experiencia del shell.  ", ""];

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async (prompt) => {
      output.push(prompt);
      return answers.shift() ?? "";
    },
    discover,
    start: vi.fn(),
    now: () => 1_000,
  });

  expect(result).toBe(0);
  expect(discover).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledWith({ request: "Corrige la experiencia del shell." });
  expect(output.join("")).toBe(
    "Tesota\n" +
    "Repository: C:\\work\\tesota\n" +
    "Ask about the repository or describe a change. File names are optional.\n\n" +
    "> \n" +
    "[discovering] Inspecting the committed repository (0s)\n" +
    "The shell is bounded.\nEvidence: src/native-shell.ts\nBaseline: " + baseline + "\nAuthority: none; nothing changed.\n" +
    "Read-only turn complete. No execution authority was created.\n" +
    "> Tesota session ended. Nothing changed.\n",
  );
});

it("ends without inference when the operator enters no request", async () => {
  const output: string[] = [];
  const discover = vi.fn(async () => answerResult());

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
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

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
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
  const result = await runNativeShell({ cwd: "C:\\work\\tesota", write: (text) => output.push(text),
    ask: async () => "Update the guide", discover: async () => proposalResult(), start: async (id, report) => {
      report({ phase: "executing", operation: "candidate_task" });
      return start(id, report);
    } });
  expect(result).toBe(0);
  expect(start).toHaveBeenCalledWith("9877887d-1475-4439-a0a6-c1c85091fc9e", expect.any(Function));
  expect(output.join("")).toContain("[executing] Running the isolated candidate task");
  expect(output.join("")).toContain("Proposal ready. Execution still requires your approval.\n");
});

it("continues one clarification in the same shell session without granting authority", async () => {
  const output: string[] = [];
  const answers = ["Update the guide", "docs/guide.md"];
  const discover = vi.fn()
    .mockResolvedValueOnce(clarificationResult())
    .mockResolvedValueOnce(answerResult("The requested guide is already clear."));

  const result = await runNativeShell({ cwd: "C:\\work\\tesota", write: (text) => output.push(text),
    ask: async () => answers.shift() ?? "", discover, start: vi.fn() });

  expect(result).toBe(0);
  expect(discover).toHaveBeenNthCalledWith(1, { request: "Update the guide" });
  expect(discover).toHaveBeenNthCalledWith(2, { request: "Update the guide", clarification: {
    question: "Which guide should change?", answer: "docs/guide.md" } });
  expect(output.join("")).toContain("[awaiting_clarification] Waiting for your answer");
  expect(output.join("")).toContain("The requested guide is already clear.");
});

it("stops after an unanswered clarification without starting work", async () => {
  const output: string[] = [];
  const answers = ["Update the guide", "   "];
  const start = vi.fn();
  const result = await runNativeShell({ cwd: "C:\\work\\tesota", write: (text) => output.push(text),
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
    .mockResolvedValueOnce(answerResult("Changed baseline answer", "b".repeat(40)));
  const result = await runNativeShell({ cwd: "C:\\work\\tesota", write: (text) => output.push(text),
    ask: async () => answers.shift() ?? "", discover, start: vi.fn() });
  expect(result).toBe(1);
  expect(output.at(-1)).toBe("The committed baseline changed during clarification. Start a new request. Nothing changed.\n");
});

it("releases readline before discovery so process interruption reaches the proposal owner", async () => {
  const events: string[] = [];
  const terminal = {
    question: vi.fn(async (_prompt: string, _options?: { readonly signal?: AbortSignal }) => {
      events.push("question");
      return "Update the docs";
    }),
    once: vi.fn((_event: "SIGINT", _listener: () => void) => terminal),
    removeListener: vi.fn((_event: "SIGINT", _listener: () => void) => terminal),
    close: vi.fn(() => { events.push("close"); }),
  };

  await expect(askNativeShellRequest(terminal, "> ")).resolves.toBe("Update the docs");
  expect(events).toEqual(["question", "close"]);
  expect(terminal.removeListener).toHaveBeenCalledOnce();
});

it("aborts and closes the pending question when readline receives Ctrl+C", async () => {
  let interrupt: (() => void) | undefined;
  const terminal = {
    question: vi.fn(async (_prompt: string, options?: { readonly signal?: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      })),
    once: vi.fn((_event: "SIGINT", listener: () => void) => { interrupt = listener; return terminal; }),
    removeListener: vi.fn((_event: "SIGINT", _listener: () => void) => terminal),
    close: vi.fn(),
  };

  const pending = askNativeShellRequest(terminal, "> ");
  expect(interrupt).toBeDefined();
  interrupt?.();

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(terminal.close).toHaveBeenCalledOnce();
});
