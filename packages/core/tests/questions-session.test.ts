import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";
import { readSessionFile } from "../src/session-file.ts";
import type { QuestionSubmit } from "../src/questions.ts";
import { Type } from "typebox";
import { accepts, scriptedReply } from "./scripted.ts";
import type { ScriptStep } from "./engine.ts";
import { askTool } from "../src/tools/ask.ts";

const questions = [{ question: "Which behavior?", options: [
  { label: "A", description: "Use behavior A." }, { label: "B", description: "Use behavior B." },
] }];
const sessions: EngineSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.dispose())); });

function models(script: readonly ScriptStep[]): Pick<SessionOptions, "models" | "model" | "verifier"> {
  const provider = fauxProvider();
  provider.setResponses(script.map(scriptedReply));
  const registry = createModels();
  registry.setProvider(provider.provider);
  return { models: registry, model: provider.getModel(), verifier: accepts };
}

function start(script: readonly ScriptStep[], options: Partial<SessionOptions> = {}): EngineSession {
  const session = createSession({ cwd: mkdtempSync(join(tmpdir(), "tesota-question-project-")),
    folder: mkdtempSync(join(tmpdir(), "tesota-question-sessions-")), ...models(script), ...options });
  sessions.push(session);
  return session;
}

test("a question returns to the model before any remaining sibling call can change files", async () => {
  let observedRoles: string[] = [];
  let observedText = "";
  const session = start([{ calls: [
    { tool: "ask_user", args: { questions } }, { tool: "write", args: { path: "forbidden.txt", content: "bad" } },
  ] }, { seen: (context) => {
    observedText = JSON.stringify(context.messages);
    observedRoles = context.messages.map((message) => message.role);
  }, reply: "I will explain first." }], { questions: (_batch, submit) => {
    expect(submit([{ selected: [0], text: "Explain first; do not implement." }])).toBeUndefined();
    return () => undefined;
  } });
  await session.prompt("Help me choose.");
  expect(existsSync(join(session.workspace.cwd, "forbidden.txt"))).toBe(false);
  expect(observedText).toContain("Explain first; do not implement.");
  expect(observedRoles).toEqual(["system", "user", "assistant", "toolResult", "toolResult", "user"]);
  expect(session.outcome()).toBe("completed");
  const entries = readSessionFile(session.file).entries;
  expect(entries.filter((entry) => entry.type === "call_intent")).toHaveLength(1);
});

test("an invalid question batch is a failed call the model can correct, without opening a form", async () => {
  let opened = 0;
  const session = start([{ tool: "ask_user", args: { questions: [] } }, "I will ask a valid question."], {
    questions: () => { opened++; return () => undefined; },
  });
  await session.prompt("Ask me.");
  expect(session.outcome()).toBe("completed");
  expect(opened).toBe(0);
  expect(session.messages().filter((message) => message.role === "toolResult")).toMatchObject([{ isError: true }]);
  expect(session.ledger()[0]?.inputs).toEqual([]);
});

test("a request asks the operator at most three times, and the next request may ask again", async () => {
  const ask = { tool: "ask_user", args: { questions } };
  let opened = 0;
  const session = start([ask, ask, ask, ask, "decided", ask, "asked again"], {
    questions: (_batch, submit) => { opened++; submit([{ selected: [0] }]); return () => undefined; },
  });
  await session.prompt("Ask me.");
  expect(opened).toBe(3);
  const results = session.messages().filter((message) => message.role === "toolResult");
  expect(results.map((result) => result.isError)).toEqual([false, false, false, true]);
  expect(results[3]?.text).toContain("three times");
  expect(session.ledger()[0]?.inputs).toHaveLength(3);
  await session.prompt("Another request.");
  expect(opened).toBe(4);
});

test("only the exact native bridge is identified as a question for verification", async () => {
  for (const native of [false, true]) {
    let identified: boolean | undefined;
    const tool = native ? askTool({ ask: async () => ({ status: "unavailable", reason: "No shell." }) })
      : { name: "ask_user", access: "write" as const, description: "Custom writer", parameters: Type.Object({}),
        execute: async () => ({ text: "written", isError: false }) };
    const session = start([{ tool: "ask_user", args: native ? { questions } : {} }, "done"], {
      tools: () => [tool], verifier: (pi) => {
        pi.on("tool_execution_start", (event) => { identified = event.nativeQuestion; });
        accepts(pi);
      },
    });
    await session.prompt("Run the tool.");
    expect(identified).toBe(native);
  }
});

test("a reply that repeats a call id runs only the first, keeps its one result, and leaves the session usable", async () => {
  let opened = 0;
  const session = start([{ calls: [
    { tool: "write", args: { path: "first.txt", content: "one" }, id: "same" },
    { tool: "ask_user", args: { questions }, id: "same" },
  ] }, "done", "again"], { questions: () => { opened++; return () => undefined; } });
  await session.prompt("Write, then ask.");
  expect(session.outcome()).toBe("completed");
  expect(existsSync(join(session.workspace.cwd, "first.txt"))).toBe(true);
  expect(opened).toBe(0);
  expect(session.messages().filter((message) => message.role === "toolResult")).toMatchObject([{ toolName: "write", isError: false }]);
  await session.prompt("Go on.");
  expect(session.outcome()).toBe("completed");
  const messages = session.messages();
  await session.dispose();
  const reopened = openSession(session.file, models([]));
  sessions.push(reopened);
  expect(reopened.messages()).toEqual(messages);
});

test("reopening refuses an answer outside its recorded question instead of trusting malformed input", async () => {
  const session = start([{ tool: "ask_user", args: { questions } }, "done"], { questions: (_batch, submit) => {
    submit([{ selected: [0] }]); return () => undefined;
  } });
  await session.prompt("Choose.");
  await session.dispose();
  const saved = readSessionFile(session.file);
  const lines = [JSON.stringify(saved.header), ...saved.entries.map((entry) => JSON.stringify(entry.type === "clarification"
    ? { ...entry, clarification: { ...entry.clarification, answers: [{ selected: [99] }] } } : entry))];
  writeFileSync(session.file, `${lines.join("\n")}\n`);
  expect(() => readSessionFile(session.file)).toThrow("broken entry");
});

test("stopping while a question waits releases it and ends aborted without accepting a late answer", async () => {
  let ready = (): void => undefined;
  const registered = new Promise<void>((resolve) => { ready = resolve; });
  let lateSubmit: QuestionSubmit = () => "not registered";
  let released = 0;
  const session = start([{ tool: "ask_user", args: { questions } }, "must not run"], { questions: (_batch, submit) => {
    lateSubmit = submit; ready(); return () => { released++; };
  } });
  const completed = session.prompt("Ask me.").then(() => true, () => false);
  await registered;
  await session.abort();
  expect(await completed).toBe(true);
  expect(session.outcome()).toBe("aborted");
  expect(released).toBe(1);
  expect(lateSubmit([{ selected: [1] }])).toContain("no longer active");
  expect(session.ledger()[0]?.inputs).toEqual([]);
});

test("a submitted answer recovers once when the process ended before its ordinary tool result", async () => {
  const session = start([{ calls: [{ tool: "ask_user", args: { questions } },
    { tool: "read", args: { path: "anything" } }] }, "done"], { questions: (_batch, submit) => {
    submit([{ selected: [1], text: "Keep my exact words." }]); return () => undefined;
  } });
  await session.prompt("Choose.");
  await session.dispose();
  const saved = readSessionFile(session.file);
  const answered = saved.entries.findIndex((entry) => entry.type === "clarification");
  writeFileSync(session.file, `${[JSON.stringify(saved.header), ...saved.entries.slice(0, answered + 1).map((entry) => JSON.stringify(entry))].join("\n")}\n`);
  const reopened = openSession(session.file, models([]));
  sessions.push(reopened);
  expect(reopened.outcome()).toBe("interrupted");
  const results = reopened.messages().filter((message) => message.role === "toolResult");
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ toolName: "ask_user", isError: false });
  expect(results[0]?.text).toContain("Keep my exact words.");
  expect(results[1]).toMatchObject({ toolName: "read", isError: true });
  expect(reopened.messages().map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
  await reopened.dispose();
  const again = openSession(session.file, models([]));
  sessions.push(again);
  expect(again.messages()).toEqual(reopened.messages());
});

test.each(["append", "sync", "release"] as const)("a question host %s failure prevents further runs and compaction", async (failure) => {
  let rejectSync = false;
  let released = 0;
  const session = start([{ tool: "ask_user", args: { questions } }, "must not run"], {
    writer: (writer) => ({
      append(entry) {
        if (entry.type === "clarification") {
          if (failure === "append") throw new Error("question storage failed");
          rejectSync = failure === "sync";
        }
        writer.append(entry);
      },
      sync() { if (rejectSync) throw new Error("question storage failed"); writer.sync(); },
      close() { writer.close(); },
    }),
    questions: (_batch, submit) => {
      submit([{ selected: [0] }]);
      return () => { released++; if (failure === "release") throw new Error("question release failed"); };
    },
  });
  await expect(session.prompt("Ask me.")).rejects.toThrow(/question (storage|release) failed/u);
  expect(session.outcome()).toBe("error");
  expect(released).toBe(1);
  expect(session.lastAssistantText()).not.toBe("must not run");
  await expect(session.prompt("Try again.")).rejects.toThrow(/question (storage|release) failed/u);
  await expect(session.compact()).rejects.toThrow(/question (storage|release) failed/u);
  if (failure !== "release") expect(session.ledger()[0]?.inputs).toEqual([]);
});

test("an amendment accepted before an answer stays before it in model context and after resume", async () => {
  let ready = (): void => undefined;
  const registered = new Promise<void>((resolve) => { ready = resolve; });
  let submitAnswer: QuestionSubmit = () => "not registered";
  let seen: string[] = [];
  const session = start([{ tool: "ask_user", args: { questions } }, { seen: (context) => {
    seen = context.messages.flatMap((message) => message.role === "user" && typeof message.content === "string" ? [message.content] : []);
  }, reply: "done" }], { questions: (_batch, submit) => { submitAnswer = submit; ready(); return () => undefined; } });
  const completion = session.prompt("Choose.");
  await registered;
  await session.prompt("Earlier amendment.", { streamingBehavior: "steer" });
  submitAnswer([{ selected: [1], text: "Later answer." }]);
  await completion;
  expect(seen).toHaveLength(3);
  expect(seen[0]).toBe("Choose.");
  expect(seen[1]).toBe("Earlier amendment.");
  expect(seen[2]).toContain("Later answer.");
  const history = session.messages();
  await session.dispose();
  const reopened = openSession(session.file, models([]));
  sessions.push(reopened);
  expect(reopened.messages()).toEqual(history);
});

test.each(["read", "ask", "full"] as const)("a question has read access in %s mode", async (mode) => {
  const session = start([{ tool: "ask_user", args: { questions } }, "done"], {
    permissions: { mode: () => mode, rules: [] }, questions: (_batch, submit) => {
      submit([{ selected: [], text: "My own answer." }]); return () => undefined;
    },
  });
  await session.prompt("Ask me.");
  expect(session.outcome()).toBe("completed");
  expect(session.ledger()[0]?.inputs).toMatchObject([{ kind: "clarification" }]);
});

test("denying the question tool does not open a form or acquire operator authority", async () => {
  let opened = false;
  const session = start([{ tool: "ask_user", args: { questions } }, "done"], {
    permissions: { mode: () => "full", rules: [{ tool: "ask_user", pattern: undefined, verdict: "deny" }] },
    questions: () => { opened = true; return () => undefined; },
  });
  await session.prompt("Ask me.");
  expect(opened).toBe(false);
  expect(session.ledger()[0]?.inputs).toEqual([]);
});

test.each(["cancelled", "unavailable"] as const)("%s questions return a no-answer result and never a request constraint", async (status) => {
  let released = 0;
  const session = start([{ tool: "ask_user", args: { questions } }, "done"], status === "unavailable" ? {} : {
    questions: (_batch, _submit, finish) => { finish({ status, reason: "The operator dismissed the questions." }); return () => { released++; }; },
  });
  await session.prompt("Ask me.");
  expect(session.outcome()).toBe("completed");
  expect(session.ledger()[0]?.inputs).toEqual([]);
  expect(session.messages().filter((message) => message.role === "toolResult")).toMatchObject([{ isError: true }]);
  expect(released).toBe(status === "cancelled" ? 1 : 0);
});

test("a custom tool sharing the question name does not gain the native host's error policy", async () => {
  const session = start([{ tool: "ask_user", args: {} }, "recovered"], { tools: () => [{ name: "ask_user", access: "read",
    description: "A custom tool", parameters: Type.Object({}), execute: async () => { throw new Error("custom failure"); } }] });
  await session.prompt("Use the custom tool.");
  expect(session.outcome()).toBe("completed");
  expect(session.lastAssistantText()).toBe("recovered");
  expect(session.ledger()[0]?.inputs).toEqual([]);
});
