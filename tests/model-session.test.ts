import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type ModelSession, openModelTarget, runRole, runWithin } from "../src/integrations/model-session.js";
import type { CodingTurnResult } from "../src/integrations/pi-coding-session.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function credentials(): TesotaCredentials {
  const root = mkdtempSync(join(tmpdir(), "tesota-routes-"));
  roots.push(root);
  return new TesotaCredentials(join(root, "auth"));
}

it("sends each route to its engine and model", async () => {
  const store = credentials();
  expect(await openModelTarget("claude-code:opus", undefined, store)).toEqual({ engine: "claude-code", model: "opus" });
  const codex = await openModelTarget("codex:gpt-6-luna", undefined, store);
  expect(codex.engine === "pi" && [codex.model.provider, codex.model.id]).toEqual(["openai-codex", "gpt-6-luna"]);
  const anthropic = await openModelTarget("anthropic:claude-opus-5-5", undefined, store);
  expect(anthropic.engine === "pi" && [anthropic.model.provider, anthropic.model.id]).toEqual(["anthropic", "claude-opus-5-5"]);
});

it("refuses a choice that is not route:model, or a model the route does not have", async () => {
  const store = credentials();
  await expect(openModelTarget("gpt-6-luna", undefined, store)).rejects.toThrow("not a route:model choice");
  await expect(openModelTarget("codex:claude-opus-5-5", undefined, store)).rejects.toThrow("unavailable");
});

// A session that answers after `answerMs`, or stops when its signal aborts.
function slowSession(answerMs: number): ModelSession {
  return { usable: true, dispose() {}, run: async (_request, signal) => new Promise<CodingTurnResult>((settle) => {
    if (signal.aborted) { settle({ status: "cancelled" }); return; }
    const timer = setTimeout(() => { settle({ status: "completed", reply: "done" }); }, answerMs);
    signal.addEventListener("abort", () => { clearTimeout(timer); settle({ status: "cancelled" }); }, { once: true });
  }) };
}

it("stops a role's request at its time limit, as a failure rather than a cancellation", async () => {
  expect(await runRole(slowSession(5), "go", new AbortController().signal, 1_000)).toEqual({ status: "completed", reply: "done" });
  expect(await runRole(slowSession(5_000), "go", new AbortController().signal, 20))
    .toEqual({ status: "failed", reason: "no answer within the time limit" });
  const stop = new AbortController();
  setTimeout(() => { stop.abort(); }, 10);
  expect(await runRole(slowSession(5_000), "go", stop.signal, 1_000)).toEqual({ status: "cancelled" });
});

it("tells a request stopped by its limit from one the caller stopped", async () => {
  expect(await runWithin(slowSession(5_000), "go", new AbortController().signal, 20))
    .toEqual({ turn: { status: "cancelled" }, timedOut: true });
  const stop = new AbortController();
  stop.abort();
  expect((await runWithin(slowSession(5_000), "go", stop.signal, 1_000)).timedOut).toBe(false);
});
