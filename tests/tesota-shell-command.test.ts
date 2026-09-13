import { expect, it, vi } from "vitest";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import { runTesotaShellCommand } from "../src/tesota-shell-command.js";
import type { TesotaShellTerminal } from "../src/tesota-shell-terminal.js";

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
    "Tesota session cancelled. Nothing changed.\n",
    "stop",
  ]);
});
