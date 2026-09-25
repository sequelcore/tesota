import { expect, it, vi } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import { runTesotaShell, type ApplyResult, type TesotaShellDependencies, type WorkResult } from "../src/tesota-shell.js";
import type { WorkspaceChange } from "../src/workspace.js";

const change: WorkspaceChange = { status: "modified", path: "src/price.ts" };
const added: WorkspaceChange = { status: "added", path: "src/tax.ts" };

function shell(answers: string[], overrides: Partial<TesotaShellDependencies> = {}) {
  const output: string[] = [];
  const progress: TesotaShellProgress[] = [];
  let checks: readonly string[] | null = null;
  const dependencies: TesotaShellDependencies = {
    write: (text) => { output.push(text); },
    ask: async () => answers.shift() ?? "",
    report: (event) => { progress.push(event); },
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", reply: "Done.", changes: [change, added] })),
    checks: () => checks,
    suggestChecks: () => ["bun run check"],
    setChecks: vi.fn((commands: readonly string[]) => { checks = commands; }),
    review: vi.fn(async (commands: readonly string[]) => ({ status: "ready" as const, changes: [change, added],
      checks: commands.map((command) => ({ command, tree: "b".repeat(40), environment: "host",
        guarantees: hostProvider.guarantees, outcome: "passed" as const, exitCode: 0, durationMs: 1, output: "" })) })),
    apply: vi.fn(async (): Promise<ApplyResult> => ({ status: "applied", changes: [change, added] })),
    reject: vi.fn(async () => {}),
    ...overrides,
  };
  return { dependencies, output, progress, text: () => output.join("") };
}

it("ends the session on an empty request without doing work", async () => {
  const fixture = shell([""]);
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.work).not.toHaveBeenCalled();
  expect(fixture.text()).toBe("Session ended.\n");
});

it("starts preparing the environment before asking for the first request", async () => {
  const order: string[] = [];
  const fixture = shell([], { prepare: () => { order.push("prepare"); },
    ask: async () => { order.push("ask"); return ""; } });
  await runTesotaShell(fixture.dependencies);
  expect(order).toEqual(["prepare", "ask"]);
});

it("answers without a review when the agent changed nothing", async () => {
  const fixture = shell(["Explain pricing", ""], {
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", reply: "Prices are in cents.", changes: [] })),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.text()).toContain("Prices are in cents.\n");
  expect(fixture.dependencies.review).not.toHaveBeenCalled();
});

it("chooses checks once, reviews the changes and applies them on request", async () => {
  const fixture = shell(["Fix the discount", "", "a", "Add a tax helper", "a", ""]);
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledWith(["bun run check"]);
  expect(fixture.dependencies.review).toHaveBeenCalledWith(["bun run check"]);
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(2);
  expect(fixture.text()).toContain("  edit src/price.ts\n  add src/tax.ts\nChecks:\n  passed: bun run check\n");
  expect(fixture.text()).toContain("Applied to your repository:\n");
  expect(fixture.progress.map((event) => event.phase)).toEqual(
    ["working", "checking", "awaiting_decision", "applying", "working", "checking", "awaiting_decision", "applying"]);
});

it.each([
  ["npm test; npm run lint", ["npm test", "npm run lint"]],
  ["none", []],
] as const)("accepts replacement checks %j", async (answer, expected) => {
  const fixture = shell(["Fix it", answer, "k", ""]);
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledWith(expected);
  expect(fixture.dependencies.review).toHaveBeenCalledWith(expected);
});

it("rejects changes without applying them", async () => {
  const fixture = shell(["Fix it", "", "r", ""]);
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.reject).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
  expect(fixture.text()).toContain("Changes discarded. Your repository was not touched.\n");
});

it("keeps changes in the workspace when the operator wants more work", async () => {
  const fixture = shell(["Fix it", "", "k", ""]);
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
  expect(fixture.dependencies.reject).not.toHaveBeenCalled();
  expect(fixture.text()).toContain("The changes stay in the workspace.");
});

it("reports a conflict and continues without writing", async () => {
  const fixture = shell(["Fix it", "", "a", ""], {
    apply: async () => ({ status: "conflict", reason: "These files changed in your repository", paths: ["src/price.ts"] }),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.text()).toContain("Not applied: These files changed in your repository.\n  src/price.ts\nNothing was written.");
});

it("closes the session when application may have been partial", async () => {
  const fixture = shell(["Fix it", "", "a", "More"], {
    apply: async () => ({ status: "uncertain", applied: ["src/price.ts"] }),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(1);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.text()).toContain("These files may have changed:\n  src/price.ts\n");
});

it.each([
  [{ status: "failed", reason: "model unavailable" }, "The request failed: model unavailable\n", 0],
  [{ status: "cancelled" }, "Stopped. Any changes so far stay in the workspace.\n", 0],
  [{ status: "unsettled" }, "The agent did not stop cleanly.", 1],
] as const)("handles %j work results", async (result, message, exit) => {
  const fixture = shell(["Fix it", ""], { work: async () => result });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(exit);
  expect(fixture.text()).toContain(message);
  expect(fixture.dependencies.review).not.toHaveBeenCalled();
});
