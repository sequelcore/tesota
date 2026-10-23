import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactedHead, type HistoryMessage, modelContext } from "../src/loop.ts";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";

/**
 * Compaction in a session (#451): it triggers at the margin and on overflow,
 * keeps the tail verbatim and the request exact, merges its summaries,
 * survives a resume, and ends the run when it cannot summarize.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const request = "Write the six notes, then say done. Keep each note's text exactly as I wrote it: lowercase, no headings.";
// Leave room for the built-in tool declarations before the growing conversation crosses the margin.
const smallWindow = 4_000;

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
  // Temporary, until #484: given the session's id, pi-ai 1.3.0's scripted model counts a cached prompt's new tokens
  // twice, which these measured windows cannot absorb, so the id is withheld from it. Remove once pi-ai counts them once.
  const withoutSession = <Options extends { sessionId?: string }>(options?: Options) => {
    const { sessionId: _, ...rest } = options ?? {};
    return rest as Options;
  };
  models.setProvider({ ...faux.provider,
    stream: (model, context, options) => faux.provider.stream(model, context, withoutSession(options)),
    streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, withoutSession(options)) });
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
    const model = scripted([...writes(6), { text: "done" }], ["## Goal\nwrite notes"], smallWindow);
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
    const model = scripted([...writes(12), { text: "done" }], ["## Goal\nfirst summary", "## Goal\nsecond summary"], smallWindow);
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
    const failing = scripted([...writes(6), { text: "done" }], [{ error: "quota exhausted" }, { error: "quota exhausted" }], smallWindow);
    const first = session(failing);
    await first.prompt(request);
    expect(first.outcome()).toBe("error");
    expect(entries(first.file).findLast(({ type }) => type === "run_end")?.reason).toBe("compaction failed twice: quota exhausted");
    // A larger summary ends it at once, with no second try.
    const huge = "## Goal\n" + "too long ".repeat(5_000);
    const larger = scripted([...writes(6), { text: "done" }], [huge, "## Goal\nshort"], smallWindow);
    const second = session(larger);
    await second.prompt(request);
    expect(second.outcome()).toBe("error");
    expect(entries(second.file).findLast(({ type }) => type === "run_end")?.reason)
      .toBe("compaction failed: the summary came out larger than what it replaced");
    expect(larger.seen.filter(({ summary }) => summary)).toHaveLength(1);
  });

  test("the summary's tokens count in the session's usage", async () => {
    const model = scripted([...writes(6), { text: "done" }], ["## Goal\nwrite notes"], smallWindow);
    const created = session(model);
    await created.prompt(request);
    const replies = entries(created.file).filter(({ type }) => type === "assistant").length;
    // Every request the model answered, summaries included, counts once.
    expect(model.seen.length).toBeGreaterThan(replies);
    expect(created.stats().tokens.total).toBeGreaterThan(0);
  });

  test("/compact is exclusive: a second one is refused and a prompt waits for it", async () => {
    const model = scripted([...writes(3), { text: "done" }, { text: "after" }], ["## Goal\nby hand"], 1_000_000);
    const created = session(model, { reserve: 1_000, keep: 600 });
    await created.prompt(request);
    const first = created.compact();
    await expect(created.compact()).rejects.toThrow("The conversation is already being compacted.");
    const next = created.prompt("and one more thing");
    await first;
    await next;
    // The prompt's request came after the compaction, so it follows the compacted head.
    const history = created.history();
    expect(history[0]).toMatchObject({ customType: "tesota.compaction" });
    expect(history.findIndex((message) => message.role === "user" && message.content === "and one more thing")).toBeGreaterThan(0);
  });

  test("a repair written after a compaction goes after its reply, and the tail the compaction kept stays whole", async () => {
    const cwd = folder("tesota-core-compaction-cwd-");
    const file = join(folder("tesota-core-compaction-sessions-"), "repaired.jsonl");
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const reply = (id: string, stopReason: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "write",
      arguments: { path: `${id}.txt`, content: "x" } }], api: "faux", provider: "faux", model: "small", usage, stopReason, timestamp: 0 });
    const lines = [
      { type: "session", format: "tesota-session", version: 6, id: "repaired", cwd, createdAt: new Date(0).toISOString() },
      { type: "request", run: 1, text: request, origin: "interactive", at: new Date(0).toISOString(), base: { units: [] } },
      { type: "assistant", run: 1, message: reply("first", "toolUse") },
      { type: "tool_result", run: 1, message: { role: "toolResult", toolCallId: "first", toolName: "write",
        content: [{ type: "text", text: "written" }], isError: false, timestamp: 0 } },
      { type: "assistant", run: 1, message: reply("second", "aborted") },
      { type: "run_end", run: 1, outcome: "aborted", reason: "the operator stopped the run" },
      // Compacted live with [request, first, its result, second]: the last three were kept.
      { type: "compaction", run: 1, summary: "## Goal\nwrite", kept: 3, read: [], changed: [], tokensBefore: 100, tokensAfter: 50 },
      // Written when the session was opened again, after the compaction.
      { type: "reconciliation", run: 1, reply: 1, callId: "second", toolName: "write", repair: "not_run" },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const model = scripted([], [], 1_000_000);
    const resumed = openSession(file, { models: model.models, model: model.model, verifier: () => undefined });
    open.push(resumed);
    expect(resumed.history().map((message) => message.role === "toolResult" ? `result ${message.toolCallId}`
      : message.role === "assistant" ? `reply ${(message.content[0] as { id: string }).id}` : message.role))
      .toEqual(["custom", "reply first", "result first", "reply second", "result second"]);
  });

  test("a stop from /compact's own compacting event stops it before it compacts", async () => {
    const model = scripted([...writes(3), { text: "done" }], ["## Goal\nby hand"], 1_000_000);
    const created = session(model, { reserve: 1_000, keep: 600 });
    await created.prompt(request);
    created.subscribe((event) => { if (event.type === "compacting") void created.abort(); });
    await expect(created.compact()).rejects.toThrow("the operator stopped the run");
    expect(entries(created.file).some(({ type }) => type === "compaction")).toBe(false);
  });

  test("a prompt and /compact asked at once do not overlap: the prompt claims the session first", async () => {
    const model = scripted([...writes(3), { text: "done" }, { text: "next" }], ["## Goal\nby hand"], 1_000_000);
    const created = session(model, { reserve: 1_000, keep: 600 });
    await created.prompt(request);
    const next = created.prompt("next");
    await expect(created.compact()).rejects.toThrow("A run is going");
    await next;
    expect(entries(created.file).some(({ type }) => type === "compaction")).toBe(false);
  });

  test("the head gives the ledger by message, so a repeated text keeps its place and role", () => {
    const asked: HistoryMessage = { role: "user", content: "Use X", timestamp: 0 };
    const changed: HistoryMessage = { role: "user", content: "Use Y", timestamp: 0 };
    const repeated: HistoryMessage = { role: "user", content: "Use X", timestamp: 0 };
    const head = compactedHead([asked, changed, repeated], "## Goal\nx", { read: [], changed: [] }, [repeated]);
    expect(head.content).toStartWith("The operator's request, exactly as given:\n\nUse X\n\nAdded while you worked:\n\nUse Y\n\n");
    expect(head.content.match(/Use X/gu)).toHaveLength(1);
  });

  test("the head keeps an answer the tail lost, though an amendment given before it was delivered after it", () => {
    const asked: HistoryMessage = { role: "user", content: "Choose", timestamp: 0 };
    const amended: HistoryMessage = { role: "user", content: "Also Z", timestamp: 0 };
    const answer: HistoryMessage = { role: "toolResult", toolCallId: "ask", toolName: "ask_user", isError: false, timestamp: 0,
      content: [{ type: "text", text: "Operator selected: B" }] };
    const head = compactedHead([asked, amended, answer], "## Goal\nx", { read: [], changed: [] }, [amended]);
    expect(head.content).toStartWith("The operator's request, exactly as given:\n\nChoose\n\n"
      + "The operator answered your question:\n\nOperator selected: B\n\n");
    expect(head.content).not.toContain("Also Z");
  });

  test("a summary's tokens are written down, so a resumed session counts them too", async () => {
    const model = scripted([...writes(6), { text: "done" }], ["## Goal\nwrite notes"], smallWindow);
    const created = session(model);
    await created.prompt(request);
    const live = created.stats().tokens;
    const summaries = model.seen.filter(({ summary }) => summary).length;
    expect(entries(created.file).filter(({ type }) => type === "summary_usage")).toHaveLength(summaries);
    const file = created.file;
    await created.dispose();
    open.splice(0);
    const resumed = openSession(file, { models: model.models, model: model.model, verifier: () => undefined });
    open.push(resumed);
    expect(resumed.stats().tokens).toEqual(live);
  });

  test("a later run's request still in the tail is not repeated in the compacted head", async () => {
    const model = scripted([...writes(3), { text: "done" }, ...writes(3), { text: "done again" }],
      ["## Goal\nfirst", "## Goal\nsecond"], 1_000_000);
    const created = session(model, { reserve: 1_000, keep: 600 });
    await created.prompt(request);
    await created.compact();
    const second = "Now the second batch.";
    await created.prompt(second);
    await created.compact().catch(() => undefined);
    const head = created.history()[0];
    const tail = created.history().slice(1);
    const inTail = tail.some((message) => message.role === "user" && message.content === second);
    expect(head?.role === "custom" && head.content.includes(second)).toBe(!inTail);
  });

  test("/compact compacts between runs, and refuses while a run goes or with nothing to compact", async () => {
    const model = scripted([...writes(3), { text: "done" }], ["## Goal\nby hand"], 1_000_000);
    const created = session(model);
    expect(created.compact()).rejects.toThrow("There is nothing to compact yet.");
    // Once the run's request is in the conversation, the run is going.
    const going = new Promise<void>((resolve) => {
      const stop = created.subscribe((event) => { if (event.type === "message") { stop(); resolve(); } });
    });
    const running = created.prompt(request);
    await going;
    await expect(created.compact()).rejects.toThrow("A run is going");
    await running;
    await created.compact();
    expect(entries(created.file).filter(({ type }) => type === "compaction")).toHaveLength(1);
    expect(created.history()[0]).toMatchObject({ role: "custom", customType: "tesota.compaction", display: false });
  });
});
