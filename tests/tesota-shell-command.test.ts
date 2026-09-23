import { expect, it, vi } from "vitest";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import { runTesotaShellCommand } from "../src/tesota-shell-command.js";
import type { TesotaShellTerminal } from "../src/tesota-shell-terminal.js";
import { PROPOSAL_LIMITS } from "../src/task-proposal-contract.js";

function fakeSurface(ask: (prompt: string) => Promise<string>) {
  const events: string[] = [];
  const progress: TesotaShellProgress[] = [];
  const surface: TesotaShellTerminal = {
    start: () => { events.push("start"); },
    stop: () => { events.push("stop"); },
    write: (text) => { events.push(text); },
    ask,
    report: (event) => { progress.push(event); },
    refreshElapsed: () => {},
    inspect: () => {},
    addSession: () => {},
    selectSession: () => {},
    writeTo: () => {},
    askIn: ask,
    reportFor: () => {},
    inspectFor: () => {},
    recoverFor: () => {},
    blockSession: () => {},
  };
  return { surface, events, progress };
}

it("owns the persistent surface for the complete shell session", async () => {
  const fixture = fakeSurface(async () => "");
  const discover = vi.fn();

  await expect(runTesotaShellCommand({ surface: fixture.surface, discover, start: vi.fn() })).resolves.toBe(0);

  expect(fixture.events).toEqual(["start", "No request entered. Nothing changed.\n", "stop"]);
  expect(discover).not.toHaveBeenCalled();
});

it("reports discovery through the surface instead of adding progress to the transcript", async () => {
  const answers = ["What is Tesota?", ""];
  const fixture = fakeSurface(async () => answers.shift() ?? "");
  const discover = vi.fn(async () => ({ status: "completed" as const, exitCode: 0, turn: {
    kind: "answer" as const,
    answer: { kind: "answer" as const, message: "A bounded harness.", evidenceFiles: ["docs/identity.md"], uncertainties: [] },
    baseline: "a".repeat(40),
  } }));

  await expect(runTesotaShellCommand({ surface: fixture.surface, discover, start: vi.fn() })).resolves.toBe(0);

  expect(fixture.progress).toEqual([{ phase: "discovering", operation: "repository_discovery" }]);
  expect(fixture.events.join("")).not.toContain("[discovering]");
  expect(fixture.events.at(-1)).toBe("stop");
});

it("settles prompt cancellation and restores the persistent surface", async () => {
  const fixture = fakeSurface(async () => { throw new DOMException("cancelled", "AbortError"); });

  await expect(runTesotaShellCommand({ surface: fixture.surface, discover: vi.fn(), start: vi.fn() })).resolves.toBe(130);

  expect(fixture.events).toEqual([
    "start",
    "Tesota session cancelled. Inspect retained evidence before retrying.\n",
    "stop",
  ]);
});

it("does not deny possible effects when the admitted lifecycle throws", async () => {
  const fixture = fakeSurface(async () => "Update the guide");
  const proposalId = "9877887d-1475-4439-a0a6-c1c85091fc9e";
  const discover = vi.fn(async () => ({ status: "completed" as const, exitCode: 0, turn: {
    kind: "task_proposal" as const,
    proposedTask: { directory: "proposal", record: {
      format: "tesota-task-proposal" as const, version: 1 as const, id: proposalId,
      recordedAt: "2026-09-13T00:00:00.000Z", source: "C:\\work\\tesota", baseline: "a".repeat(40),
      request: "Update the value", authority: "none" as const, provenance: "model_proposed" as const,
      status: "ready" as const, proposal: { objective: "Update the value", completionConditions: ["Correct"],
        readFiles: ["src/value.ts"], writeFiles: ["src/value.ts"],
        checks: ["scope-integrity" as const, "typescript-no-emit/v1" as const],
        uncertainties: [] }, dirtyPaths: [], dirtyConflicts: [], checks: [{ id: "scope-integrity" as const,
        definition: "application_owned_declarative_only" as const, executable: false as const },
      { id: "typescript-no-emit/v1" as const,
        definition: "application_owned_declarative_only" as const, executable: false as const }],
      discovery: { provider: "test", model: "test", inferenceTransport: "configured_provider" as const,
        modelControlledNetwork: false as const, modelInvocations: 1, toolCalls: 1, operations: 1,
        exposedBytes: 1, limits: PROPOSAL_LIMITS },
    } },
  } }));

  await expect(runTesotaShellCommand({ surface: fixture.surface, discover,
    start: async () => { throw new Error("promotion evidence failed"); } })).resolves.toBe(1);

  expect(fixture.events.join("")).toContain("Inspect retained evidence before retrying.");
  expect(fixture.events.join("")).not.toContain("Nothing changed");
  expect(fixture.events.at(-1)).toBe("stop");
});

it("routes simultaneous session turns and results to their originating conversation", async () => {
  const pending = new Map<string, (answer: string) => void>();
  const output: { id: string; text: string }[] = [];
  const inspections: string[] = [];
  let controls: { newSession: (id: string) => void; selectSession: (id: string) => void; quit: () => void } | undefined;
  const surface: TesotaShellTerminal = {
    start: () => {}, stop: () => {}, write: () => {}, ask: async () => "",
    report: () => {}, refreshElapsed: () => {}, inspect: () => {}, addSession: () => {}, selectSession: () => {},
    writeTo: (id, text) => { output.push({ id, text }); },
    askIn: (id) => new Promise<string>((resolve) => { pending.set(id, resolve); }),
    reportFor: () => {}, inspectFor: (id) => { inspections.push(id); }, recoverFor: () => {}, blockSession: () => {},
  };
  const release = new Map<string, (value: ReturnType<typeof answerResult>) => void>();
  const discover = vi.fn((_input, id = "default") => new Promise<ReturnType<typeof answerResult>>((resolve) => {
    release.set(id, resolve);
  }));
  const running = runTesotaShellCommand({ surface, initialSessionId: "default", discover, start: vi.fn(),
    configureWorkspace: (callbacks) => { controls = callbacks; } });
  await vi.waitFor(() => { expect(controls).toBeDefined(); });
  controls?.newSession("other");
  pending.get("default")?.("Question A");
  pending.get("other")?.("Question B");
  await vi.waitFor(() => { expect(discover).toHaveBeenCalledTimes(2); });
  release.get("other")?.(answerResult("Answer B"));
  await vi.waitFor(() => { expect(inspections).toContain("other"); });
  expect(inspections).not.toContain("default");
  release.get("default")?.(answerResult("Answer A"));
  await vi.waitFor(() => { expect(inspections).toContain("default"); });
  pending.get("other")?.("");
  pending.get("default")?.("");
  controls?.quit();
  await expect(running).resolves.toBe(0);
  expect(output.some((event) => event.id === "other" && event.text.includes("Answer B"))).toBe(true);
  expect(output.some((event) => event.id === "default" && event.text.includes("Answer A"))).toBe(true);
});

function answerResult(message: string) {
  return { status: "completed" as const, exitCode: 0, turn: {
    kind: "answer" as const,
    answer: { kind: "answer" as const, message, evidenceFiles: ["README.md"], uncertainties: [] },
    baseline: "a".repeat(40),
  } };
}
