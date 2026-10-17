import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelContext } from "../src/loop.ts";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";

/**
 * Compaction in a session (#451): it triggers at the margin and on overflow,
 * keeps the tail verbatim and the request exact, merges its summaries,
 * survives a resume, and ends the run when it cannot summarize.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const request = "Write the six notes, then say done. Keep each note's text exactly as I wrote it: lowercase, no headings.";

/** A reply for the main conversation: a tool call, plain text, or a provider error. */
type Step = { readonly write: string } | { readonly text: string } | { readonly error: string };

/**
 * A scripted model that answers summary requests from `summaries` and the
 * conversation from `steps`, in order, whichever comes when; it keeps every
 * request it was given.
 */
function scripted(steps: readonly Step[], summaries: readonly (string | { readonly error: string })[], contextWindow: number) {
  const faux = fauxProvider({ models: [{ id: "small", contextWindow }] });
  const queue = [...steps];
  const summaryQueue = [...summaries];
  const seen: { readonly summary: boolean; readonly context: Context }[] = [];
  const answer = (context: Context) => {
    // The scripted model is given the messages alone; a summary request ends with the summary instruction.
    const last = context.messages.at(-1)?.content;
    const summary = typeof last === "string" && /summary contract|Update the previous summary/u.test(last);
    seen.push({ summary, context });
    if (summary) {
      const next = summaryQueue.shift() ?? "## Goal\nunscripted";
      return typeof next === "string" ? fauxAssistantMessage(next) : fauxAssistantMessage([], { stopReason: "error", errorMessage: next.error });
    }
    const step = queue.shift() ?? { text: "done" };
    if ("write" in step) {
      return fauxAssistantMessage([fauxToolCall("write", { path: step.write, content: `${step.write} `.repeat(300) })], { stopReason: "toolUse" });
    }
    if ("error" in step) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
    return fauxAssistantMessage(step.text);
  };
  faux.setResponses(Array.from({ length: 60 }, () => (context: unknown) => answer(context as Context)));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), seen };
}

const writes = (count: number): Step[] => Array.from({ length: count }, (_, k) => ({ write: `note-${k}.txt` }));
const entries = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").slice(1)
  .map((line) => JSON.parse(line) as { type: string; outcome?: string; reason?: string; kept?: number });

describe("compaction", () => {
  const open: EngineSession[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

  function session(model: ReturnType<typeof scripted>, compaction = { reserve: 1_000, keep: 600 },
    seen: { request?: string | undefined } = {}): EngineSession {
    const options: SessionOptions = {
      cwd: folder("tesota-core-compaction-cwd-"), folder: folder("tesota-core-compaction-sessions-"), models: model.models, model: model.model,
      compaction,
      // The verifier reads the request from the ledger, as Tesota's gate does.
      verifier: (pi, ledger) => { pi.on("agent_before_settle", () => { seen.request = ledger()?.text; }); },
    };
    const created = createSession(options);
    open.push(created);
    return created;
  }

  test("past the margin the older turns become a summary, the tail stays verbatim and the request stays exact", async () => {
    const model = scripted([...writes(6), { text: "done" }], ["## Goal\nwrite notes"], 3_000);
    const verified: { request?: string | undefined } = {};
    const created = session(model, undefined, verified);
    await created.prompt(request);
    expect(created.outcome()).toBe("completed");
    expect(entries(created.file).filter(({ type }) => type === "compaction").length).toBeGreaterThanOrEqual(1);
    const summaryRequest = model.seen.find(({ summary }) => summary);
    expect(summaryRequest?.context.messages.at(-1)?.content).toContain("note-0.txt");
    // The first request after the compaction starts with the request as given, then the summary.
    const after = model.seen.slice(model.seen.indexOf(summaryRequest!) + 1).find(({ summary }) => !summary);
    // The scripted model gets the system prompt as its first message; the compacted head comes next.
    const messages = after?.context.messages ?? [];
    expect(messages[1]?.content).toContain(`The operator's request, exactly as given:\n\n${request}`);
    expect(messages[1]?.content).toContain("## Goal\nwrite notes");
    // The tail starts at a turn, never at a tool's result.
    expect(messages[2]?.role).not.toBe("toolResult");
    expect(verified.request).toBe(request);
  });

  test("a second compaction merges into the first summary, and a resumed session holds the same conversation", async () => {
    const model = scripted([...writes(12), { text: "done" }], ["## Goal\nfirst summary", "## Goal\nsecond summary"], 3_000);
    const created = session(model);
    await created.prompt(request);
    const summaries = model.seen.filter(({ summary }) => summary);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries[1]?.context.messages.at(-1)?.content).toContain("Previous summary:\n## Goal\nfirst summary");
    const live = modelContext(created.history()).map(({ role, content }) => ({ role, content }));
    const file = created.file;
    await created.dispose();
    open.splice(0);
    const resumed = await openSession(file, { models: model.models, model: model.model, verifier: () => undefined });
    open.push(resumed);
    expect(modelContext(resumed.history()).map(({ role, content }) => ({ role, content }))).toEqual(live);
  });

  test("a provider that rejects the conversation as too long gets it once more, compacted", async () => {
    const model = scripted([...writes(4), { error: "prompt is too long: 250000 tokens > 200000 maximum" }, { text: "done" }],
      ["## Goal\nafter overflow"], 1_000_000);
    const created = session(model, { reserve: 1_000, keep: 600 });
    await created.prompt(request);
    expect(created.outcome()).toBe("completed");
    expect(entries(created.file).filter(({ type }) => type === "compaction")).toHaveLength(1);
  });

  test("a summary that fails twice, or comes out larger than what it replaced, ends the run as an error saying why", async () => {
    const failing = scripted([...writes(6), { text: "done" }], [{ error: "quota exhausted" }, { error: "quota exhausted" }], 3_000);
    const first = session(failing);
    await first.prompt(request);
    expect(first.outcome()).toBe("error");
    expect(entries(first.file).findLast(({ type }) => type === "run_end")?.reason).toBe("compaction failed twice: quota exhausted");
    const huge = "## Goal\n" + "too long ".repeat(5_000);
    const larger = scripted([...writes(6), { text: "done" }], [huge, "## Goal\nshort"], 3_000);
    const second = session(larger);
    await second.prompt(request);
    expect(second.outcome()).toBe("completed");
    expect(larger.seen.filter(({ summary }) => summary).length).toBeGreaterThanOrEqual(2);
  });

  test("/compact compacts between runs, and refuses while a run goes or with nothing to compact", async () => {
    const model = scripted([...writes(3), { text: "done" }], ["## Goal\nby hand"], 1_000_000);
    const created = session(model);
    expect(created.compact()).rejects.toThrow("There is nothing to compact yet.");
    const running = created.prompt(request);
    await expect(created.compact()).rejects.toThrow("A run is going");
    await running;
    await created.compact();
    expect(entries(created.file).filter(({ type }) => type === "compaction")).toHaveLength(1);
    expect(created.history()[0]).toMatchObject({ role: "custom", customType: "tesota.compaction", display: false });
  });
});
