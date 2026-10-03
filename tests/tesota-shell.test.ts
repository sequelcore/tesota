import type { ProvedLines } from "../src/correction.js";
import { expect, it, vi } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { askingDecisions } from "../src/session-decisions.js";
import { optionForKey, type ShellQuestion } from "../src/tesota-shell-question.js";
import type { TesotaShellProgress } from "../src/shell-progress.js";
import type { Finding, Obligation, ReviewReport } from "../src/review.js";
import { runTesotaShell, type AnswerResult, type ApplyResult, type ReviewResult, type TesotaShellDependencies,
  type WholeChecksResult, type WorkResult } from "../src/tesota-shell.js";
import type { WorkspaceChange } from "../src/workspace.js";
import type { ApprovedCheck, CheckResult } from "../src/workspace-checks.js";

const change: WorkspaceChange = { status: "modified", path: "src/price.ts" };
const added: WorkspaceChange = { status: "added", path: "src/tax.ts" };

/** Answer a question with fixed answers from the scripted replies, as its key picks it; an empty reply is Enter. */
function choosing(answers: string[]) {
  return async <V extends string>(question: ShellQuestion<V>): Promise<V> =>
    optionForKey(question.options, answers.shift() ?? "")?.value ?? question.initial;
}

function shell(answers: string[], overrides: Partial<TesotaShellDependencies> = {}) {
  const output: string[] = [];
  const progress: TesotaShellProgress[] = [];
  let checks: readonly ApprovedCheck[] | null = null;
  const typed = { queued: false };
  const write = (text: string): void => { output.push(text); };
  const dependencies: TesotaShellDependencies = {
    write,
    decisions: askingDecisions(async () => answers.shift() ?? "", choosing(answers), write, () => typed.queued),
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
  return { dependencies, output, progress, typed, text: () => output.join("") };
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
    decisions: askingDecisions(async () => { order.push("ask"); return ""; }, choosing([]), () => {}, () => false) });
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
  expect(fixture.dependencies.review).toHaveBeenCalledWith([{ command: "bun run check", reports: [] }],
    { related: false, lastRound: false });
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
  expect(fixture.dependencies.review).toHaveBeenCalledWith(expected, { related: false, lastRound: false });
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

it("brings in the repository's newer changes and checks again when only they stood in the way, with no agent turn", async () => {
  const sourceChanged = { status: "conflict", reason: "files in your repository changed since this result was checked",
    paths: ["notes.png"], sourceChanged: true } as const;
  const apply = vi.fn<() => Promise<ApplyResult>>().mockResolvedValueOnce(sourceChanged)
    .mockResolvedValueOnce({ status: "applied", changes: [change, added] });
  const refresh = vi.fn(async () => "updated" as const);
  // Request, checks, apply, yes to bringing the changes in, apply again, then the end.
  const fixture = shell(["Fix it", "", "a", "y", "a", ""], { apply, refresh });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(refresh).toHaveBeenCalledOnce();
  expect(fixture.dependencies.review).toHaveBeenCalledTimes(2);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.text()).toContain("Not applied: files in your repository changed since this result was checked.\n  notes.png\n");
  expect(fixture.text()).toContain("Applied to your repository:");
});

it("keeps the result when the operator declines bringing the changes in, or they collide with it", async () => {
  const sourceChanged = { status: "conflict", reason: "files in your repository changed since this result was checked",
    paths: ["src/price.ts"], sourceChanged: true } as const;
  const declined = shell(["Fix it", "", "a", "", ""], { apply: async () => sourceChanged, refresh: vi.fn(async () => "updated" as const) });
  await runTesotaShell(declined.dependencies);
  expect(declined.dependencies.refresh).not.toHaveBeenCalled();
  expect(declined.dependencies.review).toHaveBeenCalledTimes(1);
  expect(declined.text()).toContain("The changes stay in the workspace.");
  const colliding = shell(["Fix it", "", "a", "y", ""], { apply: async () => sourceChanged, refresh: vi.fn(async () => "conflict" as const) });
  await runTesotaShell(colliding.dependencies);
  expect(colliding.dependencies.review).toHaveBeenCalledTimes(1);
  expect(colliding.text()).toContain("touch files this result also changes");
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
function reviews(...rounds: { tree: string; findings: readonly Finding[]; proved?: ProvedLines }[]): TesotaShellDependencies["review"] {
  return vi.fn(async (approved: readonly ApprovedCheck[]): Promise<ReviewResult> => {
    const round = rounds.shift() ?? { tree: "z".repeat(40), findings: [] };
    return { status: "ready", tree: round.tree, changes: [change], requests: ["Charge over $100 less"],
      checks: approved.map(({ command }) => ({ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command, tree: round.tree, environment: "host", guarantees: hostProvider.guarantees,
        outcome: "passed" as const, exitCode: 0, durationMs: 1, output: "" })),
      reviews: [{ reviewer: "Tesota reviewer", tree: round.tree, status: "completed", summary: "", findings: round.findings }],
      ...round.proved === undefined ? {} : { proved: round.proved } };
  });
}

it("asks the agent to strengthen the proved contract that allowed a finding it sends back", async () => {
  const proved = [{ path: "src/price.ts", lines: [2, 3, 4], contracts: ["//@ ensures \\result <= amount\nexport function total("] }];
  const fixture = shell(["Charge over $100 less", "", "a", ""],
    { review: reviews({ tree: "1".repeat(40), findings: [fixable], proved }, { tree: "2".repeat(40), findings: [] }) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.work).toHaveBeenNthCalledWith(2, expect.stringContaining("This line is proved, so its contract " +
    "allowed this behavior:\n    //@ ensures \\result <= amount\n    export function total(\n  Fix the code, and strengthen"),
  "tesota", { previousTree: "1".repeat(40), sentBack: [fixable] });
});

it("sends fixable findings back with the unchanged requests, then asks the operator on the corrected result", async () => {
  const fixture = shell(["Charge over $100 less", "", "a", ""],
    { review: reviews({ tree: "1".repeat(40), findings: [fixable] }, { tree: "2".repeat(40), findings: [] }) });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.work).toHaveBeenNthCalledWith(1, "Charge over $100 less");
  // The correction names the result it corrects and what was sent back, so its review, after a stop too, judges only it.
  expect(fixture.dependencies.work).toHaveBeenNthCalledWith(2,
    expect.stringContaining("The user's requests, unchanged:\n1. Charge over $100 less"), "tesota",
    { previousTree: "1".repeat(40), sentBack: [fixable] });
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(2);
  expect(fixture.dependencies.review).toHaveBeenCalledTimes(2);
  expect(fixture.dependencies.review).toHaveBeenNthCalledWith(2, [{ command: "bun run check", reports: [] }],
    { related: false, lastRound: false });
  expect(fixture.text()).toContain("Sending 1 item back to the agent to fix (attempt 1 of 2).");
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(1);
});

/** A command check as a round reports it: its related form's run when `related`, or the whole command's. */
function commandResult(tree: string, outcome: "passed" | "failed", related: boolean): CheckResult {
  return { verifier: "command", claim: "exits 0", limits: "only what it tests", command: related ? "vitest related 'src/price.ts'"
    : "bun run check", tree, environment: "host", guarantees: hostProvider.guarantees, outcome, exitCode: outcome === "passed" ? 0 : 1,
    durationMs: 1, output: "", ...related ? { relatedTo: "bun run check" } : {},
    ...outcome === "failed" ? { base: { outcome: "passed" as const, exitCode: 0, origin: "introduced" as const } } : {} };
}

/** Rounds whose checks ran only related forms, each with its review's findings. */
function relatedReviews(...rounds: { tree: string; findings: readonly Finding[] }[]): TesotaShellDependencies["review"] {
  return vi.fn(async (): Promise<ReviewResult> => {
    const round = rounds.shift() ?? { tree: "z".repeat(40), findings: [] };
    return { status: "ready", tree: round.tree, changes: [change], requests: ["Charge over $100 less"],
      checks: [commandResult(round.tree, "passed", true)],
      reviews: [{ reviewer: "Tesota reviewer", tree: round.tree, status: "completed", summary: "", findings: round.findings }] };
  });
}

function wholeRuns(...outcomes: ("passed" | "failed")[]): NonNullable<TesotaShellDependencies["checkWhole"]> {
  return vi.fn(async (): Promise<WholeChecksResult> => {
    const tree = "w".repeat(40);
    return { status: "ready", tree, checks: [commandResult(tree, outcomes.shift() ?? "passed", false)] };
  });
}

it("runs the whole checks before the decision when a round ran only related tests", async () => {
  const fixture = shell(["Charge over $100 less", "", "a", ""],
    { review: relatedReviews({ tree: "1".repeat(40), findings: [] }), checkWhole: wholeRuns("passed") });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.review).toHaveBeenCalledWith([{ command: "bun run check", reports: [] }],
    { related: true, lastRound: false });
  expect(fixture.dependencies.checkWhole).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.apply).toHaveBeenCalledTimes(1);
});

it("sends a failure only the whole checks found back to the agent, and runs them again on its correction", async () => {
  const fixture = shell(["Charge over $100 less", "", "a", ""], { review: relatedReviews(
    { tree: "1".repeat(40), findings: [] }, { tree: "2".repeat(40), findings: [] }), checkWhole: wholeRuns("failed", "passed") });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(2);
  expect(fixture.dependencies.work).toHaveBeenNthCalledWith(2, expect.stringContaining("`bun run check` failed"), "tesota",
    { previousTree: "1".repeat(40), sentBack: [] });
  expect(fixture.dependencies.checkWhole).toHaveBeenCalledTimes(2);
});

it("sends a low finding back with a failure only the whole checks found, and starts no round for the low finding alone (#254)",
  async () => {
    const low: Finding = { ...fixable, severity: "low", statement: "A comment is stale" };
    const fixture = shell(["Charge over $100 less", "", "a", ""], { review: relatedReviews(
      { tree: "1".repeat(40), findings: [low] }, { tree: "2".repeat(40), findings: [low] }), checkWhole: wholeRuns("failed", "passed") });
    await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
    expect(fixture.dependencies.work).toHaveBeenNthCalledWith(2, expect.stringContaining("`bun run check` failed"), "tesota",
      { previousTree: "1".repeat(40), sentBack: [low] });
    // On the correction the whole checks pass, so the low finding left alone goes to the operator: no third round.
    expect(fixture.dependencies.work).toHaveBeenCalledTimes(2);
  });

it("runs the whole checks once before the decision when the operator's next message goes first", async () => {
  const fixture = shell(["Charge over $100 less", "", ""],
    { review: relatedReviews({ tree: "1".repeat(40), findings: [fixable] }), checkWhole: wholeRuns("passed") });
  fixture.typed.queued = true;
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.checkWhole).toHaveBeenCalledTimes(1);
});

it("never runs the whole checks again after a round that already ran them", async () => {
  const fixture = shell(["Charge over $100 less", "", "a", ""], { checkWhole: wholeRuns() });
  await runTesotaShell(fixture.dependencies);
  expect(fixture.dependencies.checkWhole).not.toHaveBeenCalled();
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

it("lets a request the operator already typed go before a correction round and the decision, sending nothing back", async () => {
  const fixture = shell(["Charge over $100 less", "", ""], { review: reviews({ tree: "1".repeat(40), findings: [fixable] }) });
  fixture.typed.queued = true;
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.text()).toContain("Your next message goes first. The item for the agent to fix was not sent; it stays in the review.");
  // Typing on is "keep working": the changes stay pending, and nothing asks for the decision.
  expect(fixture.progress.map((event) => event.phase)).not.toContain("awaiting_decision");
  expect(fixture.text()).toContain("The changes stay in the workspace.");
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
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

it("sends an answer's gaps back only when the operator has not already typed the next request", async () => {
  const assessAnswer = vi.fn(async () => answered([unmet]));
  const fixture = shell(["Add a farewell() helper", ""], { assessAnswer,
    work: vi.fn(async (): Promise<WorkResult> => ({ status: "completed", changes: [] })) });
  fixture.typed.queued = true;
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(assessAnswer).toHaveBeenCalledTimes(1);
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(1);
  expect(fixture.text()).toContain("Your next message goes first.");
});

it("leaves a turn in the operator's files undecided after review, never holding the session for a decision", async () => {
  const fixture = shell(["Fix the discount", "", "Add a tax helper", ""], { place: () => "source" });
  await expect(runTesotaShell(fixture.dependencies)).resolves.toBe(0);
  expect(fixture.dependencies.apply).not.toHaveBeenCalled();
  expect(fixture.dependencies.reject).not.toHaveBeenCalled();
  expect(fixture.dependencies.work).toHaveBeenCalledTimes(2);
  expect(fixture.text()).toContain("This turn stays in your files, undecided: /keep keeps it, /revert undoes it, and a new " +
    "request continues on top of it.");
  expect(fixture.progress.some((event) => event.phase === "awaiting_decision")).toBe(false);
});

it("lets checks read the hidden files the operator names, asked once with the checks", async () => {
  const allowForChecks = vi.fn();
  const fixture = shell(["Fix the discount", "", "api/.env; secrets.txt", "", ""], {
    hiddenFiles: async () => ["api/.env", "deploy.key"], allowForChecks });
  await runTesotaShell(fixture.dependencies);
  expect(allowForChecks).toHaveBeenCalledWith(["api/.env"]);
  expect(fixture.text()).toContain("Hidden from the agent and its checks, since they may hold credentials:\n  api/.env\n  deploy.key\n");
});
