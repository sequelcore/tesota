import { expect, it } from "vitest";
import { GateOperations, noOperations } from "../src/operations.js";

/** A tracker on a clock the test moves, in milliseconds. */
function tracker(): { ops: GateOperations; advance: (ms: number) => void } {
  let now = 1_000;
  return { ops: new GateOperations(() => now), advance: (ms) => { now += ms; } };
}

const command = { method: "command", unit: "", target: "bun test tests/rule.test.ts" } as const;

it("publishes a start and an end with a stable id, a monotonic start and the duration", async () => {
  const { ops, advance } = tracker();
  ops.beginRun("run-1");
  ops.beginAttempt();
  const id = ops.start(command);
  advance(19_000);
  expect(ops.operations()).toMatchObject([{ id, run: "run-1", generation: 1, method: "command", unit: "", state: "running",
    target: "bun test tests/rule.test.ts", startedAt: 1_000, reused: false, concurrent: false }]);
  ops.end(id, "passed");
  expect(ops.operations()).toMatchObject([{ id, state: "ended", startedAt: 1_000, endedAt: 20_000, durationMs: 19_000, result: "passed" }]);
});

it("runs work between the boundaries and ends with the result the work gives", async () => {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const value = await ops.forUnit("api").run({ method: "proof", unit: "ignored", target: "src/a.ts" }, async () => { advance(5); return "failed"; },
    (outcome) => outcome === "failed" ? "failed" : "passed");
  expect(value).toBe("failed");
  expect(ops.operations()).toMatchObject([{ unit: "api", result: "failed", durationMs: 5 }]);
});

it("ends an operation whose work throws as interrupted, never passed", async () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  await expect(ops.run(command, () => Promise.reject(new Error("broke")), () => "passed")).rejects.toThrow("broke");
  expect(ops.operations()).toMatchObject([{ state: "ended", result: "interrupted" }]);
});

it("reads a missing end event as interrupted when the attempt closes", () => {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  ops.start(command);
  advance(7_000);
  ops.closeAttempt("stopped");
  expect(ops.operations()).toMatchObject([{ state: "ended", result: "interrupted", durationMs: 7_000 }]);
  expect(ops.line(0)).toBeUndefined();
});

it("shows a long command with no output and its elapsed time until its 15-minute limit", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  ops.start({ method: "command", unit: "", target: "bun run check" });
  const lines = [0, 6, 14, 15].map((minutes) => ops.line(1_000 + minutes * 60_000) ?? "");
  expect(lines).toEqual(["Running project check · bun run check · 0:00", "Running project check · bun run check · 6:00",
    "Running project check · bun run check · 14:00", "Running project check · bun run check · 15:00"]);
  for (const line of lines) expect(line).not.toMatch(/%|remaining|left|eta|estimat/iu);
});

it("names the exact launched command beside the step and the seconds", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  ops.start({ method: "exercise", unit: "", target: "bun test tests/rule.test.ts" });
  expect(ops.line(1_000 + 19_000)).toBe("Checking test sensitivity · bun test tests/rule.test.ts · 0:19");
});

it("publishes concurrent work as concurrent, not as a serial history", () => {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const mutation = ops.start({ method: "mutation", unit: "", target: "src/a.ts#f" });
  advance(1_000);
  const claim = ops.start({ method: "claimcheck", unit: "", target: "1 contract" });
  expect(ops.operations().map(({ concurrent }) => concurrent)).toEqual([true, true]);
  advance(2_000);
  expect(ops.line(4_000)).toBe("Measuring contract strength · src/a.ts#f · 0:03 | Asking ClaimCheck · 1 contract · 0:02");
  ops.end(claim, "done");
  ops.end(mutation, "done");
  const later = ops.start({ method: "receipt", unit: "", target: "receipt" });
  expect(ops.operations().find(({ id }) => id === later)?.concurrent).toBe(false);
});

it("does not call a child concurrent with its parent", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const main = ops.start({ method: "model_main", unit: "", target: "models/A.tla" });
  ops.start({ method: "model_fault", unit: "", target: "models/F.cfg", parent: main });
  expect(ops.operations().map(({ concurrent }) => concurrent)).toEqual([false, false]);
});

it("marks reused work as reused with no time of its own", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  ops.reused({ method: "model_main", unit: "", target: "models/A.tla" }, "passed");
  expect(ops.operations()).toMatchObject([{ reused: true, state: "ended", result: "passed", durationMs: 0 }]);
  expect(ops.line(2_000)).toBeUndefined();
});

it("closes a send-back attempt as returned to the agent and keeps its operations", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  ops.end(ops.start(command), "failed");
  ops.closeAttempt("returned_to_agent");
  ops.beginAttempt();
  ops.end(ops.start(command), "passed");
  ops.closeAttempt("settled");
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "returned_to_agent" }, { generation: 2, closedAs: "settled" }]);
  expect(ops.operations().map(({ generation, result }) => [generation, result])).toEqual([[1, "failed"], [2, "passed"]]);
});

it("closes a stopped run's ended operations as they ended and marks the rest as not started", () => {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const first = ops.start({ method: "command", unit: "", target: "lint" });
  advance(10);
  ops.end(first, "passed");
  const second = ops.start({ method: "command", unit: "", target: "test" });
  advance(10);
  ops.end(second, "cancelled");
  ops.plan({ method: "command", unit: "", target: "build" });
  ops.plan({ method: "exercise", unit: "", target: "tests/a.test.ts" });
  ops.closeAttempt("stopped");
  expect(ops.operations().map(({ target, result }) => [target, result])).toEqual([["lint", "passed"], ["test", "cancelled"],
    ["build", "not_started"], ["tests/a.test.ts", "not_started"]]);
  expect(ops.operations().slice(2).every(({ startedAt }) => startedAt === undefined)).toBe(true);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "stopped" }]);
});

it("starts a planned operation under its own id", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const planned = ops.plan(command);
  expect(ops.operations()[0]).toMatchObject({ state: "planned" });
  expect(ops.start(command, planned)).toBe(planned);
  expect(ops.operations()).toHaveLength(1);
  expect(ops.operations()[0]).toMatchObject({ state: "running" });
});

it("forgets the earlier request's operations when a new request begins", () => {
  const { ops } = tracker();
  ops.beginRun("a");
  ops.beginAttempt();
  ops.end(ops.start(command), "passed");
  ops.beginRun("b");
  expect(ops.operations()).toEqual([]);
  expect(ops.attempts()).toEqual([]);
});

it("tells listeners of each boundary until they unsubscribe", () => {
  const { ops } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  let calls = 0;
  const off = ops.subscribe(() => { calls += 1; });
  const other = ops.subscribe(() => undefined);
  expect(ops.subscribers()).toBe(2);
  ops.end(ops.start(command), "passed");
  // Starting unplanned work announces its plan, its start and its end.
  expect(calls).toBe(3);
  off();
  expect(ops.subscribers()).toBe(1);
  ops.end(ops.start(command), "passed");
  expect(calls).toBe(3);
  other();
  expect(ops.subscribers()).toBe(0);
});

it("gives work through the empty sink without recording anything", async () => {
  expect(await noOperations.run(command, () => Promise.resolve(3), () => "passed")).toBe(3);
  expect(noOperations.plan(command)).toBe("");
  expect(noOperations.forUnit("x")).toBe(noOperations);
});

/** The ledger of a request that went back once and now runs its second attempt (#591). */
function secondAttempt(): { ops: GateOperations; now: number } {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const first = ops.start({ method: "proof", unit: "", target: "src/a.ts" });
  advance(3_000);
  ops.end(first, "failed");
  ops.closeAttempt("returned_to_agent");
  ops.beginAttempt();
  const steps = [[{ method: "proof", unit: "", target: "src/a.ts" }, 2_000, "passed"],
    [{ method: "command", unit: "api", target: "bun run check" }, 62_000, "passed"],
    [{ method: "exercise", unit: "", target: "bun test tests/a.test.ts" }, 4_000, "failed"],
    [{ method: "mutation", unit: "", target: "inRange in src/a.ts" }, 1_000, "vacuous"]] as const;
  for (const [spec, ms, result] of steps) {
    const id = ops.start(spec);
    advance(ms);
    ops.end(id, result);
  }
  ops.reused({ method: "model_main", unit: "", target: "models/Stock.tla" }, "passed");
  ops.start({ method: "model_fault", unit: "", target: "models/Fault.tla" });
  advance(5_000);
  return { ops, now: 1_000 + 3_000 + 2_000 + 62_000 + 4_000 + 1_000 + 5_000 };
}

it("shows the running check, the three latest ended ones with their time, how many came before, and earlier attempts folded (#591)", () => {
  const { ops, now } = secondAttempt();
  expect(ops.ledger(now, false)).toEqual([
    { glyph: "↺", text: "Attempt 1 · returned to agent · 1 check", depth: 0 },
    { glyph: "·", text: "2 earlier checks", depth: 0 },
    { glyph: "○", text: "Base run with the test · bun test tests/a.test.ts · 0:04 · failed on the base", depth: 0 },
    { glyph: "◐", text: "Contract strength · inRange in src/a.ts · 0:01 · verified nothing", depth: 0 },
    { glyph: "✓", text: "Model · models/Stock.tla · reused, not run again", depth: 0 },
    { glyph: "›", text: "Checking planted fault · models/Fault.tla · 0:05", depth: 0 },
  ]);
});

it("expanded, lists every check of every attempt, an earlier attempt's under it", () => {
  const { ops, now } = secondAttempt();
  expect(ops.ledger(now, true)).toEqual([
    { glyph: "↺", text: "Attempt 1 · returned to agent · 1 check", depth: 0 },
    { glyph: "✗", text: "Proof · src/a.ts · 0:03", depth: 1 },
    { glyph: "✓", text: "Proof · src/a.ts · 0:02", depth: 0 },
    { glyph: "✓", text: "Project check · api: bun run check · 1:02", depth: 0 },
    { glyph: "○", text: "Base run with the test · bun test tests/a.test.ts · 0:04 · failed on the base", depth: 0 },
    { glyph: "◐", text: "Contract strength · inRange in src/a.ts · 0:01 · verified nothing", depth: 0 },
    { glyph: "✓", text: "Model · models/Stock.tla · reused, not run again", depth: 0 },
    { glyph: "›", text: "Checking planted fault · models/Fault.tla · 0:05", depth: 0 },
  ]);
});

it("never shows an end that is not a pass as one: a limit, a stop, no end and an opinion are each said", () => {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const listing = ops.start({ method: "open_cases", unit: "", target: "openai/gpt-6-sol" });
  advance(5_000);
  ops.end(listing, "done");
  const check = ops.start({ method: "command", unit: "", target: "bun test" });
  advance(900_000);
  ops.end(check, "timed_out");
  ops.plan({ method: "proof", unit: "", target: "src/b.ts" });
  ops.start({ method: "proof", unit: "", target: "src/c.ts" });
  advance(1_000);
  ops.closeAttempt("stopped");
  expect(ops.ledger(0, true)).toEqual([
    { glyph: "○", text: "Open cases · openai/gpt-6-sol · 0:05", depth: 0 },
    { glyph: "○", text: "Project check · bun test · 15:00 · ran past its limit", depth: 0 },
    { glyph: "○", text: "Proof · src/b.ts · not started", depth: 0 },
    { glyph: "○", text: "Proof · src/c.ts · 0:01 · no end reported", depth: 0 },
  ]);
  ops.beginRun("next");
  expect(ops.ledger(0, true)).toEqual([]);
});

it("says a planted fault that passed was not caught, and leaves a failed fault and the base runs without a verdict", () => {
  const { ops, advance } = tracker();
  ops.beginRun("r");
  ops.beginAttempt();
  const ran = (method: "model_fault" | "base_control", target: string, result: "passed" | "failed"): void => {
    const id = ops.start({ method, unit: "", target });
    advance(1_000);
    ops.end(id, result);
  };
  ran("model_fault", "models/Lost.tla", "passed");
  ran("model_fault", "models/Caught.tla", "failed");
  ran("base_control", "bun test tests/a.test.ts", "passed");
  expect(ops.ledger(0, true)).toEqual([
    { glyph: "✗", text: "Model with planted fault · models/Lost.tla · 0:01 · passed: fault not caught", depth: 0 },
    { glyph: "○", text: "Model with planted fault · models/Caught.tla · 0:01 · model failed", depth: 0 },
    { glyph: "○", text: "Base run without the test · bun test tests/a.test.ts · 0:01 · passed on the base", depth: 0 },
  ]);
});