import { expect, it, vi } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import type { Finding } from "../src/review.js";
import { runTesotaShell, type ApplyResult, type ReviewResult, type TesotaShellDependencies, type WorkResult } from "../src/tesota-shell.js";
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
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", changes: [change, added] })),
    checks: () => checks,
    suggestChecks: () => ["bun run check"],
    setChecks: vi.fn((commands: readonly string[]) => { checks = commands; }),
    review: vi.fn(async (commands: readonly string[]) => ({ status: "ready" as const, tree: "b".repeat(40),
      changes: [change, added], reviews: [], requests: ["Fix the discount"],
      checks: commands.map((command) => ({ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree: "b".repeat(40), environment: "host",
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

it("asks for the next request without a review when the agent changed nothing", async () => {
  const fixture = shell(["Explain pricing", ""], {
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", changes: [] })),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  // The agent's reply streams to the surface during work; the loop adds nothing about it.
  expect(fixture.text()).toBe("Session ended.\n");
  expect(fixture.dependencies.review).not.toHaveBeenCalled();
});

it("chooses checks once, reviews the changes and applies them on request", async () => {
  const fixture = shell(["Fix the discount", "", "a", "Add a tax helper", "a", ""]);
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledWith(["bun run check"]);
  expect(fixture.dependencies.review).toHaveBeenCalledWith(["bun run check"]);
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(2);
  // The review itself is presented once, by the review dependency; the loop only reports what was applied.
  expect(fixture.text()).not.toContain("Checks:");
  expect(fixture.text()).toContain("Applied to your repository:\n  edit src/price.ts\n  add src/tax.ts\n");
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

const fixable: Finding = { severity: "high", disposition: "fixable", origin: "introduced" as const, standing: "confirmed",
  path: "src/price.ts", line: 3,
  statement: "Exactly $100 is discounted", reason: "The request says over $100" };
const operatorCall: Finding = { severity: "medium", disposition: "operator", origin: "introduced" as const, statement: "Rounding is unspecified",
  reason: "Cents or dollars?" };

/** A review dependency that returns one prepared review per call, each for its own tree. */
function reviews(...rounds: { tree: string; findings: readonly Finding[] }[]): TesotaShellDependencies["review"] {
  return vi.fn(async (commands: readonly string[]): Promise<ReviewResult> => {
    const round = rounds.shift() ?? { tree: "z".repeat(40), findings: [] };
    return { status: "ready", tree: round.tree, changes: [change], requests: ["Charge over $100 less"],
      checks: commands.map((command) => ({ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree: round.tree, environment: "host", guarantees: hostProvider.guarantees,
        outcome: "passed" as const, exitCode: 0, durationMs: 1, output: "" })),
      reviews: [{ reviewer: "Tesota reviewer", tree: round.tree, status: "completed", summary: "", findings: round.findings }] };
  });
}

it("sends fixable findings back with the unchanged requests, then asks the operator on the corrected result", async () => {
  const fixture = shell(["Charge over $100 less", "", "a", ""],
    { review: reviews({ tree: "1".repeat(40), findings: [fixable] }, { tree: "2".repeat(40), findings: [] }) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.work).toHaveBeenNthCalledWith(1, "Charge over $100 less");
  expect(fixture.dependencies.work).toHaveBeenNthCalledWith(2,
    expect.stringContaining("The user's requests, unchanged:\n1. Charge over $100 less"), "tesota");
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(2);
  expect(fixture.dependencies.review).toHaveBeenCalledTimes(2);
  // The second review knows the result it corrects and what was sent back, so it can review only the correction.
  expect(fixture.dependencies.review).toHaveBeenNthCalledWith(1, ["bun run check"]);
  expect(fixture.dependencies.review).toHaveBeenNthCalledWith(2, ["bun run check"], { previousTree: "1".repeat(40), sentBack: [fixable] });
  expect(fixture.text()).toContain("Correction round 1 of 2: sending 1 problem back to the agent.");
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(1);
});

it("stops correcting after two rounds and leaves the rest to the operator", async () => {
  const fixture = shell(["Charge over $100 less", "", "k", ""], { review: reviews(
    { tree: "1".repeat(40), findings: [fixable] }, { tree: "2".repeat(40), findings: [fixable] },
    { tree: "3".repeat(40), findings: [fixable] }) });
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(3);
  expect(fixture.dependencies.review).toHaveBeenCalledTimes(3);
  expect(fixture.progress.map((event) => event.phase)).toContain("awaiting_decision");
});

it("stops early when a correction changes nothing", async () => {
  const fixture = shell(["Charge over $100 less", "", "k", ""], { review: reviews(
    { tree: "1".repeat(40), findings: [fixable] }, { tree: "1".repeat(40), findings: [fixable] }) });
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(2);
  expect(fixture.text()).toContain("The agent's correction changed nothing; the remaining problems are yours to judge.");
});

it("never sends the operator's calls back to the agent", async () => {
  const fixture = shell(["Charge over $100 less", "", "k", ""],
    { review: reviews({ tree: "1".repeat(40), findings: [operatorCall] }) });
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.text()).not.toContain("Correction round");
});

it("skips the decision when a correction is stopped, keeping the changes", async () => {
  let calls = 0;
  const fixture = shell(["Charge over $100 less", "", ""], {
    review: reviews({ tree: "1".repeat(40), findings: [fixable] }),
    work: vi.fn(async (): Promise<WorkResult> => ++calls === 1 ? { status: "completed", changes: [change] } : { status: "cancelled" }),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.text()).toContain("The correction was stopped. The changes stay in the workspace");
  expect(fixture.progress.map((event) => event.phase)).not.toContain("awaiting_decision");
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
});
