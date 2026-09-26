import { expect, it } from "vitest";
import { type AskExplorer, exploreResult, ExplorerPool } from "../src/integrations/pi-explore.js";

const answer = (text: string) => ({ status: "answered" as const, answer: text });

it("runs at most the concurrency limit at once and lets the rest wait", async () => {
  let running = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const ask: AskExplorer = async (brief, _signal, onLine, onUsage) => {
    running += 1;
    peak = Math.max(peak, running);
    onLine(`read ${brief}`);
    onUsage(1_500);
    await new Promise<void>((settle) => { releases.push(settle); });
    running -= 1;
    return answer(brief);
  };
  const pool = new ExplorerPool(ask, 2, 8);
  const runs = ["a", "b", "c"].map((brief) => pool.run(brief, new AbortController().signal, () => {}));
  await new Promise((settle) => { setTimeout(settle, 10); });
  expect(peak).toBe(2);
  while (releases.length > 0 || running > 0) {
    releases.shift()?.();
    await new Promise((settle) => { setTimeout(settle, 5); });
  }
  const results = await Promise.all(runs);
  expect(results.map((run) => run.result)).toEqual([answer("a"), answer("b"), answer("c")]);
  expect(results[0]?.tokens).toBe(1_500);
  expect(peak).toBe(2);
});

it("refuses explorers beyond the per-turn allowance until the next turn", async () => {
  const pool = new ExplorerPool(async (brief) => answer(brief), 3, 2);
  const signal = new AbortController().signal;
  await pool.run("1", signal, () => {});
  await pool.run("2", signal, () => {});
  const third = await pool.run("3", signal, () => {});
  expect(third.result).toEqual({ status: "unfinished", reason: "this turn already asked 2 explorers; continue with what you have" });
  pool.startTurn();
  expect((await pool.run("4", signal, () => {})).result).toEqual(answer("4"));
});

it("stops a waiting explorer when the turn is stopped, and reports a failing one as unanswered", async () => {
  let release = (): void => {};
  const pool = new ExplorerPool(async () => { await new Promise<void>((settle) => { release = settle; }); return answer("x"); }, 1, 8);
  const busy = pool.run("busy", new AbortController().signal, () => {});
  const stop = new AbortController();
  const waiting = pool.run("waiting", stop.signal, () => {});
  stop.abort();
  expect((await waiting).result).toEqual({ status: "unfinished", reason: "the explorer was stopped before it started" });
  release();
  await busy;
  const failing = new ExplorerPool(async () => { throw new Error("model unavailable"); });
  expect((await failing.run("q", new AbortController().signal, () => {})).result)
    .toEqual({ status: "unfinished", reason: "model unavailable" });
});

it("tells the agent what the explorer found and what it cost, or why it has no answer", () => {
  expect(exploreResult({ result: answer("In src/a.ts:4."), durationMs: 12_400, tokens: 8_300 }))
    .toBe("Explorer's answer (12 s, 8k tokens); check what you rely on:\n\nIn src/a.ts:4.");
  expect(exploreResult({ result: { status: "unfinished", reason: "the explorer ran past its time limit" }, durationMs: 0, tokens: 0 }))
    .toBe("The explorer did not answer: the explorer ran past its time limit.");
});
