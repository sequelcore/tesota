import { createModels, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory, RunOutcome, SettleEvent, SettleResult } from "../src/contract.ts";
import { createSession, type EngineSession, type SessionOptions } from "../src/session.ts";
import { continuationLimit } from "../src/settle-rule.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply } from "./scripted.ts";

/**
 * Settlement with a mandatory verifier (#439), what only `@tesota/core`
 * promises: the verifier settles after the extensions and none can silence
 * it, a run completes only when it verified, every other end is finalized
 * once with its reason, and input that verification did not see sends the
 * run back to the model.
 */
const open: EngineSession[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

function session(script: readonly ScriptStep[], options: Partial<SessionOptions> & { slow?: boolean } = {}): EngineSession {
  const faux = fauxProvider(options.slow === true ? { tokensPerSecond: 20 } : {});
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const created = createSession({ cwd: folder("tesota-core-settle-"), folder: folder("tesota-core-sessions-"), models,
    model: faux.getModel(), verifier: () => undefined, ...options });
  open.push(created);
  return created;
}

const entriesOf = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").slice(1)
  .map((line) => JSON.parse(line) as { type: string; outcome?: string; reason?: string; phase?: string; generation?: number });
const runEnd = (file: string) => entriesOf(file).findLast((entry) => entry.type === "run_end");

/** A verifier that records what it was told and answers with `answer`. */
function recording(seen: SettleEvent[], answer: (event: SettleEvent, call: number) => SettleResult | undefined = () => undefined):
  ExtensionFactory {
  return (pi) => { pi.on("agent_before_settle", (event) => { seen.push(event); return answer(event, seen.length); }); };
}

const sendBack = (customType: string) => ({ entries: [{ type: "custom_message" as const, customType, content: "Not yet.", display: true }],
  continue: true });

describe("the verifier", () => {
  test("one with no settle handler never lets a run complete", async () => {
    const run = session(["done"]);
    await run.prompt("go");
    expect(run.outcome()).toBe("incomplete");
    expect(runEnd(run.file)).toMatchObject({ outcome: "incomplete", reason: "the verifier has no settle handler" });
  });

  test("settles after the extensions, only once none sends the run back", async () => {
    const order: string[] = [];
    const run = session(["first", "second"], {
      extensions: [(pi) => { pi.on("agent_before_settle", () => { order.push("extension"); return order.length === 1 ? sendBack("lint") : undefined; }); }],
      verifier: (pi) => { pi.on("agent_before_settle", () => { order.push("verifier"); return undefined; }); },
    });
    await run.prompt("go");
    expect(order).toEqual(["extension", "extension", "verifier"]);
    expect(run.outcome()).toBe("completed");
  });

  test("its send-back holds although an extension asks to stop and drops every entry", async () => {
    const seen: SettleEvent[] = [];
    const run = session(["first", "second"], {
      extensions: [(pi) => { pi.on("agent_before_settle", () => ({ entries: [], continue: false })); }],
      verifier: recording(seen, (_event, call) => call === 1 ? sendBack("gate") : undefined),
    });
    await run.prompt("go");
    expect(run.messages().map((message) => message.customType ?? message.role)).toEqual(["user", "assistant", "gate", "assistant"]);
    expect(run.outcome()).toBe("completed");
  });

  test("an extension that throws ends the run incomplete; the verifier finalizes it, told why, and cannot send it back", async () => {
    const seen: SettleEvent[] = [];
    const run = session(["first", "never"], {
      extensions: [(pi) => { pi.on("agent_before_settle", () => { throw new Error("linter crashed"); }); }],
      verifier: recording(seen, () => sendBack("gate")),
    });
    await run.prompt("go");
    expect(seen.map(({ outcome, reason }) => [outcome, reason])).toEqual([["error", "a settle handler failed: linter crashed"]]);
    expect(run.lastAssistantText()).toBe("first");
    expect(run.outcome()).toBe("incomplete");
    expect(runEnd(run.file)?.reason).toContain("linter crashed");
  });

  test(`settlement stops after ${continuationLimit} automatic send-backs, as incomplete`, async () => {
    const seen: SettleEvent[] = [];
    const run = session(Array.from({ length: continuationLimit + 2 }, (_, k) => `answer ${k}`),
      { verifier: recording(seen, () => sendBack("gate")) });
    await run.prompt("go");
    expect(run.messages().filter((message) => message.role === "assistant")).toHaveLength(continuationLimit + 1);
    expect(run.outcome()).toBe("incomplete");
    expect(runEnd(run.file)?.reason).toBe(`settlement sent the run back ${continuationLimit} times`);
  });
});

describe("a run that does not complete is finalized once, with its reason", () => {
  test("a provider's returned error", async () => {
    const seen: SettleEvent[] = [];
    const run = session([{ error: "rate limited" }], { verifier: recording(seen) });
    await run.prompt("go");
    expect(seen.map(({ outcome, reason }) => [outcome, reason])).toEqual([["error", "rate limited"]]);
    expect(run.outcome()).toBe("error");
  });

  test("a provider that throws, as a quota exit can", async () => {
    const seen: SettleEvent[] = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const throwing = Object.assign(Object.create(models) as Models,
      { stream: () => { throw new Error("quota exhausted"); } });
    const run = session([], { models: throwing, model: faux.getModel(), verifier: recording(seen) });
    await run.prompt("go");
    expect(seen.map(({ outcome, reason }) => [outcome, reason])).toEqual([["error", "quota exhausted"]]);
    expect(run.outcome()).toBe("error");
    expect(runEnd(run.file)).toMatchObject({ outcome: "error", reason: "quota exhausted" });
  });

  test("the operator's stop during verification: the verifier is told, awaited, and the run ends aborted", async () => {
    const outcomes: RunOutcome[] = [];
    let finished = false;
    let started: () => void = () => undefined;
    const verifying = new Promise<void>((resolve) => { started = resolve; });
    const run = session(["done"], {
      verifier: (pi) => {
        pi.on("agent_before_settle", async (event, ctx) => {
          outcomes.push(event.outcome);
          started();
          await new Promise((resolve) => { ctx.signal?.addEventListener("abort", resolve); });
          await new Promise((resolve) => setTimeout(resolve, 50));
          finished = true;
          throw new Error("stopped while proving");
        });
      },
    });
    const prompt = run.prompt("go");
    await verifying;
    await run.abort();
    await prompt;
    expect(finished).toBe(true);
    expect(outcomes).toEqual(["completed"]);
    expect(run.outcome()).toBe("aborted");
    expect(runEnd(run.file)).toMatchObject({ outcome: "aborted", reason: "the operator stopped the run" });
  });
});

describe("input during settlement", () => {
  test("a steer that arrives while the verifier runs sends the run back to the model, and its handlers wait for settlement", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const verifying = new Promise<void>((resolve) => { started = resolve; });
    const run = session(["first", "after the steer"], {
      extensions: [(pi) => { pi.on("input", (event) => { order.push(`input:${event.text}`); return undefined; }); }],
      verifier: (pi) => {
        pi.on("agent_before_settle", async () => {
          order.push("verifier");
          if (order.filter((step) => step === "verifier").length === 1) {
            started();
            await new Promise<void>((resolve) => { release = resolve; });
          }
          order.push("verified");
          return undefined;
        });
      },
    });
    const prompt = run.prompt("go");
    await verifying;
    const steer = run.prompt("also check b", { streamingBehavior: "steer" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["input:go", "verifier"]);
    release();
    await Promise.all([prompt, steer]);
    expect(order).toEqual(["input:go", "verifier", "verified", "input:also check b", "verifier", "verified"]);
    expect(run.lastAssistantText()).toBe("after the steer");
    expect(run.outcome()).toBe("completed");
    expect(run.ledger()[0]?.amendments).toMatchObject([{ text: "also check b", behavior: "steer", delivered: true }]);
    expect(entriesOf(run.file).filter((entry) => entry.type === "settled" && entry.phase === "verifier").map((entry) => entry.generation))
      .toEqual([0, 1]);
  });
});

describe("input at settlement's edges", () => {
  test("input that arrives as the verifier's result is written comes after the run's end, and is refused, not lost", async () => {
    let steer: Promise<void> | undefined;
    const run: EngineSession = session(["done"], {
      verifier: (pi) => { pi.on("agent_before_settle", () => undefined); },
      writer: (writer) => ({ ...writer, append: (entry) => {
        writer.append(entry);
        if (entry.type === "settled" && entry.phase === "verifier") steer = run.prompt("one more thing", { streamingBehavior: "steer" });
      } }),
    });
    await run.prompt("go");
    await expect(steer).rejects.toThrow("send it as a new prompt");
    expect(run.outcome()).toBe("completed");
    expect(entriesOf(run.file).slice(-2).map((entry) => entry.type)).toEqual(["settled", "run_end"]);
  });

  test("settlement waits for an input handler still running when the model finishes, and counts its failure", async () => {
    let streaming: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => { streaming = resolve; });
    const run = session(["a reply that streams slowly enough to steer it part of the way through", "after the steer"], {
      slow: true,
      extensions: [(pi) => {
        pi.on("input", async (event) => {
          if (event.streamingBehavior === undefined) { streaming(); return undefined; }
          await new Promise((resolve) => setTimeout(resolve, 1500));
          throw new Error("the steer's handler failed");
        });
      }],
      verifier: (pi) => { pi.on("agent_before_settle", () => undefined); },
    });
    const prompt = run.prompt("go");
    await answered;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const steer = run.prompt("also check b", { streamingBehavior: "steer" });
    await Promise.all([prompt, steer]);
    expect(run.outcome()).toBe("incomplete");
    expect(runEnd(run.file)?.reason).toContain("the steer's handler failed");
  });
});

describe("a failed write during settlement", () => {
  test("rejects the prompt before the verifier runs, and nothing records the run as completed", async () => {
    let failing = false;
    let verified = false;
    const run = session(["done"], {
      verifier: (pi) => { pi.on("agent_before_settle", () => { verified = true; return undefined; }); },
      writer: (writer) => ({
        ...writer,
        append: (entry) => { if (entry.type === "settle" && entry.phase === "verifier") failing = true; writer.append(entry); },
        sync: () => { if (failing) throw new Error("disk full"); writer.sync(); },
      }),
    });
    await expect(run.prompt("go")).rejects.toThrow("disk full");
    await run.dispose();
    expect(verified).toBe(false);
    expect(entriesOf(run.file).some((entry) => entry.type === "run_end")).toBe(false);
  });
});
