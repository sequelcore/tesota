import { type AssistantMessage, type Context, createModels, InMemoryCredentialStore, type JsonObject, fauxAssistantMessage, fauxProvider,
  fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noEvidence, type Receipt, receiptEntry } from "../../../src/receipt.ts";
import { agentTypes, agentTypesIn, unusedModels } from "../src/agents.ts";
import { childLimits } from "../src/children.ts";
import { configHooks, installedGit } from "../src/workspace.ts";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";
import { lastFloorNotice, readSessionFile, type SessionEntry } from "../src/session-file.ts";
import { accepts, signInWithChatGPT } from "./scripted.ts";

/**
 * Subagents (#525): the `agent` tool starts a child session as a job of the
 * run, in the background or waited for; a run never settles while its jobs
 * run; children read the parent's folder or write in a worktree of their
 * own and end with their own receipt; depth, limits, permissions, stopping
 * and recovery hold.
 */
const open: EngineSession[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const folder = (prefix = "tesota-agents-"): string => mkdtempSync(join(tmpdir(), prefix));

type Reply = string | { readonly calls: readonly { readonly tool: string; readonly args: JsonObject }[] }
  | ((context: Context) => AssistantMessage | Promise<AssistantMessage>);

const asMessage = (reply: Exclude<Reply, (context: Context) => unknown>): AssistantMessage => typeof reply === "string"
  ? fauxAssistantMessage(reply)
  : fauxAssistantMessage(reply.calls.map(({ tool, args }) => fauxToolCall(tool, args)), { stopReason: "toolUse" });

const textOf = (content: Context["messages"][number]["content"]): string => typeof content === "string" ? content
  : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");

/**
 * One scripted model for a session and its children: each reply comes from
 * the script of the session's request, its first message, so sessions
 * running at once each follow their own.
 */
function routed(scripts: Record<string, Reply[]>): Pick<SessionOptions, "models" | "model"> {
  const faux = fauxProvider();
  const reply = async (context: Context): Promise<AssistantMessage> => {
    const request = textOf(context.messages.find((message) => message.role === "user")?.content ?? "");
    const step = scripts[request]?.shift();
    if (step === undefined) throw new Error(`No reply left for "${request}".`);
    return typeof step === "function" ? await step(context) : asMessage(step);
  };
  faux.setResponses(Array.from({ length: 200 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() };
}

/** The system messages of what the model was asked: the prompt and the tools it was offered. */
const system = (context: Context): { content?: string; toolsAdded?: { name: string; description: string }[] }[] =>
  (context.messages as unknown as { role: string }[]).filter((message) => message.role === "system") as never;
const toolNames = (context: Context): string[] => system(context).flatMap(({ toolsAdded }) => (toolsAdded ?? []).map(({ name }) => name));
const promptOf = (context: Context): string => system(context).map(({ content }) => content ?? "").join("\n");

function session(scripts: Record<string, Reply[]>, options: Partial<SessionOptions> = {}): EngineSession {
  const created = createSession({ cwd: options.cwd ?? folder(), folder: folder("tesota-agents-sessions-"), verifier: accepts,
    ...routed(scripts), ...options });
  open.push(created);
  return created;
}

const entries = (file: string): readonly SessionEntry[] => readSessionFile(file).entries;

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
};

/** A repository with one commit. */
function repository(): string {
  const cwd = folder("tesota-agents-repo-");
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "start");
  return cwd;
}

describe("the agent tool", () => {
  test("a background child reads the parent's folder, and its report comes to the run as input, after its start was recorded", async () => {
    let childTools: string[] = [];
    const parent = session({
      "look around": [{ calls: [{ tool: "agent", args: { prompt: "find a.txt", description: "find the file" } }] }, "waiting for it",
        (context) => fauxAssistantMessage(`parent saw: ${textOf(context.messages.at(-1)?.content ?? "")
          .includes("found it in a.txt") ? "the report" : "nothing"}`)],
      "find a.txt": [(context) => { childTools = toolNames(context); return fauxAssistantMessage("found it in a.txt"); }],
    });
    await parent.prompt("look around");
    expect(parent.lastAssistantText()).toBe("parent saw: the report");
    expect(parent.outcome()).toBe("completed");
    expect(childTools.sort()).toEqual(["agent", "find", "grep", "ls", "read"]);
    const written = entries(parent.file);
    const start = written.findIndex((entry) => entry.type === "job_start");
    const end = written.findIndex((entry) => entry.type === "job_end");
    expect(start).toBeGreaterThan(written.findIndex((entry) => entry.type === "call_intent"));
    expect(end).toBeGreaterThan(start);
    // The run settles only after the job ended.
    expect(written.findIndex((entry) => entry.type === "settle")).toBeGreaterThan(end);
    const job = written[start] as Extract<SessionEntry, { type: "job_start" }>;
    const child = readSessionFile(job.session);
    expect(child.header.parent).toEqual({ session: parent.file.replace(/^.*[\\/]/u, "").replace(".jsonl", ""), job: job.job, depth: 1 });
    expect(child.header.cwd).toBe(parent.workspace.cwd);
    expect(child.header.worktree).toBeUndefined();
    expect(parent.history().filter((message) => message.role === "custom").map((message) => message.role === "custom" && message.customType))
      .toEqual(["tesota.job"]);
    expect(parent.ledger()[0]?.children).toMatchObject([{ description: "find the file", outcome: "completed", writes: false }]);
  });

  test("with wait, the call returns the child's report and nothing comes later", async () => {
    const parent = session({
      "ask a child": [{ calls: [{ tool: "agent", args: { prompt: "say hi", description: "greet", wait: true } }] }, "done"],
      "say hi": ["hi from the child"],
    });
    await parent.prompt("ask a child");
    const result = parent.history().find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" && textOf(result.content)).toContain("hi from the child");
    expect(parent.history().some((message) => message.role === "custom")).toBe(false);
    expect(entries(parent.file).filter((entry) => entry.type === "job_end")).toHaveLength(1);
  });

  test("several in one reply run at once", async () => {
    let releaseFirst: () => void = () => undefined;
    const second = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const parent = session({
      "fan out": [{ calls: [{ tool: "agent", args: { prompt: "one", description: "first" } },
        { tool: "agent", args: { prompt: "two", description: "second" } }] }, "waiting", "got one", "got both"],
      // The first child answers only once the second has asked: run one after the other, they would never end.
      one: [async () => { await second; return fauxAssistantMessage("first done"); }],
      two: [() => { releaseFirst(); return fauxAssistantMessage("second done"); }],
    });
    await parent.prompt("fan out");
    expect(parent.outcome()).toBe("completed");
    expect(entries(parent.file).filter((entry) => entry.type === "job_end").map((entry) => entry.type === "job_end" && entry.outcome))
      .toEqual(["completed", "completed"]);
  });

  test("a child one below the top starts its own, and that one has no agent tool", async () => {
    let grandchildTools: string[] = [];
    const parent = session({
      top: [{ calls: [{ tool: "agent", args: { prompt: "coordinate", description: "coordinator", wait: true } }] }, "top done"],
      coordinate: [{ calls: [{ tool: "agent", args: { prompt: "work", description: "worker", wait: true } }] }, "coordinated"],
      work: [(context) => { grandchildTools = toolNames(context); return fauxAssistantMessage("worked"); }],
    });
    await parent.prompt("top");
    expect(parent.lastAssistantText()).toBe("top done");
    expect(grandchildTools).not.toContain("agent");
    const coordinator = entries(parent.file).find((entry) => entry.type === "job_start");
    const worker = entries((coordinator as Extract<SessionEntry, { type: "job_start" }>).session).find((entry) => entry.type === "job_start");
    expect(readSessionFile((worker as Extract<SessionEntry, { type: "job_start" }>).session).header.parent?.depth).toBe(2);
  });

  test("a writing child works in a worktree of its own and its branch and receipt reach the parent", async () => {
    const cwd = repository();
    const receipt: Receipt = { version: 2, repository: true, base: null, startedAt: "2026-10-21T00:00:00.000Z",
      settledAt: "2026-10-21T00:00:01.000Z", engine: "test", ...noEvidence };
    const verifier: SessionOptions["verifier"] = (pi, request) => {
      pi.on("agent_before_settle", (_event, ctx) => request()?.text === "write b.txt" ? { entries: [receiptEntry(ctx.mode, receipt)] } : undefined);
    };
    let childCwd = "";
    const parent = session({
      delegate: [{ calls: [{ tool: "agent", args: { prompt: "write b.txt", description: "write b", writes: true, wait: true } }] }, "done"],
      "write b.txt": [(context) => { childCwd = /working in (.+?)\. /u.exec(promptOf(context))?.[1] ?? ""; return asMessage(
        { calls: [{ tool: "write", args: { path: "b.txt", content: "b\n" } }] }); }, "wrote b.txt"],
    }, { cwd, verifier, permissions: { mode: () => "full", rules: [] }, branchGuard: "warn" });
    await parent.prompt("delegate");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
    expect(childCwd).not.toBe(parent.workspace.cwd);
    expect(readFileSync(join(childCwd, "b.txt"), "utf8")).toBe("b\n");
    const [child] = parent.ledger()[0]?.children ?? [];
    expect(child).toMatchObject({ description: "write b", writes: true, outcome: "completed", verification: "verified" });
    expect(child?.branch).toMatch(/^tesota\//u);
    const result = parent.history().find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" && textOf(result.content)).toContain("Tesota receipt");
    expect(git(cwd, "branch", "--list", child?.branch ?? "")).toContain(child?.branch ?? "missing");
  });

  test("what the floor refused a child reaches its parent's result, ledger and end, and binds the parent too (#622)", async () => {
    const cwd = repository();
    let told = "";
    const parent = session({
      delegate: [{ calls: [{ tool: "agent", args: { prompt: "clean up", description: "clean up", writes: true, wait: true } }] }, "done"],
      "clean up": [{ calls: [{ tool: "write", args: { path: "../outside.txt", content: "x" } }] },
        (context) => { told = textOf(context.messages.at(-1)?.content ?? ""); return fauxAssistantMessage("couldn't"); }],
    }, { cwd, permissions: { mode: () => "full", rules: [] }, branchGuard: "warn" });
    await parent.prompt("delegate");
    // A child has no one to ask, so it is told to say so in its final reply.
    expect(told).toContain("If the work needs it, say so in your final reply.");
    expect(parent.ledger()[0]?.children[0]).toMatchObject({ description: "clean up", floorRefusals: 1 });
    const result = parent.history().find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" && textOf(result.content)).toContain("Tesota's floor refused 1 of its calls");
    expect(lastFloorNotice(readSessionFile(parent.file).entries)).toContain("its subagents: 1 call, listed in their own sessions");
  });

  // #619: a writing child's branch is guarded by Git's configuration hooks, which came in Git 2.54.
  const guarding = configHooks(installedGit());
  const shellTool = process.platform === "win32" ? "powershell" : "bash";

  test.skipIf(guarding)("on a Git without configuration hooks, a writing child starts only if the operator said to warn (#619)", async () => {
    const delegate = (): Record<string, Reply[]> => ({ delegate: [{ calls: [{ tool: "agent",
      args: { prompt: "write b.txt", description: "write b", writes: true, wait: true } }] }, "done"], "write b.txt": ["wrote nothing"] });
    const required = session(delegate(), { cwd: repository(), permissions: { mode: () => "full", rules: [] } });
    await required.prompt("delegate");
    const refusal = required.history().find((message) => message.role === "toolResult");
    expect(refusal?.role === "toolResult" && textOf(refusal.content)).toContain("a subagent that writes needs Git 2.54 or later");
    expect(required.ledger()[0]?.children).toEqual([]);
    const warned = session(delegate(), { cwd: repository(), permissions: { mode: () => "full", rules: [] }, branchGuard: "warn" });
    await warned.prompt("delegate");
    expect(warned.ledger()[0]?.children[0]).toMatchObject({ description: "write b", unguarded: true });
    const result = warned.history().find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" && textOf(result.content)).toContain("It ran without Git's guard on its branch");
  });

  test.skipIf(!guarding)("a writing child moves only its own branch, never one another worktree has checked out (#619)", async () => {
    const cwd = repository();
    git(cwd, "branch", "shared");
    const other = folder("tesota-agents-other-");
    git(cwd, "worktree", "add", "-q", join(other, "shared"), "shared");
    const before = git(cwd, "rev-parse", "shared");
    let said = "";
    const parent = session({
      delegate: [{ calls: [{ tool: "agent", args: { prompt: "work", description: "work", writes: true, wait: true } }] }, "done"],
      work: [{ calls: [{ tool: shellTool, args: { command: "git commit -q --allow-empty -m own" } }] },
        { calls: [{ tool: shellTool, args: { command: "git switch -q --ignore-other-worktrees shared; git commit -q --allow-empty -m moved" } }] },
        (context) => { said = textOf(context.messages.at(-1)?.content ?? ""); return fauxAssistantMessage("done"); }],
    }, { cwd, permissions: { mode: () => "full", rules: [] } });
    await parent.prompt("delegate");
    expect(said).toContain("Tesota: this subagent may move only its own branch");
    expect(git(cwd, "rev-parse", "shared")).toBe(before);
    const [child] = parent.ledger()[0]?.children ?? [];
    expect(child?.unguarded).toBeUndefined();
    // Its own branch moved, and the parent can still bring its work in.
    expect(git(cwd, "log", "--format=%s", "-1", child?.branch ?? "missing")).toBe("own");
    git(cwd, "merge", "-q", "--ff-only", child?.branch ?? "missing");
    expect(git(cwd, "log", "--format=%s", "-1")).toBe("own");
  });

  test("a read-only session starts no writing child, and a reader is read only whatever the mode", async () => {
    let readerTools: string[] = [];
    const parent = session({
      "try both": [{ calls: [{ tool: "agent", args: { prompt: "write", description: "writer", writes: true } },
        { tool: "agent", args: { prompt: "read", description: "reader", wait: true } }] }, "done"],
      read: [(context) => { readerTools = toolNames(context); return fauxAssistantMessage("read"); }],
    }, { permissions: { mode: () => "read", rules: [] } });
    await parent.prompt("try both");
    const results = parent.history().flatMap((message) => message.role === "toolResult" ? [textOf(message.content)] : []);
    expect(results[0]).toContain("Not started: the session is read only");
    expect(results[1]).toContain("read");
    expect(readerTools).not.toContain("write");
  });

  test("no more children start than the tree's limit", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const parent = session({
      many: [{ calls: [{ tool: "agent", args: { prompt: "held", description: "first" } },
        { tool: "agent", args: { prompt: "other", description: "second" } }] },
      (context) => { release(); return fauxAssistantMessage(textOf(context.messages.at(-1)?.content ?? "").slice(0, 20)); }, "done"],
      held: [async () => { await held; return fauxAssistantMessage("held done"); }],
    }, { agentLimit: 1 });
    await parent.prompt("many");
    const results = parent.history().flatMap((message) => message.role === "toolResult" ? [textOf(message.content)] : []);
    expect(results[0]).toContain("in the background");
    expect(results[1]).toContain("1 subagents already run");
  });

  test("an unknown type or model is refused, naming what there is", async () => {
    const parent = session({
      wrong: [{ calls: [{ tool: "agent", args: { prompt: "x", description: "x", type: "nobody" } },
        { tool: "agent", args: { prompt: "x", description: "x", model: "nowhere/none" } }] }, "done"],
    });
    await parent.prompt("wrong");
    const results = parent.history().flatMap((message) => message.role === "toolResult" ? [textOf(message.content)] : []);
    expect(results[0]).toContain("no agent type nobody");
    expect(results[1]).toContain("no model nowhere/none");
  });

  test("with ChatGPT sign-in, a model OpenAI has but the sign-in does not serve is refused, naming only those it serves (#563)", async () => {
    const scripted = routed({
      pick: [{ calls: [{ tool: "agent", args: { prompt: "x", description: "x", model: "openai/gpt-5.5" } }] }, "done"],
    });
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    for (const provider of scripted.models.getProviders()) models.setProvider(provider);
    const signOut = await signInWithChatGPT(models, credentials, ["gpt-6.1-sol"]);
    try {
      const parent = session({}, { models, model: scripted.model });
      await parent.prompt("pick");
      const result = parent.history().find((message) => message.role === "toolResult");
      const text = result?.role === "toolResult" ? textOf(result.content) : "";
      expect(text).toContain("Not started: no model openai/gpt-5.5");
      expect(text).toContain("openai/gpt-6.1-sol");
      expect(text).not.toContain("openai/gpt-5.6-sol");
    } finally {
      signOut();
    }
  });

  test("with ChatGPT sign-in, a child's model the sign-in's list could not check is kept, saying why (#567)", async () => {
    const scripted = routed({
      pick: [{ calls: [{ tool: "agent", args: { prompt: "x", description: "x", model: "openai/gpt-6.1-sol", wait: true } }] }, "done"],
    });
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    for (const provider of scripted.models.getProviders()) models.setProvider(provider);
    const signOut = await signInWithChatGPT(models, credentials, "offline");
    try {
      const parent = session({}, { models, model: scripted.model });
      await parent.prompt("pick");
      const result = parent.history().find((message) => message.role === "toolResult");
      const text = result?.role === "toolResult" ? textOf(result.content) : "";
      expect(text).not.toContain("Not started");
      expect(text).toContain("openai/gpt-6.1-sol was not checked against the models the ChatGPT sign-in serves");
      // It started: offline, its request itself fails.
      expect(text).toContain("ended error");
    } finally {
      signOut();
    }
  });

  test("a child whose model request fails gives the parent the reason its run ended (#564)", async () => {
    const failed = "OpenAI API error (400): The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
    const parent = session({
      delegate: [{ calls: [{ tool: "agent", args: { prompt: "fail", description: "fails", wait: true } }] }, "done"],
      fail: [() => fauxAssistantMessage("", { stopReason: "error", errorMessage: failed })],
    });
    await parent.prompt("delegate");
    const result = parent.history().find((message) => message.role === "toolResult");
    const text = result?.role === "toolResult" ? textOf(result.content) : "";
    expect(text).toContain("ended error");
    expect(text).toContain(`It failed: ${failed}`);
  });

  test("stopping the run stops its children, and their ends are recorded before it ends", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const parent = session({
      stop: [{ calls: [{ tool: "agent", args: { prompt: "forever", description: "never ends" } }] }, "waiting"],
      forever: [(context) => { started(); return new Promise<AssistantMessage>(() => undefined).finally(() => context); }],
    });
    const prompted = parent.prompt("stop");
    await running;
    await parent.abort();
    await prompted.catch(() => undefined);
    expect(parent.outcome()).toBe("aborted");
    const written = entries(parent.file);
    const end = written.find((entry) => entry.type === "job_end");
    expect(end?.type === "job_end" && end.outcome).toBe("aborted");
    expect(written.findIndex((entry) => entry.type === "job_end")).toBeLessThan(written.findIndex((entry) => entry.type === "run_end"));
  });

  test("a child that passes its turn limit is stopped, saying so", async () => {
    const turns = childLimits.turns;
    childLimits.turns = 1;
    try {
      const parent = session({
        busy: [{ calls: [{ tool: "agent", args: { prompt: "loop", description: "loops", wait: true } }] }, "done"],
        loop: [{ calls: [{ tool: "ls", args: {} }] }, { calls: [{ tool: "ls", args: {} }] }, "never reached"],
      });
      await parent.prompt("busy");
      const result = parent.history().find((message) => message.role === "toolResult");
      expect(result?.role === "toolResult" && textOf(result.content)).toContain("its limit");
      expect(parent.ledger()[0]?.children[0]?.outcome).toBe("aborted");
    } finally {
      childLimits.turns = turns;
    }
  });
});

describe("recovery", () => {
  test("killed while a subagent runs, its job ends outcome unknown, its session interrupted, and recovering twice adds nothing", async () => {
    const cwd = folder();
    const sessions = folder("tesota-agents-sessions-");
    const running = Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), "agent", cwd, sessions], { stdout: "pipe", stderr: "inherit" });
    try {
      let printed = "";
      const decoder = new TextDecoder();
      for await (const chunk of running.stdout) {
        printed += decoder.decode(chunk);
        if (printed.includes("child running")) break;
      }
      running.kill("SIGKILL");
      await running.exited;
      const file = readFileSync(join(sessions, "file.txt"), "utf8");
      const job = entries(file).find((entry) => entry.type === "job_start");
      if (job?.type !== "job_start") throw new Error("The job's start was not recorded before it ran");
      const resumed = openSession(file, { ...routed({}), verifier: accepts });
      open.push(resumed);
      expect(entries(file).filter((entry) => entry.type === "job_end")).toMatchObject([{ job: job.job, outcome: "unknown" }]);
      expect(resumed.history().at(-1)).toMatchObject({ role: "custom", customType: "tesota.job" });
      expect(entries(job.session).at(-1)).toMatchObject({ type: "run_end", outcome: "interrupted" });
      const once = [readFileSync(file, "utf8"), readFileSync(job.session, "utf8")];
      await resumed.dispose();
      open.push(openSession(file, { ...routed({}), verifier: accepts }));
      expect([readFileSync(file, "utf8"), readFileSync(job.session, "utf8")]).toEqual(once);
    } finally {
      running.kill("SIGKILL");
    }
  });

  test("a job the session was running ends outcome unknown, and its child's session ends interrupted", () => {
    const sessions = folder("tesota-agents-sessions-");
    const cwd = folder();
    const child = join(sessions, "child.jsonl");
    const base = { units: [] };
    const header = (id: string, extra: object) => JSON.stringify({ type: "session", format: "tesota-session", version: 6, id, cwd,
      createdAt: new Date(0).toISOString(), ...extra });
    writeFileSync(child, [header("child", { parent: { session: "parent", job: "j1", depth: 1 } }),
      JSON.stringify({ type: "request", run: 1, text: "work", origin: "rpc", at: new Date(0).toISOString(), base }), ""].join("\n"));
    const call = fauxToolCall("agent", { prompt: "work", description: "worker" }, { id: "c1" });
    const reply = fauxAssistantMessage([call], { stopReason: "toolUse" });
    const parentFile = join(sessions, "parent.jsonl");
    writeFileSync(parentFile, [header("parent", {}),
      JSON.stringify({ type: "request", run: 1, text: "top", origin: "interactive", at: new Date(0).toISOString(), base }),
      JSON.stringify({ type: "assistant", run: 1, message: reply }),
      JSON.stringify({ type: "call_intent", run: 1, callId: "c1", access: "read" }),
      JSON.stringify({ type: "job_start", run: 1, job: "j1", callId: "c1", kind: "agent", description: "worker", background: true,
        session: child, details: { description: "worker", outcome: "running", session: child, writes: false } }),
      JSON.stringify({ type: "tool_result", run: 1, message: { role: "toolResult", toolCallId: "c1", toolName: "agent",
        content: [{ type: "text", text: "Started" }], isError: false, timestamp: 0 } }), ""].join("\n"));
    const resumed = openSession(parentFile, { ...routed({}), verifier: accepts });
    open.push(resumed);
    const ended = entries(parentFile).find((entry) => entry.type === "job_end");
    expect(ended).toMatchObject({ type: "job_end", job: "j1", outcome: "unknown" });
    expect(resumed.ledger()[0]?.children).toMatchObject([{ description: "worker", outcome: "unknown" }]);
    expect(entries(child).at(-1)).toMatchObject({ type: "run_end", outcome: "interrupted" });
    expect(resumed.outcome()).toBe("interrupted");
  });
});

describe("agent types", () => {
  test("Claude Code's format, pstack's is_background, and the nearer folder wins by name", () => {
    const home = folder("tesota-agents-home-");
    const project = folder("tesota-agents-project-");
    mkdirSync(join(home, ".agents", "agents"), { recursive: true });
    mkdirSync(join(project, ".agents", "agents"), { recursive: true });
    writeFileSync(join(home, ".agents", "agents", "helper.md"), "---\nname: helper\ndescription: The operator's helper\n---\nHome body\n");
    writeFileSync(join(project, ".agents", "agents", "helper.md"), "---\nname: helper\ndescription: >\n  The project's\n  helper\n"
      + "model: sonnet\nis_background: false\nwrites: true\ntools: Read, Grep\n---\nProject body\n");
    writeFileSync(join(project, ".agents", "agents", "notes.txt"), "not a type");
    const [helper] = agentTypes(project, { user: home, tesota: folder("tesota-agents-tesota-") });
    expect(helper).toEqual({ name: "helper", description: "The project's helper", path: join(project, ".agents", "agents", "helper.md"),
      instructions: "Project body", unusedModel: "model: sonnet", writes: true, background: false });
    expect(agentTypesIn(join(home, "missing"))).toEqual([]);
  });

  test("a type whose model Tesota does not run still loads, and the operator is told the model it runs on (#568)", () => {
    const types = folder("tesota-agents-models-");
    const type = (name: string, fields: string): void => {
      writeFileSync(join(types, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n${fields}---\nBody\n`);
    };
    type("routed", "model: openai/gpt-6.1-sol\nclaude.model: opus\n");
    type("inherits", "model: inherit\n");
    type("aliased", "model: sonnet\n");
    type("others", "claude.model: opus\ncodex.model: gpt-6-astra\ncodex.sandbox_mode: read-only\n");
    type("plain", "");
    const found = agentTypesIn(types).sort((a, b) => a.name.localeCompare(b.name));
    expect(found.map(({ name, model, unusedModel }) => [name, model, unusedModel])).toEqual([
      ["aliased", undefined, "model: sonnet"], ["inherits", undefined, undefined], ["others", undefined, "claude.model, codex.model"],
      ["plain", undefined, undefined], ["routed", "openai/gpt-6.1-sol", undefined],
    ]);
    expect(unusedModels(found, "openai/gpt-6.1-sol")).toBe("Agent types aliased (model: sonnet), others (claude.model, codex.model) "
      + "run on the session's model, openai/gpt-6.1-sol, unless the call names one: Tesota takes a type's model only as provider/id.");
    expect(unusedModels(found.filter(({ name }) => name === "others"), "openai/x")).toStartWith("Agent type others (claude.model, codex.model) runs");
    expect(unusedModels(found.filter(({ name }) => name !== "aliased" && name !== "others"), "openai/x")).toBeUndefined();
  });

  test("a child started with a type reads its body, and the parent's tool lists the types", async () => {
    const home = folder("tesota-agents-project-");
    mkdirSync(join(home, ".agents", "agents"), { recursive: true });
    writeFileSync(join(home, ".agents", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: A delegate\nis_background: true\n---\n"
      + "Read the poteto-mode skill first.\n");
    let childPrompt = "";
    let toolDescription = "";
    const parent = session({
      typed: [(context) => { toolDescription = system(context).flatMap(({ toolsAdded }) => toolsAdded ?? []).find(({ name }) => name === "agent")?.description ?? "";
        return asMessage({ calls: [{ tool: "agent", args: { prompt: "do it", description: "typed", type: "poteto-agent", wait: true } }] }); },
      "done"],
      "do it": [(context) => { childPrompt = promptOf(context); return fauxAssistantMessage("did it"); }],
    }, { cwd: home });
    await parent.prompt("typed");
    expect(toolDescription).toContain("- poteto-agent: A delegate");
    expect(childPrompt).toContain("Read the poteto-mode skill first.");
    expect(childPrompt).toContain("You are a subagent");
  });
});
