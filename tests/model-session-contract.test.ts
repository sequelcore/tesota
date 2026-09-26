import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager, type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ClaudeCodeSession } from "../src/integrations/claude-code-session.js";
import { type AgentActivity, type ConversationEntry, type ModelSession, type TurnResult,
  runWithTimeLimit } from "../src/integrations/model-session-contract.js";
import type { ModelTarget } from "../src/integrations/model-session.js";
import { CodingSession, readOnlyFileTools } from "../src/integrations/pi-coding-session.js";
import { NO_TOKENS, type TokenUsage, addTokens } from "../src/token-usage.js";

/**
 * The model-session contract (decision 022), held against every engine. Each
 * case scripts what the model does, step by step, and checks what a role can
 * observe. Pi runs for real on its scripted faux model. Claude Code's SDK is
 * replaced by a double that follows the SDK behavior observed live: tools run
 * through the in-process server, `canUseTool` refusals skip a call, and a
 * `PostToolBatch` hook answering `continue: false` ends the run with no
 * further model call. `model-session-contract.live.test.ts` checks the same
 * cases against the real engines.
 */

type ToolCall = Readonly<{ name: string; args: Parameters<typeof fauxToolCall>[1] }>;
type ModelStep = Readonly<{ tools: readonly ToolCall[] }> | Readonly<{ text: string }> | Readonly<{ fail: string }> | "hang";

// The Claude Agent SDK double: plays `sdk.steps` against the options a session passes, one model call per step.
const sdk = vi.hoisted(() => ({ steps: [] as unknown[], calls: 0, conversations: new Set<string>(),
  last: undefined as { model?: string; resume?: string; effort?: string } | undefined }));
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  type Handler = { name: string; handler: (args: unknown) => Promise<unknown> };
  type Hook = (input: unknown, id: undefined, options: { signal: AbortSignal }) => Promise<{ continue?: boolean }>;
  type Options = { cwd: string; model?: string; resume?: string; sessionId?: string; effort?: string; tools?: string[]; mcpServers: { tesota: { tools: Handler[] } }; abortController: AbortController;
    canUseTool: (name: string, input: unknown, options: { signal: AbortSignal }) => Promise<{ behavior: string }>;
    hooks?: { PostToolBatch?: { hooks: Hook[] }[] } };
  const usage = { inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 300, cacheCreationInputTokens: 60 };
  const result = (fields: Record<string, unknown>, calls: number): Record<string, unknown> => ({ type: "result",
    modelUsage: { "claude-test": { inputTokens: usage.inputTokens * calls, outputTokens: usage.outputTokens * calls,
      cacheReadInputTokens: usage.cacheReadInputTokens * calls, cacheCreationInputTokens: usage.cacheCreationInputTokens * calls } },
    ...fields });
  // Which model a query asked for, whether it resumed a conversation, and which conversations Claude Code now holds.
  function remember(options: Options): void {
    sdk.last = { ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.effort === undefined ? {} : { effort: options.effort }) };
    const conversation = options.resume ?? options.sessionId;
    if (conversation !== undefined) sdk.conversations.add(conversation);
  }
  // One tool call as Claude Code runs it: Tesota's tools through the in-process server, its own only if offered and allowed.
  async function runCall(options: Options, call: ToolCall, id: string) {
    const signal = options.abortController.signal;
    const tool = options.mcpServers.tesota.tools.find((entry) => entry.name === call.name);
    // A tool Tesota did not give is one of Claude Code's own, which the session must refuse.
    const name = tool === undefined ? call.name.charAt(0).toUpperCase() + call.name.slice(1) : `mcp__tesota__${call.name}`;
    // Claude Code offers its own tools unless `tools` leaves them out, and runs a call only when `canUseTool` allows it.
    const offered = tool !== undefined || options.tools === undefined || options.tools.includes(name);
    const permission = offered ? await options.canUseTool(name, call.args, { signal }) : { behavior: "deny" };
    if (permission.behavior === "allow") {
      if (tool !== undefined) await tool.handler(call.args);
      else if (name === "Write") writeFileSync(join(options.cwd, String(call.args["path"])), String(call.args["content"]));
    }
    return { tool_name: name, tool_input: call.args, tool_use_id: id,
      output: permission.behavior === "allow" && tool !== undefined ? "ran" : "refused" };
  }
  async function* play(options: Options): AsyncGenerator<Record<string, unknown>> {
    const signal = options.abortController.signal;
    remember(options);
    const hooks = options.hooks?.PostToolBatch?.flatMap((matcher) => matcher.hooks) ?? [];
    let calls = 0;
    for (const step of sdk.steps.splice(0) as ModelStep[]) {
      sdk.calls += 1;
      calls += 1;
      if (step === "hang") {
        await new Promise((settle) => { signal.addEventListener("abort", settle, { once: true }); });
        throw new Error("Claude Code process aborted by user");
      }
      if ("fail" in step) { yield result({ subtype: "error_during_execution", is_error: true, errors: [step.fail] }, calls); return; }
      if ("text" in step) {
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: step.text }] } };
        yield result({ subtype: "success", is_error: false, result: step.text }, calls);
        return;
      }
      const batch = [];
      for (const call of step.tools) batch.push(await runCall(options, call, `use-${sdk.calls}-${batch.length}`));
      yield { type: "assistant", parent_tool_use_id: null, message: { content: batch.map((entry) =>
        ({ type: "tool_use", id: entry.tool_use_id, name: entry.tool_name, input: entry.tool_input })) } };
      yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: batch.map((entry) =>
        ({ type: "tool_result", tool_use_id: entry.tool_use_id, content: [{ type: "text", text: entry.output }] })) } };
      let stop = false;
      for (const hook of hooks) {
        if ((await hook({ hook_event_name: "PostToolBatch", tool_calls: batch }, undefined, { signal })).continue === false) stop = true;
      }
      if (stop) { yield result({ subtype: "success", is_error: false, result: "" }, calls); return; }
    }
    yield result({ subtype: "success", is_error: false, result: "" }, calls);
  }
  return {
    tool: (name: string, _description: string, _shape: unknown, handler: (args: unknown) => Promise<unknown>) => ({ name, handler }),
    createSdkMcpServer: (server: unknown) => server,
    getSessionInfo: async (id: string) => sdk.conversations.has(id) ? { sessionId: id } : undefined,
    // A kept conversation, as Claude Code saved it: the raw messages of its earlier turns.
    getSessionMessages: async (id: string) => sdk.conversations.has(id) ? [
      { type: "user", parent_tool_use_id: null, message: { role: "user", content: "The earlier request." } },
      { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
    ] : [],
    query: ({ options }: { options: Options }) => play(options),
  };
});

interface Observed {
  readonly activity: AgentActivity[];
  usage: TokenUsage;
}

interface EngineHarness {
  readonly engine: string;
  /** What the model does next, one step per model call. */
  script(steps: readonly ModelStep[]): void;
  modelCalls(): number;
  start(root: string, tools: readonly ToolDefinition[], observed: Observed, conversation?: Conversation): Promise<WorkingSession>;
  /** Another model on the same engine. */
  other(): ModelTarget;
  /** The model and reasoning level the last model call used, and whether it saw the conversation's earlier request. */
  lastCall(): Readonly<{ model: string; continued: boolean; reasoning: string | undefined }> | undefined;
}

/** A conversation kept across sessions: Pi's session manager, or Claude Code's conversation id. */
type Conversation = Readonly<{ piManager: SessionManager; id: string }>;
type WorkingSession = ModelSession & Readonly<{ resumed: boolean; switchModel(target: ModelTarget): Promise<void>;
  conversation(): Promise<readonly ConversationEntry[]> }>;

function piHarness(): EngineHarness {
  const faux = fauxProvider({ models: [{ id: "scripted", reasoning: true }, { id: "other", reasoning: true }] });
  let runtime: ModelRuntime | undefined;
  let last: { model: string; continued: boolean; reasoning: string | undefined } | undefined;
  const response = (step: ModelStep): FauxResponseStep => {
    if (step === "hang") {
      return (_context, options) => new Promise((settle) => {
        options?.signal?.addEventListener("abort", () => { settle(fauxAssistantMessage("", { stopReason: "aborted" })); }, { once: true });
      });
    }
    if ("fail" in step) return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.fail });
    if ("text" in step) return fauxAssistantMessage([fauxText(step.text)]);
    return fauxAssistantMessage(step.tools.map((call) => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" });
  };
  return {
    engine: "Pi",
    script(steps) {
      faux.setResponses(steps.map((step): FauxResponseStep => {
        const base = response(step);
        return (context, options, state, model) => {
          last = { model: model.id, continued: context.messages.some((message) => message.role === "user" &&
            JSON.stringify(message.content).includes("earlier request")), reasoning: options?.reasoning };
          return typeof base === "function" ? base(context, options, state, model) : base;
        };
      }));
    },
    modelCalls: () => faux.state.callCount,
    other: () => {
      const model = runtime?.getModel(faux.provider.id, "other");
      if (runtime === undefined || model === undefined) throw new Error("The other model is missing");
      return { engine: "pi", modelRuntime: runtime, model, reasoning: "high" };
    },
    lastCall: () => last,
    async start(root, tools, observed, conversation) {
      runtime ??= await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false,
        allowModelNetwork: false });
      runtime.registerNativeProvider(faux.provider);
      const model = runtime.getModel(faux.provider.id, "scripted");
      if (model === undefined) throw new Error("The scripted model is missing");
      return CodingSession.start({ cwd: root, modelRuntime: runtime, model, systemPrompt: "You test.", tools,
        ...(conversation === undefined ? {} : { sessionManager: conversation.piManager }),
        onActivity: (entry) => { observed.activity.push(entry); },
        onUsage: (usage) => { observed.usage = addTokens(observed.usage, usage); } });
    },
  };
}

function claudeCodeHarness(): EngineHarness {
  sdk.calls = 0;
  return {
    engine: "Claude Code",
    script(steps) { sdk.steps = [...steps]; },
    modelCalls: () => sdk.calls,
    other: () => ({ engine: "claude-code", model: "other", reasoning: "high" }),
    lastCall: () => sdk.last === undefined ? undefined
      : { model: sdk.last.model ?? "", continued: sdk.last.resume !== undefined, reasoning: sdk.last.effort },
    start: (root, tools, observed, conversation) => ClaudeCodeSession.start({ cwd: root, model: "test", systemPrompt: "You test.", tools,
      ...(conversation === undefined ? {} : { conversationId: conversation.id }),
      onActivity: (entry) => { observed.activity.push(entry); },
      onUsage: (usage) => { observed.usage = addTokens(observed.usage, usage); } }),
  };
}

// A role's submission: recorded, then the turn ends, as Tesota's submit tools do.
function submitTool(submitted: string[]): ToolDefinition {
  return defineTool({ name: "submit", label: "Submit", description: "Submit the answer once.",
    parameters: Type.Object({ answer: Type.String() }),
    execute: async (_id, params) => {
      submitted.push(params.answer);
      return { content: [{ type: "text", text: "Recorded." }], details: undefined, terminate: true };
    } });
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-contract-"));
  roots.push(root);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  return root;
}

const running = (): AbortSignal => new AbortController().signal;

describe.each([{ harness: piHarness }, { harness: claudeCodeHarness }])("the model-session contract", ({ harness }) => {
  async function open(tools: (root: string) => readonly ToolDefinition[], steps: readonly ModelStep[]) {
    const engine = harness();
    const root = checkout();
    const observed: Observed = { activity: [], usage: NO_TOKENS };
    engine.script(steps);
    const session = await engine.start(root, tools(root), observed);
    return { engine, root, observed, session };
  }

  it(`completes with the model's last reply, reporting tool activity (${harness().engine})`, async () => {
    const { session, observed } = await open(readOnlyFileTools, [{ tools: [{ name: "read", args: { path: "a.ts" } }] }, { text: "a is 1." }]);
    expect(await session.run("What is a?", running())).toEqual({ status: "completed", reply: "a is 1." });
    expect(observed.activity).toContainEqual(expect.objectContaining({ type: "tool_started", tool: "read", subject: "a.ts" }));
    expect(observed.activity).toContainEqual(expect.objectContaining({ type: "tool_finished", failed: false }));
  });

  it(`ends the turn after a batch in which every tool asked to, with no further model call (${harness().engine})`, async () => {
    const submitted: string[] = [];
    const { session, engine } = await open((root) => [...readOnlyFileTools(root), submitTool(submitted)],
      [{ tools: [{ name: "submit", args: { answer: "42" } }] }, { text: "I submitted 42." }]);
    const turn = await session.run("Submit the answer.", running());
    expect(turn.status).toBe("completed");
    expect(submitted).toEqual(["42"]);
    expect(engine.modelCalls()).toBe(1);
  });

  it(`continues after a batch in which some tool did not ask to end the turn (${harness().engine})`, async () => {
    const submitted: string[] = [];
    const { session, engine } = await open((root) => [...readOnlyFileTools(root), submitTool(submitted)],
      [{ tools: [{ name: "submit", args: { answer: "42" } }, { name: "read", args: { path: "a.ts" } }] }, { text: "Done." }]);
    expect(await session.run("Submit the answer.", running())).toEqual({ status: "completed", reply: "Done." });
    expect(engine.modelCalls()).toBe(2);
  });

  it(`never runs a tool it was not given (${harness().engine})`, async () => {
    const { session, root } = await open(readOnlyFileTools,
      [{ tools: [{ name: "write", args: { path: "b.ts", content: "x" } }] }, { text: "I could not write." }]);
    expect((await session.run("Write b.ts.", running())).status).toBe("completed");
    expect(existsSync(join(root, "b.ts"))).toBe(false);
  });

  it(`reports the engine's failure with its message, never as completed (${harness().engine})`, async () => {
    const { session } = await open(readOnlyFileTools, [{ fail: "invalid_request_error: the prompt is malformed" }]);
    const turn: TurnResult = await session.run("Go.", running());
    expect(turn.status === "failed" && turn.reason).toContain("the prompt is malformed");
  });

  it(`stops when the caller cancels, and times out when its limit stops it (${harness().engine})`, async () => {
    const stop = new AbortController();
    const cancelled = await open(readOnlyFileTools, ["hang"]);
    setTimeout(() => { stop.abort(); }, 20);
    expect(await cancelled.session.run("Go.", stop.signal)).toEqual({ status: "cancelled" });
    const limited = await open(readOnlyFileTools, ["hang"]);
    expect(await runWithTimeLimit(limited.session, "Go.", running(), 20)).toEqual({ status: "timed_out" });
  });

  it(`continues its conversation on another model of the same engine, and resumes a kept one (${harness().engine})`, async () => {
    const engine = harness();
    const root = checkout();
    const observed: Observed = { activity: [], usage: NO_TOKENS };
    const conversation: Conversation = { piManager: SessionManager.inMemory(root), id: randomUUID() };
    const session = await engine.start(root, readOnlyFileTools(root), observed, conversation);
    expect(session.resumed).toBe(false);
    engine.script([{ text: "first" }]);
    expect(await session.run("The earlier request.", running())).toEqual({ status: "completed", reply: "first" });
    await session.switchModel(engine.other());
    engine.script([{ text: "second" }]);
    expect(await session.run("The next request.", running())).toEqual({ status: "completed", reply: "second" });
    // The switch carries the target's reasoning level; before it, Pi reasoned at Tesota's default and Claude Code at its own.
    expect(engine.lastCall()).toEqual({ model: "other", continued: true, reasoning: "high" });
    session.dispose();
    expect((await engine.start(root, readOnlyFileTools(root), observed, conversation)).resumed).toBe(true);
  });

  it(`gives its conversation, requests, tool calls, results and replies, including a kept one's (${harness().engine})`, async () => {
    const engine = harness();
    const root = checkout();
    const observed: Observed = { activity: [], usage: NO_TOKENS };
    const conversation: Conversation = { piManager: SessionManager.inMemory(root), id: randomUUID() };
    const session = await engine.start(root, readOnlyFileTools(root), observed, conversation);
    engine.script([{ text: "first" }]);
    await session.run("The earlier request.", running());
    engine.script([{ tools: [{ name: "read", args: { path: "a.ts" } }] }, { text: "a is 1." }]);
    await session.run("What is a?", running());
    const entries = await session.conversation();
    expect(entries.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual(["The earlier request.", "What is a?"]);
    expect(entries).toContainEqual({ role: "tool_call", text: expect.stringMatching(/read.*a\.ts/u) });
    expect(entries.some((entry) => entry.role === "tool_result")).toBe(true);
    expect(entries.at(-1)).toEqual({ role: "assistant", text: "a is 1." });
    session.dispose();
    const resumed = await engine.start(root, readOnlyFileTools(root), observed, conversation);
    expect((await resumed.conversation()).slice(0, 2)).toEqual([{ role: "user", text: "The earlier request." },
      { role: "assistant", text: "first" }]);
  });

  it(`reports tokens with cached input inside input (${harness().engine})`, async () => {
    const { session, observed } = await open(readOnlyFileTools, [{ tools: [{ name: "read", args: { path: "a.ts" } }] }, { text: "1" }]);
    await session.run("What is a?", running());
    const { input, output, cacheRead, cacheCreation } = observed.usage;
    expect(input).toBeGreaterThan(0);
    expect(output).toBeGreaterThan(0);
    expect(input).toBeGreaterThanOrEqual(cacheRead + cacheCreation);
  });
});

// A session that answers after `answerMs`, or stops when its signal aborts, cleanly unless `stuck`.
function slowSession(answerMs: number, stuck = false): ModelSession {
  return { usable: true, dispose() {}, run: async (_request, signal) => new Promise<TurnResult>((settle) => {
    const stop = (): void => { settle(stuck ? { status: "unsettled" } : { status: "cancelled" }); };
    if (signal.aborted) { stop(); return; }
    const timer = setTimeout(() => { settle({ status: "completed", reply: "done" }); }, answerMs);
    signal.addEventListener("abort", () => { clearTimeout(timer); stop(); }, { once: true });
  }) };
}

describe("the time limit", () => {
  it("times a request out only when its limit, not the caller, stopped it", async () => {
    expect(await runWithTimeLimit(slowSession(5), "go", running(), 1_000)).toEqual({ status: "completed", reply: "done" });
    expect(await runWithTimeLimit(slowSession(5_000), "go", running(), 20)).toEqual({ status: "timed_out" });
    const stop = new AbortController();
    setTimeout(() => { stop.abort(); }, 10);
    expect(await runWithTimeLimit(slowSession(5_000), "go", stop.signal, 1_000)).toEqual({ status: "cancelled" });
  });

  it("never hides an engine that could not stop behind a time-out", async () => {
    expect(await runWithTimeLimit(slowSession(5_000, true), "go", running(), 20)).toEqual({ status: "unsettled" });
  });
});
