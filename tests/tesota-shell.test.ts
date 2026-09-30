import { expect, it, vi } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import type { Finding, Obligation, ReviewReport } from "../src/review.js";
import { runTesotaShell, type AnswerResult, type ApplyResult, type ReviewResult, type RevertResult, type TesotaShellDependencies,
  type WorkResult } from "../src/tesota-shell.js";
import type { WorkspaceChange } from "../src/workspace.js";
import type { ApprovedCheck } from "../src/workspace-checks.js";

const change: WorkspaceChange = { status: "modified", path: "src/price.ts" };
const added: WorkspaceChange = { status: "added", path: "src/tax.ts" };

function shell(answers: string[], overrides: Partial<TesotaShellDependencies> = {}) {
  const output: string[] = [];
  const progress: TesotaShellProgress[] = [];
  let checks: readonly ApprovedCheck[] | null = null;
  const dependencies: TesotaShellDependencies = {
    write: (text) => { output.push(text); },
    ask: async () => answers.shift() ?? "",
    report: (event) => { progress.push(event); },
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", changes: [change, added] })),
    checks: () => checks,
    suggestChecks: () => ["bun run check"],
    setChecks: vi.fn((approved: readonly ApprovedCheck[]) => { checks = approved; }),
    review: vi.fn(async (approved: readonly ApprovedCheck[]) => ({ status: "ready" as const, tree: "b".repeat(40),
      changes: [change, added], reviews: [], requests: ["Fix the discount"],
      checks: approved.map(({ command }) => ({ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree: "b".repeat(40), environment: "host",
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
  expect(fixture.dependencies.setChecks).toHaveBeenCalledWith([{ command: "bun run check", reports: [] }]);
  expect(fixture.dependencies.review).toHaveBeenCalledWith([{ command: "bun run check", reports: [] }]);
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(2);
  // The review itself is presented once, by the review dependency; the loop only reports what was applied.
  expect(fixture.text()).not.toContain("Checks:");
  expect(fixture.text()).toContain("Applied to your repository:\n  edit src/price.ts\n  add src/tax.ts\n");
  expect(fixture.progress.map((event) => event.phase)).toEqual(
    ["working", "checking", "awaiting_decision", "applying", "working", "checking", "awaiting_decision", "applying"]);
});

it.each([
  ["npm test; npm run lint", [{ command: "npm test", reports: [] }, { command: "npm run lint", reports: [] }]],
  ["none", []],
  ["bun run check => test-reports/unit.xml, test-reports\\workspace.xml; bun run lint",
    [{ command: "bun run check", reports: ["test-reports/unit.xml", "test-reports/workspace.xml"] },
      { command: "bun run lint", reports: [] }]],
  ["node -e \"[1].map((x) => x)\"", [{ command: "node -e \"[1].map((x) => x)\"", reports: [] }]],
] as const)("accepts replacement checks %j", async (answer, expected) => {
  const fixture = shell(["Fix it", answer, "k", ""]);
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledWith(expected);
  expect(fixture.dependencies.review).toHaveBeenCalledWith(expected);
});

it.each(["bun run test => ../outside.xml", "bun run test => C:\\reports\\unit.xml", "bun run test => .git/unit.xml",
  "bun run test =>"])("asks again when a check's reports are not paths inside the repository: %j", async (answer) => {
  const fixture = shell(["Fix it", answer, "bun run test => reports/unit.xml", "k", ""]);
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.setChecks).toHaveBeenCalledWith([{ command: "bun run test", reports: ["reports/unit.xml"] }]);
  expect(fixture.text()).toMatch(/report/u);
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

it("says when everything written was undone", async () => {
  const fixture = shell(["Fix it", "", "a", ""], {
    apply: async () => ({ status: "conflict", reason: "a file changed while applying", paths: ["src/price.ts"],
      rolledBack: true }),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.text()).toContain("  src/price.ts\nYour repository holds its original files again. The changes stay");
});

it("names files outside the result that changed while it was applied", async () => {
  const fixture = shell(["Fix it", "", "a", ""], {
    apply: async () => ({ status: "applied", changes: [], alsoChanged: ["notes.md"] }),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.text()).toContain("also changed while it was applied; the next request brings them in:\n  notes.md\n");
});

it("closes the session and points to recovery when application stopped partway", async () => {
  const fixture = shell(["Fix it", "", "a", "More"], {
    apply: async () => ({ status: "recovery_required", id: "a1", paths: [{ path: "src/price.ts", state: "applied" },
      { path: "src/tax.ts", state: "changed" }] }),
  });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(1);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.text()).toContain("Recovery required: application stopped partway and could not be undone.\n" +
    "  src/price.ts: applied\n  src/tax.ts: changed by someone else, not touched\n");
  expect(fixture.text()).toContain("Run tesota recover in this repository");
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
  return vi.fn(async (approved: readonly ApprovedCheck[]): Promise<ReviewResult> => {
    const round = rounds.shift() ?? { tree: "z".repeat(40), findings: [] };
    return { status: "ready", tree: round.tree, changes: [change], requests: ["Charge over $100 less"],
      checks: approved.map(({ command }) => ({ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree: round.tree, environment: "host", guarantees: hostProvider.guarantees,
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
  const approved = [{ command: "bun run check", reports: [] }];
  expect(fixture.dependencies.review).toHaveBeenNthCalledWith(1, approved);
  expect(fixture.dependencies.review).toHaveBeenNthCalledWith(2, approved, { previousTree: "1".repeat(40), sentBack: [fixable] });
  expect(fixture.text()).toContain("Sending 1 item back to the agent to fix (attempt 1 of 2).");
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
  expect(fixture.text()).toContain("The agent's fix was stopped. The changes stay in the workspace");
  expect(fixture.progress.map((event) => event.phase)).not.toContain("awaiting_decision");
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
});

const answered = (obligations: Obligation[]): AnswerResult => ({ status: "assessed", requests: ["Add a farewell() helper"],
  reviews: [{ reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "s", findings: [], obligations } satisfies ReviewReport] });
const unmet: Obligation = { source: "request", index: 1, obligation: "farewell() exists", status: "unmet",
  evidence: "no farewell in src/", standing: "confirmed" };
const met: Obligation = { source: "request", index: 1, obligation: "farewell() exists", status: "met", evidence: "src/greet.ts:4" };

it("checks a turn that changed nothing against its requests, and asks nothing more when every request held", async () => {
  const assessAnswer = vi.fn(async () => answered([met]));
  const fixture = shell(["Explain pricing", ""], { assessAnswer,
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", changes: [] })) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(assessAnswer).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.review).not.toHaveBeenCalled();
  expect(fixture.progress.map((event) => event.phase)).toEqual(["working", "reviewing"]);
  expect(fixture.text()).toBe("Session ended.\n");
});

it("sends a request a reply only claimed back to the agent, and reviews the files its correction then writes", async () => {
  const assessAnswer = vi.fn(async () => answered([unmet]));
  const work = vi.fn(async (_request: string, _origin?: string): Promise<WorkResult> => ({ status: "completed", changes: [] }))
    .mockResolvedValueOnce({ status: "completed", changes: [] })
    .mockResolvedValueOnce({ status: "completed", changes: [added] });
  const fixture = shell(["Add a farewell() helper", "", "a", ""], { assessAnswer, work });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(work).toHaveBeenCalledTimes(2);
  expect(work.mock.calls[1]?.[1]).toBe("tesota");
  expect(String(work.mock.calls[1]?.[0])).toContain("- Request 1 is not done: farewell() exists");
  expect(fixture.text()).toContain("Sending 1 item back to the agent to fix (attempt 1 of 2).");
  // Files now exist, so the correction faces the full review and the operator's decision.
  expect(fixture.dependencies.review).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(1);
});

it("stops checking an answer after two correction rounds and leaves the rest to the operator", async () => {
  const assessAnswer = vi.fn(async () => answered([unmet]));
  const fixture = shell(["Add a farewell() helper", ""], { assessAnswer,
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", changes: [] })) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(assessAnswer).toHaveBeenCalledTimes(3);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(3);
  expect(fixture.dependencies.review).not.toHaveBeenCalled();
});

it("keeps a turn in the operator's files, or leaves it undecided, and never applies or rejects there", async () => {
  const keep = vi.fn(async () => {});
  const fixture = shell(["Fix the discount", "", "k", "Add a tax helper", "", ""], { place: () => "source", keep,
    revert: vi.fn(async (): Promise<RevertResult> => ({ status: "none" })) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(keep).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
  expect(fixture.dependencies.reject).not.toHaveBeenCalled();
  expect(fixture.text()).toContain("Kept. The changes are in your files.\n");
  expect(fixture.text()).toContain("The changes stay in your files, undecided; your next decision covers them too.\n");
});

it("reverts the latest turn, asks before files changed outside the agent's tools, and steps back on request", async () => {
  const asked: string[] = [];
  const answers = ["Fix the discount", "", "r", "n", "r", ""];
  let turns = 2;
  const revert = vi.fn(async (confirm: (paths: readonly string[]) => Promise<boolean>): Promise<RevertResult> => {
    const reverted = turns === 2 && await confirm(["bun.lock"]);
    turns -= 1;
    return { status: "reverted", restored: ["src/price.ts"], changedSince: [], left: turns === 1 && !reverted ? ["bun.lock"] : [],
      earlier: turns };
  });
  const fixture = shell([], { place: () => "source", keep: vi.fn(async () => {}), revert,
    ask: async (prompt) => { asked.push(prompt); return answers.shift() ?? ""; } });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(revert).toHaveBeenCalledTimes(2);
  expect(asked).toContain("[k]eep, [r]evert, or Enter to continue working: ");
  expect(asked.some((prompt) => prompt.includes("bun.lock") && prompt.endsWith("Revert them too? [y/N] "))).toBe(true);
  expect(asked).toContain("1 earlier turn is undecided. [r]evert the one before, [k]eep them, or Enter to leave them: ");
  expect(fixture.text()).toContain("Left as the turn left them, as you chose:\n  bun.lock\n");
});

it("names a file edited since the turn, which revert leaves, and closes the session when recovery is required", async () => {
  const fixture = shell(["Fix the discount", "", "r", ""], { place: () => "source", keep: vi.fn(async () => {}),
    revert: vi.fn(async (): Promise<RevertResult> => ({ status: "reverted", restored: ["src/tax.ts"],
      changedSince: ["src/price.ts"], left: [], earlier: 0 })) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.text()).toContain("Left as they are, since they changed after the turn:\n  src/price.ts\n");
  const stopped = shell(["Fix the discount", "", "r"], { place: () => "source", keep: vi.fn(async () => {}),
    revert: vi.fn(async (): Promise<RevertResult> => ({ status: "recovery_required", id: "a1",
      paths: [{ path: "src/price.ts", state: "changed" }] })) });
  await expect(runTesotaShell(stopped.dependencies)).resolves.toBe(1);
  expect(stopped.text()).toContain("Run tesota recover");
});

it("lets checks read the hidden files the operator names, asked once with the checks", async () => {
  const allowForChecks = vi.fn();
  const fixture = shell(["Fix the discount", "", "api/.env; secrets.txt", "", ""], {
    hiddenFiles: async () => ["api/.env", "deploy.key"], allowForChecks });
  await runTesotaShell(fixture.dependencies);
  expect(allowForChecks).toHaveBeenCalledWith(["api/.env"]);
  expect(fixture.text()).toContain("Hidden from the agent and its checks, since they may hold credentials:\n  api/.env\n  deploy.key\n");
});
