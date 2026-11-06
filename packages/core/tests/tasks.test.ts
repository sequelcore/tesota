import { type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionFactory } from "../../../src/contract.ts";
import { continuesType } from "../src/loop.ts";
import { modelContext } from "../src/prompt.ts";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";
import { readSessionFile } from "../src/session-file.ts";
import { invalidTasks, type Task, taskBook, tasksNotice, tasksSection } from "../src/tasks.ts";
import type { ScriptStep } from "./engine.ts";
import { accepts, scriptedReply } from "./scripted.ts";

const plan: Task[] = [
  { title: "Inspect session recovery", status: "completed" },
  { title: "Implement task restoration", status: "in_progress" },
  { title: "Check the real terminal path", status: "pending" },
];
const update = (tasks: readonly Task[]): ScriptStep => ({ tool: "update_tasks", args: { tasks: tasks.map(({ title, status }) => ({ title, status })) } });

describe("a task list's bounds", () => {
  test("a list keeps at most one task in progress, a title on every task and its sizes, and nothing else", () => {
    expect(invalidTasks({ tasks: plan })).toBeUndefined();
    expect(invalidTasks({ tasks: [] })).toBeUndefined();
    expect(invalidTasks({ tasks: [...plan, { title: "Another", status: "in_progress" }] })).toContain("at most one");
    expect(invalidTasks({ tasks: [{ title: "  ", status: "pending" }] })).toContain("title");
    expect(invalidTasks({ tasks: [{ title: "é".repeat(513), status: "pending" }] })).toContain("1,024 bytes");
    expect(invalidTasks({ tasks: [{ title: "é".repeat(512), status: "pending" }] })).toBeUndefined();
    const many = Array.from({ length: 40 }, (_, k) => ({ title: `${k} ${"x".repeat(400)}`, status: "pending" as const }));
    expect(invalidTasks({ tasks: many })).toContain("16 KiB");
    expect(invalidTasks({ tasks: [{ title: "Done", status: "finished" }] })).toContain("invalid shape");
    expect(invalidTasks({ tasks: [{ title: "Done", status: "completed", id: 1 }] })).toContain("invalid shape");
  });
});

describe("a session's task book", () => {
  test("a run's list is its own latest, or one its recorded continuations inherit, never a sibling's", () => {
    const book = taskBook(continuesType);
    expect(book.state(1)).toEqual({ kind: "none" });
    book.saved(1, "a", { tasks: plan });
    book.saved(2, "b", { tasks: [{ title: "Unrelated", status: "pending" }] });
    book.linked(3, 1);
    book.linked(4, 3);
    expect(book.state(4)).toMatchObject({ kind: "list", run: 1, callId: "a", tasks: plan });
    // A run with no link starts with no list, whatever an earlier run left.
    expect(book.state(5)).toEqual({ kind: "none" });
    book.saved(4, "c", { tasks: [] });
    expect(book.state(4)).toMatchObject({ kind: "list", tasks: [] });
  });

  test("a link to the run itself or a later run, or a malformed saved list, leaves the list unavailable until a valid update", () => {
    const book = taskBook(continuesType);
    book.linked(2, 2);
    book.linked(3, 7);
    book.linked(4, "1");
    expect([2, 3, 4].map((run) => book.state(run).kind)).toEqual(["unavailable", "unavailable", "unavailable"]);
    book.saved(5, "a", { tasks: [{ title: "", status: "pending" }] });
    expect(book.state(5).kind).toBe("unavailable");
    book.saved(5, "b", { tasks: plan });
    expect(book.state(5).kind).toBe("list");
  });

  test("a compaction lists the saved tasks, or points at the update still in the tail, and says nothing of no list", () => {
    const listed = { kind: "list", tasks: plan, run: 1, callId: "a" } as const;
    const section = tasksSection(listed, () => false) ?? "";
    expect(section).toContain('- in_progress: "Implement task restoration"');
    expect(section).toContain("not verified");
    expect(tasksSection(listed, (callId) => callId === "a")).not.toContain("Implement task restoration");
    expect(tasksSection({ kind: "none" }, () => false)).toBeUndefined();
    expect(tasksSection({ ...listed, tasks: [] }, () => false)).toBeUndefined();
    expect(tasksSection({ kind: "unavailable" }, () => false)).toContain("could not be read back");
    expect(tasksNotice(listed, 1)).toContain("continues run 1");
    expect(tasksNotice({ kind: "none" }, 1)).toBeUndefined();
  });
});

const sessions: EngineSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.dispose())); });

function scriptedModels(script: readonly ScriptStep[]): Pick<SessionOptions, "models" | "model"> {
  const provider = fauxProvider();
  provider.setResponses(script.map(scriptedReply));
  const registry = createModels();
  registry.setProvider(provider.provider);
  return { models: registry, model: provider.getModel() };
}

function start(script: readonly ScriptStep[], options: Partial<SessionOptions> = {}): EngineSession {
  const session = createSession({ cwd: mkdtempSync(join(tmpdir(), "tesota-tasks-project-")),
    folder: mkdtempSync(join(tmpdir(), "tesota-tasks-sessions-")), ...scriptedModels(script), verifier: accepts, taskList: true, ...options });
  sessions.push(session);
  return session;
}

/** The tools the model was told of: Tesota announces them in its system messages. */
const offered = (context: Context): string => JSON.stringify(context.messages.filter((message) => (message.role as string) === "system"));

describe("the task list in a session", () => {
  test("an update is saved and synced before the model hears of it, and a reopened session shows it without running anything", async () => {
    let tools = "";
    const session = start([update(plan), { seen: (context) => { tools = offered(context); }, reply: "done" }]);
    const events: string[] = [];
    session.subscribe((event) => { events.push(event.type); });
    await session.prompt("Restore the task list.");
    expect(tools).toContain('"update_tasks"');
    expect(session.tasks()).toMatchObject({ kind: "list", tasks: plan, run: 1 });
    expect(events).toContain("tasks");
    const file = session.file;
    await session.dispose();
    sessions.splice(0);
    const reopened = openSession(file, { ...scriptedModels([]), verifier: accepts });
    sessions.push(reopened);
    expect(reopened.tasks()).toMatchObject({ kind: "list", tasks: plan, run: 1 });
    expect(readSessionFile(file).entries.filter((entry) => entry.type === "request")).toHaveLength(1);
  });

  test("a failed update changes nothing, and a list the agent marked done does not settle a run its verifier never settles", async () => {
    const session = start([update(plan), update([...plan, { title: "Second focus", status: "in_progress" }]),
      update(plan.map((task) => ({ ...task, status: "completed" as const }))), "all done"], { verifier: () => undefined });
    await session.prompt("Do it.");
    const results = session.messages().filter((message) => message.role === "toolResult");
    expect(results.map((result) => result.isError)).toEqual([false, true, false]);
    expect(session.tasks()).toMatchObject({ kind: "list", tasks: plan.map((task) => ({ ...task, status: "completed" })) });
    expect(session.outcome()).not.toBe("completed");
  });

  test("off, the model is not offered update_tasks and a call to it is a failed call", async () => {
    let tools = "";
    const session = start([{ seen: (context) => { tools = offered(context); }, reply: "planning" }], { taskList: false });
    await session.prompt("Plan.");
    expect(tools).toContain('"write"');
    expect(tools).not.toContain('"update_tasks"');
    const called = start([update(plan), "done"], { taskList: false });
    await called.prompt("Plan.");
    expect(called.messages().find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
    expect(called.tasks()).toEqual({ kind: "none" });
  });

  test("a sync that fails on the update's result stops the session before the model or the shell hears of the list", async () => {
    let syncs = 0;
    let failing = false;
    const session = start([update(plan), "done"], { writer: (writer) => ({ ...writer, append: (entry) => {
      failing = entry.type === "tool_result";
      writer.append(entry);
    }, sync: () => { syncs++; if (failing) throw new Error("disk full"); writer.sync(); } }) });
    const events: string[] = [];
    session.subscribe((event) => { events.push(event.type); });
    await expect(session.prompt("Do it.")).rejects.toThrow("disk full");
    expect(syncs).toBeGreaterThan(0);
    // The run's start tells the shell its list once; the failed update tells it nothing.
    expect(events.filter((type) => type === "tasks")).toHaveLength(1);
    expect(session.tasks()).toEqual({ kind: "none" });
    expect(session.history().some((message) => message.role === "toolResult")).toBe(false);
  });

  test("an answer to the run's question inherits its list and is told of it; a new request starts with none", async () => {
    let continued = "";
    const session = start([update(plan), "Which account should I use?",
      { seen: (context) => { continued = JSON.stringify(context.messages); }, reply: "Used the work account." }, "Something else."]);
    await session.prompt("Set it up.");
    expect(session.outcome()).toBe("incomplete");
    await session.reply("The work account.");
    expect(session.ledger()[1]?.continues?.run).toBe(1);
    expect(session.tasks()).toMatchObject({ kind: "list", run: 1, tasks: plan });
    expect(continued).toContain("This request continues run 1, which left this task list");
    const notices = readSessionFile(session.file).entries.flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === "tesota.tasks" ? [entry.run] : []);
    expect(notices).toEqual([2]);
    await session.prompt("A new request.");
    expect(session.tasks()).toEqual({ kind: "none" });
  });

  test("an extension may not register update_tasks, whether the task list is on or off", () => {
    const named: ExtensionFactory = (pi) => {
      pi.registerTool({ name: "update_tasks", label: "tasks", description: "Not Tesota's.", parameters: Type.Object({}),
        execute: () => Promise.resolve({ content: [{ type: "text", text: "" }], details: undefined }) });
    };
    for (const taskList of [true, false]) {
      expect(() => start([], { taskList, extensions: [named] })).toThrow("Tesota's own tool name");
    }
  });
});

describe("the task list through compaction", () => {
  /** A scripted model that answers summary requests with a summary and the conversation from `steps`; it keeps each request. */
  function compacting(steps: readonly (ScriptStep & object)[]) {
    const faux = fauxProvider({ models: [{ id: "small", contextWindow: 6_000 }] });
    const queue = [...steps];
    const seen: Context[] = [];
    faux.setResponses(Array.from({ length: 40 }, () => (context: unknown) => {
      const given = context as Context;
      const last = given.messages.at(-1)?.content;
      if (typeof last === "string" && /summary contract|Update the previous summary/u.test(last)) return fauxAssistantMessage("## Goal\nwrite notes");
      seen.push(given);
      const step = queue.shift();
      if (step === undefined || typeof step === "string") return fauxAssistantMessage("done");
      if ("tool" in step) return fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
      return fauxAssistantMessage("done");
    }));
    const models = createModels();
    // As in the compaction tests: withheld so the scripted model counts a cached prompt once.
    const withoutSession = <Options extends { sessionId?: string }>(options?: Options) => {
      const { sessionId: _, ...rest } = options ?? {};
      return rest as Options;
    };
    models.setProvider({ ...faux.provider,
      stream: (model, context, options) => faux.provider.stream(model, context, withoutSession(options)),
      streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, withoutSession(options)) });
    return { models, model: faux.getModel(), seen };
  }

  test("a compaction restores the list it summarized away, counts it, and a reopened session holds the same conversation", async () => {
    const writes = Array.from({ length: 6 }, (_, k) => ({ tool: "write", args: { path: `note-${k}.txt`, content: `note-${k} `.repeat(300) } }));
    const model = compacting([update(plan) as ScriptStep & object, ...writes]);
    const session = start([], { models: model.models, model: model.model, compaction: { reserve: 1_000, keep: 600 } });
    await session.prompt("Write the six notes, then say done.");
    expect(readSessionFile(session.file).entries.findLast((entry) => entry.type === "run_end")).toMatchObject({ outcome: "completed" });
    const compactions = readSessionFile(session.file).entries.filter((entry) => entry.type === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    const head = model.seen.find((context) => JSON.stringify(context.messages).includes("## Goal\\nwrite notes"));
    const restored = JSON.stringify(head?.messages[1]);
    expect(restored).toContain("Your task list as you last saved it with update_tasks");
    expect(restored).toContain("Implement task restoration");
    const live = modelContext(session.history()).map(({ role, content }) => ({ role, content }));
    const file = session.file;
    await session.dispose();
    sessions.splice(0);
    const reopened = openSession(file, { models: model.models, model: model.model, verifier: accepts });
    sessions.push(reopened);
    expect(modelContext(reopened.history()).map(({ role, content }) => ({ role, content }))).toEqual(live);
  });
});
