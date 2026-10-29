import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AssistantMessage, createModels, InMemoryCredentialStore, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { getSessionPath, openSession as openClaudeSession } from "cc-session-io";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type execFile, type ExecFileOptions, type spawn, type SpawnOptions, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { engineModels, runnableModels } from "../src/model-access.ts";
import { claudeCodeExecutable, claudeCodeLogin, claudeCodeProvider, claudeCodeStatus, type StartQuery } from "../src/providers/claude-code.ts";
import { runPrint } from "../src/print.ts";
import { writeSettings } from "../src/settings.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import { readSessionFile } from "../src/session-file.ts";
import { accepts } from "./scripted.ts";

/**
 * Claude through the operator's own Claude Code (#546), driven by SDK
 * streams recorded from a real Claude Code, never a live account: a tool
 * call ends the step and the engine's result answers it in the same query;
 * a stop ends the query; a resume, a crash or another model starts a new
 * query from the engine's history; Claude Code's own failures end the step
 * with its words.
 */
const recording = (name: string): SDKMessage[] => readFileSync(join(import.meta.dir, "fixtures", "claude-code", `${name}.jsonl`), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as SDKMessage);
const toolCall = recording("tool-call");
/** The recording's two replies: the call, up to Claude Code reading its result, and the answer after it. */
const answerAt = toolCall.findIndex((message) => message.type === "user") + 1;
const [callReply, answerReply] = [toolCall.slice(0, answerAt), toolCall.slice(answerAt)];
const recordedId = "toolu_01Kh3FQJq6wmpdKcw3Sf9GVm";
/** Keeps a query open until it is closed, as a reply still streaming does. */
const hang = Symbol("hang");

interface Run {
  readonly options: Options;
  readonly prompts: SDKUserMessage[];
  /** What happened, in order: a prompt read, a call's result given to Claude Code. */
  readonly events: string[];
  readonly results: unknown[];
  listed: string[];
  /** The Claude Code transcript the query resumes, as it was when the query started. */
  resumed: { role: string; content: unknown }[] | undefined;
  closed: boolean;
}

/**
 * Replays recorded SDK messages, one script per query, as Claude Code
 * would: it lists the MCP tools, and before giving a call's result to the
 * model it makes the MCP call and waits for its answer.
 */
function replaying(...scripts: (SDKMessage | typeof hang)[][]): { readonly start: StartQuery; readonly runs: Run[] } {
  const runs: Run[] = [];
  const start: StartQuery = ({ prompt, options }) => {
    const run: Run = { options, prompts: [], events: [], results: [], listed: [], resumed: undefined, closed: false };
    runs.push(run);
    const configDir = options.env?.["CLAUDE_CONFIG_DIR"];
    if (options.resume !== undefined) {
      run.resumed = openClaudeSession({ sessionId: options.resume, projectPath: options.cwd ?? process.cwd(), ...configDir === undefined ? {} : { claudeDir: configDir } }).messages
        .map((record) => ({ role: record.message.role, content: record.message.content }));
    }
    // Claude Code writes its transcript as soon as it starts, before it says which session it is.
    const written = options.resume ?? options.sessionId;
    if (written !== undefined) {
      const path = getSessionPath(written, options.cwd ?? process.cwd(), configDir);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: written })}\n`);
    }
    const script = scripts.shift() ?? [];
    let stop = (): void => undefined;
    const stopped = new Promise<undefined>((resolve) => { stop = () => { resolve(undefined); }; });
    void (async () => { for await (const message of prompt) { run.prompts.push(message); run.events.push("prompt"); } })();
    const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
    const transport: { onmessage?: (message: unknown) => void; send(message: { id: number; result?: unknown; error?: unknown }): Promise<void> } = {
      send: async (message) => { pending.get(message.id)?.(message); },
    };
    const config = options.mcpServers?.["tesota"] as unknown as { instance: { connect(transport: unknown): Promise<void> } };
    let next = 0;
    const call = async (method: string, params: unknown): Promise<unknown> => {
      const id = next++;
      const answered = new Promise<{ result?: unknown; error?: unknown }>((resolve) => { pending.set(id, resolve); });
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
      const reply = await Promise.race([answered, stopped]);
      return reply?.result ?? reply?.error;
    };
    return {
      interrupt: async () => { stop(); },
      close: () => { run.closed = true; stop(); },
      async *[Symbol.asyncIterator]() {
        await config.instance.connect(transport);
        await call("initialize", { protocolVersion: "2025-06-18" });
        run.listed = ((await call("tools/list", {})) as { tools: { name: string }[] }).tools.map(({ name }) => name);
        const names = new Map<string, string>();
        for (const message of script) {
          if (run.closed) return;
          if (message === hang) { await stopped; return; }
          if (message.type === "assistant") {
            for (const block of message.message.content) if (block.type === "tool_use") names.set(block.id, block.name);
          }
          if (message.type === "user" && Array.isArray(message.message.content)) {
            for (const block of message.message.content) {
              if (typeof block !== "object" || block.type !== "tool_result") continue;
              const name = names.get(block.tool_use_id) ?? "";
              const result = await call("tools/call", { name: name.replace(/^mcp__tesota__/u, ""), arguments: {}, _meta: { "claudecode/toolUseId": block.tool_use_id } });
              if (result === undefined) return;
              run.results.push(result);
              run.events.push("result");
            }
          }
          yield message;
        }
      },
    };
  };
  return { start, runs };
}

const anthropic = anthropicProvider().getModels();
const echo: Tool = { name: "echo", description: "Returns the text it is given.", parameters: Type.Object({ text: Type.String() }) };
const systemPrompt = "You are a test agent.";

function provider(start: StartQuery) {
  const models = createModels();
  models.setProvider(claudeCodeProvider(anthropic, { query: start, signedIn: async () => true }));
  const model = (id: string): Model<"anthropic-messages"> => models.getModel("claude-code", id) as Model<"anthropic-messages">;
  const step = async (messages: Message[], options: { sessionId?: string; signal?: AbortSignal; model?: string } = {}): Promise<AssistantMessage> =>
    await models.streamSimple(model(options.model ?? "claude-haiku-4-5"), { systemPrompt, messages, tools: [echo] },
      { metadata: { cwd: process.cwd() }, sessionId: options.sessionId ?? "session-1", ...options.signal === undefined ? {} : { signal: options.signal } }).result();
  return { models, step };
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: Date.now() });
const result = (id: string, text: string): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const textOf = (message: AssistantMessage): string => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
const settled = async (run: Run): Promise<void> => { for (let tries = 0; !run.closed && tries < 100; tries += 1) await Bun.sleep(10); };

describe("the claude-code provider", () => {
  test("a named Claude account ignores ambient credentials for both status and queries", async () => {
    const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"];
    const saved = names.map((name) => process.env[name]);
    const configDir = mkdtempSync(join(tmpdir(), "claude-account-env-"));
    for (const name of names) process.env[name] = "ambient-credential";
    try {
      let statusEnv: NodeJS.ProcessEnv | undefined;
      const execute = ((_file: string, _args: readonly string[], options: ExecFileOptions,
        callback: (error: null, stdout: string, stderr: string) => void) => {
        statusEnv = options.env;
        callback(null, '{"loggedIn":true,"email":"folder@example.test"}', "");
      }) as typeof execFile;
      await claudeCodeStatus(configDir, execute);
      const { start, runs } = replaying(answerReply);
      const models = createModels();
      models.setProvider(claudeCodeProvider(anthropic, { id: "claude-code@b", configDir, query: start, signedIn: async () => true }));
      const model = models.getModel("claude-code@b", "claude-haiku-4-5");
      if (model === undefined) throw new Error("Missing model");
      await models.streamSimple(model, { messages: [user("go")] }, { metadata: { cwd: process.cwd() } }).result();
      for (const name of names) {
        expect(statusEnv?.[name]).toBeUndefined();
        expect(runs[0]?.options.env?.[name]).toBeUndefined();
      }
    } finally {
      for (const [index, name] of names.entries()) {
        const value = saved[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("auth status runs with the instance folder and exposes only account metadata", async () => {
    let seen: ExecFileOptions | undefined;
    const execute = ((_file: string, args: readonly string[], options: ExecFileOptions,
      callback: (error: null, stdout: string, stderr: string) => void) => {
      expect(args).toEqual(["auth", "status", "--json"]);
      seen = options;
      callback(null, JSON.stringify({ loggedIn: true, email: "owner@example.test", authMethod: "claude.ai", extra: "not returned" }), "");
    }) as typeof execFile;
    const status = await claudeCodeStatus("/claude-b", execute);
    expect(status).toEqual({ loggedIn: true, email: "owner@example.test" });
    expect(seen?.env?.["CLAUDE_CONFIG_DIR"]).toBe("/claude-b");
    expect(seen?.env?.["HOME"]).toBe(process.env["HOME"]);
    expect(seen?.signal).toBeUndefined();
    const stop = new AbortController();
    await claudeCodeStatus("/claude-b", execute, stop.signal);
    // The usage panel's signal stops Claude Code when the panel closes (#3).
    expect(seen?.signal).toBe(stop.signal);
  });

  test("checks of one folder's sign-in at the same time share one run of Claude Code, and a later check runs it again (#744)", async () => {
    const pending: (() => void)[] = [];
    let runs = 0;
    const execute = ((_file: string, _args: readonly string[], _options: ExecFileOptions,
      callback: (error: null, stdout: string, stderr: string) => void) => {
      runs += 1;
      pending.push(() => { callback(null, '{"loggedIn":true,"email":"owner@example.test"}', ""); });
    }) as typeof execFile;
    const first = claudeCodeStatus("/claude-b", execute);
    const second = claudeCodeStatus("/claude-b", execute);
    const other = claudeCodeStatus("/claude-c", execute);
    expect(runs).toBe(2);
    for (const release of pending.splice(0)) release();
    expect(await first).toEqual({ loggedIn: true, email: "owner@example.test" });
    expect(await second).toEqual({ loggedIn: true, email: "owner@example.test" });
    await other;
    // Nothing is kept once the check returns: signing in or out elsewhere shows at the next check.
    const later = claudeCodeStatus("/claude-b", execute);
    expect(runs).toBe(3);
    for (const release of pending.splice(0)) release();
    await later;
    // A check a signal can stop runs on its own, so stopping it stops no one else's.
    void claudeCodeStatus("/claude-b", execute);
    void claudeCodeStatus("/claude-b", execute, new AbortController().signal);
    expect(runs).toBe(5);
    for (const release of pending.splice(0)) release();
  });

  test("an account's sign-in is Claude Code's own login, on the terminal, in the account's folder with HOME unchanged (#642)", async () => {
    let seen: { args: readonly string[]; options: SpawnOptions } | undefined;
    const saved = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-ambient";
    try {
      const run = ((_file: string, args: readonly string[], options: SpawnOptions) => {
        seen = { args, options };
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }) as unknown as typeof spawn;
      await claudeCodeLogin("/claude-b", run);
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = saved;
    }
    expect(seen?.args).toEqual(["auth", "login"]);
    expect(seen?.options.stdio).toBe("inherit");
    expect(seen?.options.env?.["CLAUDE_CONFIG_DIR"]).toBe("/claude-b");
    expect(seen?.options.env?.["HOME"]).toBe(process.env["HOME"]);
    expect(seen?.options.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  test("a named instance sets only its Claude folder and keeps its identity on a limit, without fallback", async () => {
    const { start, runs } = replaying([{ type: "result", subtype: "error_during_execution", is_error: true,
      errors: ["Account limit reached; try again later."] } as unknown as SDKMessage]);
    const models = createModels();
    const folder = mkdtempSync(join(tmpdir(), "claude-account-"));
    models.setProvider(claudeCodeProvider(anthropic, { id: "claude-code@b", configDir: folder, query: start, signedIn: async () => true }));
    let otherCalls = 0;
    models.setProvider(claudeCodeProvider(anthropic, { id: "claude-code@other", signedIn: async () => true,
      query: () => { otherCalls += 1; throw new Error("Must not switch accounts"); } }));
    const model = models.getModel("claude-code@b", "claude-haiku-4-5");
    expect(model).toBeDefined();
    const reply = await models.streamSimple(model!, { messages: [user("go")] }, { metadata: { cwd: process.cwd() } }).result();
    expect(reply.provider).toBe("claude-code@b");
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toContain("limit");
    expect(runs).toHaveLength(1);
    expect(otherCalls).toBe(0);
    expect(reply.errorMessage).toContain("Account limit reached; try again later.");
    expect(runs[0]?.options.env?.["CLAUDE_CONFIG_DIR"]).toBe(folder);
    expect(runs[0]?.options.env?.["HOME"]).toBe(process.env["HOME"]);
    expect(process.env["CLAUDE_CONFIG_DIR"]).not.toBe(folder);
  });

  test("a tool call ends the step, and the engine's result answers it in the same query", async () => {
    const { start, runs } = replaying(toolCall);
    const { step } = provider(start);
    const history: Message[] = [user("Call the echo tool with text \"pong\". After its result, reply with exactly: done")];
    const first = await step(history);
    expect(first.stopReason).toBe("toolUse");
    expect(first.content.filter((block) => block.type === "toolCall")).toEqual([{ type: "toolCall", id: recordedId, name: "echo", arguments: { text: "pong" } }]);
    expect(runs[0]?.listed).toEqual(["echo"]);
    history.push(first, result(recordedId, "echoed: pong"));
    const second = await step(history);
    expect(textOf(second)).toBe("done");
    expect(second.stopReason).toBe("stop");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.results).toEqual([{ content: [{ type: "text", text: "echoed: pong" }], isError: false }]);
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  });

  test("Claude Code runs unmodified, isolated: none of its own tools, settings or compaction, and only Tesota's tools allowed", async () => {
    const { start, runs } = replaying(toolCall);
    const { step } = provider(start);
    await step([user("hi")]);
    const options = runs[0]?.options as Options;
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.resume).toBeUndefined();
    expect(options.env).toMatchObject({ CLAUDE_AGENT_SDK_CLIENT_APP: "tesota", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    // The operator's Claude Code memory for the folder is not Tesota's to read, nor Claude Code's to write from a Tesota session.
    expect(options.settings).toMatchObject({ autoMemoryEnabled: false });
    expect(options.systemPrompt).toBe(systemPrompt);
    const ask = options.canUseTool as NonNullable<Options["canUseTool"]>;
    const asked = { signal: new AbortController().signal, suggestions: [], toolUseID: "t" } as unknown as Parameters<typeof ask>[2];
    expect((await ask("Bash", { command: "ls" }, asked))?.behavior).toBe("deny");
    expect((await ask("mcp__tesota__echo", { text: "x" }, asked))?.behavior).toBe("allow");
  });

  test("a steer sent while a call runs reaches Claude Code before the call's result", async () => {
    const { start, runs } = replaying(toolCall);
    const { step } = provider(start);
    const history: Message[] = [user("echo pong")];
    const first = await step(history);
    history.push(first, result(recordedId, "pong"), user("and keep it short"));
    await step(history);
    const steer = runs[0]?.prompts[1];
    expect(steer?.priority).toBe("next");
    expect(JSON.stringify(steer?.message.content)).toContain("and keep it short");
    expect(runs[0]?.events).toEqual(["prompt", "prompt", "result"]);
  });

  test("a stopped step ends as aborted and its query closes; the next starts a new query from the engine's history", async () => {
    const streaming = callReply.slice(0, callReply.findIndex((message) => message.type === "assistant"));
    const { start, runs } = replaying([...streaming, hang], answerReply);
    const { step } = provider(start);
    const stopper = new AbortController();
    const history: Message[] = [user("echo pong")];
    const stopping = step(history, { signal: stopper.signal });
    for (let tries = 0; runs.length === 0 && tries < 100; tries += 1) await Bun.sleep(10);
    stopper.abort();
    const stopped = await stopping;
    expect(stopped.stopReason).toBe("aborted");
    await settled(runs[0] as Run);
    expect(runs[0]?.closed).toBe(true);
    // The stopped query's Claude Code transcript is removed: the engine keeps the conversation.
    const transcript = getSessionPath(runs[0]?.options.sessionId ?? "none", runs[0]?.options.cwd ?? process.cwd());
    for (let tries = 0; existsSync(transcript) && tries < 100; tries += 1) await Bun.sleep(10);
    expect(runs[0]?.options.sessionId).toBeDefined();
    expect(existsSync(transcript)).toBe(false);
    history.push(stopped, user("try again"));
    const again = await step(history);
    expect(textOf(again)).toBe("done");
    expect(runs).toHaveLength(2);
    expect(runs[1]?.resumed?.map(({ role }) => role)).toEqual(["user"]);
    expect(JSON.stringify(runs[1]?.prompts[0]?.message.content)).toContain("try again");
  });

  test("after a crash, a new query starts from the engine's history, whole tool pairs and all, never from Claude Code's transcript", async () => {
    const { start, runs } = replaying(answerReply);
    // A new provider, as after a restart: no query is left to go on in.
    const { step } = provider(start);
    const history: Message[] = [
      user("echo twice"),
      { role: "assistant", content: [{ type: "thinking", thinking: "plan", thinkingSignature: "openai-signature" },
        { type: "toolCall", id: "call_1|fc_2", name: "echo", arguments: { text: "a" } }, { type: "toolCall", id: "call_3", name: "echo", arguments: { text: "b" } }],
      api: "openai-responses", provider: "openai", model: "gpt-6.1-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() },
      user("a steer recorded before the results"),
      result("call_1|fc_2", "a"),
      result("call_3", "b"),
    ];
    expect(textOf(await step(history, { sessionId: "session-2" }))).toBe("done");
    expect(runs).toHaveLength(1);
    const resumed = runs[0]?.resumed ?? [];
    expect(resumed.map(({ role }) => role)).toEqual(["user", "assistant", "user", "user"]);
    expect(JSON.stringify(resumed[3]?.content)).toContain("a steer recorded before the results");
    // Another provider's thinking is left out, its call ids made to fit Anthropic's, and both results follow their calls.
    expect(resumed[1]?.content).toEqual([{ type: "tool_use", id: "call_1_fc_2", name: "mcp__tesota__echo", input: { text: "a" } },
      { type: "tool_use", id: "call_3", name: "mcp__tesota__echo", input: { text: "b" } }]);
    expect(((resumed[2]?.content ?? []) as { tool_use_id: string; content: unknown }[]).map(({ tool_use_id, content }) => [tool_use_id, content]))
      .toEqual([["call_1_fc_2", "a"], ["call_3", "b"]]);
    expect(JSON.stringify(runs[0]?.prompts[0]?.message.content)).toContain("resumed");
  });

  test("another model mid-run closes the query and starts a new one on that model from the engine's history", async () => {
    const { start, runs } = replaying(callReply.concat([hang] as never), answerReply);
    const { step } = provider(start);
    const history: Message[] = [user("echo pong")];
    const first = await step(history);
    expect(first.stopReason).toBe("toolUse");
    history.push(first, result(recordedId, "pong"));
    expect(textOf(await step(history, { model: "claude-sonnet-5-5" }))).toBe("done");
    expect(runs[0]?.closed).toBe(true);
    expect(runs[1]?.options.model).toBe("claude-sonnet-5-5");
    expect(runs[1]?.resumed?.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
  });

  test("Claude Code's own failure, such as being signed out, ends the step with its words", async () => {
    const { start } = replaying(recording("signed-out"));
    const { step } = provider(start);
    const failed = await step([user("hi")]);
    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toBe("Claude Code: Not logged in · Please run /login");
    // Its report is not the model's reply.
    expect(failed.content).toEqual([]);
  });

  test("the Claude Code program installed with the SDK for this platform is found, to ask whether it is signed in", () => {
    // Lookup only, in a child: never remove the suite's executable guard in this process.
    const lookup = spawnSync(process.execPath, ["-e", `import { claudeCodeExecutable } from './src/providers/claude-code.ts'; console.log(claudeCodeExecutable());`],
      { cwd: join(import.meta.dir, ".."), encoding: "utf8", env: { ...process.env, CLAUDE_CODE_EXECUTABLE: undefined } });
    expect(lookup.status).toBe(0);
    expect(lookup.stdout.trim()).toMatch(/claude-agent-sdk-[a-z0-9-]+[\\/]claude(\.exe)?$/u);
  });

  test("without the SDK's program, as in a compiled tesota, the operator's own claude on the PATH is run (#570)", () => {
    const bin = mkdtempSync(join(tmpdir(), "tesota-claude-"));
    const program = join(bin, process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(program, "");
    chmodSync(program, 0o755);
    const path = process.env["PATH"];
    process.env["PATH"] = bin;
    try {
      expect(claudeCodeExecutable(() => undefined)).toBe(program);
      process.env["PATH"] = mkdtempSync(join(tmpdir(), "tesota-no-claude-"));
      expect(claudeCodeExecutable(() => undefined)).toBeUndefined();
    } finally { process.env["PATH"] = path; }
  });

  test("the models are pi-ai's Anthropic catalog, offered only once Claude Code is signed in", async () => {
    let signedIn = false;
    const models = await engineModels(new InMemoryCredentialStore());
    models.setProvider(claudeCodeProvider(models.getModels("anthropic"), { signedIn: async () => signedIn }));
    expect((await runnableModels(models)).filter(({ provider }) => provider === "claude-code")).toEqual([]);
    signedIn = true;
    const offered = (await runnableModels(models)).filter(({ provider }) => provider === "claude-code").map(({ id }) => id);
    expect(offered).toContain("claude-sonnet-5-5");
    expect(offered).toContain("claude-haiku-4-5");
    expect(offered.some((id) => /-20\d{6}$/u.test(id))).toBe(false);
    expect(offered).toHaveLength(models.getModels("anthropic").filter(({ id }) => !/-20\d{6}$/u.test(id)).length);
  });
});

describe("a session on claude-code", () => {
  test("print --model and the saved model run the explicitly chosen Claude account", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "claude-print-account-"));
    const accounts = [{ name: "b", provider: "claude-code", folder: configDir }] as const;
    const models = await engineModels(new InMemoryCredentialStore(), accounts);
    expect(models.getModel("claude-code@b", "claude-haiku-4-5")?.provider).toBe("claude-code@b");
    const { start, runs } = replaying(answerReply, answerReply);
    models.setProvider(claudeCodeProvider(anthropic, { id: "claude-code@b", configDir, query: start, signedIn: async () => true }));
    const settingsPath = join(mkdtempSync(join(tmpdir(), "tesota-account-settings-")), "settings.json");
    writeSettings({ accounts, model: "claude-code@b/claude-haiku-4-5" }, settingsPath);
    for (const args of [["say done", "--model", "claude-code@b/claude-haiku-4-5"], ["say done"]]) {
      let output = "";
      expect(await runPrint(args, mkdtempSync(join(tmpdir(), "tesota-account-print-")),
        { out: (text) => { output += text; }, error: () => undefined }, { "open-cases-model": "off" }, settingsPath, models)).toBe(0);
      expect(output.trim()).toBe("done");
    }
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.options.env?.["CLAUDE_CONFIG_DIR"]).toBe(configDir);
  });

  const open: EngineSession[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

  test("Claude Code gets the session's worktree rather than the shell's folder (#577)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tesota-claude-worktree-"));
    for (const args of [["init", "-q"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base"]]) {
      const run = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
    }
    const { start, runs } = replaying(answerReply);
    const models = createModels();
    models.setProvider(claudeCodeProvider(anthropic, { query: start, signedIn: async () => true }));
    const options = { cwd, folder: mkdtempSync(join(tmpdir(), "tesota-claude-sessions-")), verifier: accepts,
      models, model: models.getModel("claude-code", "claude-haiku-4-5") as Model<"anthropic-messages"> };
    open.push(createSession(options));
    const session = createSession(options);
    open.push(session);
    expect(session.workspace.worktree).toBeDefined();
    expect(session.workspace.cwd).not.toBe(process.cwd());
    await session.prompt("say done");
    expect(session.lastAssistantText()).toBe("done");
    expect(runs[0]?.options.cwd).toBe(session.workspace.cwd);
  });

  test("deleting Tesota's transcript leaves no empty Claude Code project folder (#577)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tesota-claude-cleanup-"));
    const { start, runs } = replaying(answerReply, answerReply);
    const models = createModels();
    models.setProvider(claudeCodeProvider(anthropic, { query: start, signedIn: async () => true }));
    const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-claude-sessions-")), verifier: accepts,
      models, model: models.getModel("claude-code", "claude-haiku-4-5") as Model<"anthropic-messages"> });
    open.push(session);
    await session.prompt("say done");
    // A second request imports the engine's history into a transcript before starting Claude Code.
    await session.prompt("say done again");
    expect(runs[1]?.options.resume).toBeDefined();
    const transcript = getSessionPath(runs[1]?.options.resume ?? "none", session.workspace.cwd);
    for (let tries = 0; existsSync(dirname(transcript)) && tries < 100; tries += 1) await Bun.sleep(10);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(dirname(transcript))).toBe(false);
  });

  test("a named account resumes and cleans up transcripts only in its own Claude folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-account-cwd-"));
    const configDir = mkdtempSync(join(tmpdir(), "claude-account-config-"));
    const other = getSessionPath("operator-session", cwd);
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "operator's default history\n");
    const { start, runs } = replaying(answerReply, answerReply);
    const models = createModels();
    models.setProvider(claudeCodeProvider(anthropic, { id: "claude-code@b", configDir, query: start, signedIn: async () => true }));
    const model = models.getModel("claude-code@b", "claude-haiku-4-5");
    if (model === undefined) throw new Error("Missing model");
    const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-account-sessions-")), verifier: accepts, models, model });
    open.push(session);
    await session.prompt("say done");
    await session.prompt("say done again");
    expect(runs[1]?.resumed?.some(({ role }) => role === "assistant")).toBe(true);
    const transcript = getSessionPath(runs[1]?.options.resume ?? "none", cwd, configDir);
    for (let tries = 0; existsSync(dirname(transcript)) && tries < 100; tries += 1) await Bun.sleep(10);
    expect(existsSync(dirname(transcript))).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("operator's default history\n");
  });

  test("transcript cleanup preserves another Claude Code session in the same project folder", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tesota-claude-shared-"));
    const { start, runs } = replaying(answerReply);
    const models = createModels();
    let otherTranscript = "";
    models.setProvider(claudeCodeProvider(anthropic, { signedIn: async () => true, query: (input) => {
      const query = start(input);
      otherTranscript = getSessionPath("operator-session", cwd);
      writeFileSync(otherTranscript, "operator's history\n");
      return query;
    } }));
    const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-claude-sessions-")), verifier: accepts,
      models, model: models.getModel("claude-code", "claude-haiku-4-5") as Model<"anthropic-messages"> });
    open.push(session);
    await session.prompt("say done");
    const transcript = getSessionPath(runs[0]?.options.sessionId ?? "none", session.workspace.cwd);
    for (let tries = 0; existsSync(transcript) && tries < 100; tries += 1) await Bun.sleep(10);
    expect(existsSync(transcript)).toBe(false);
    expect(readFileSync(otherTranscript, "utf8")).toBe("operator's history\n");
  });

  test("runs Tesota's tool through the engine's permissions, and Claude Code reads the tool's real result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tesota-claude-code-"));
    writeFileSync(join(cwd, "a.txt"), "the file's text\n");
    // The recorded call, made to Tesota's `read` instead of the recording's `echo`.
    const script = (JSON.parse(JSON.stringify(toolCall).replaceAll("mcp__tesota__echo", "mcp__tesota__read")) as SDKMessage[]).map((message) => {
      const record = message as unknown as { event?: { delta?: { type?: string; partial_json?: string } }; message?: { content?: unknown } };
      if (record.event?.delta?.type === "input_json_delta") record.event.delta.partial_json = "";
      for (const block of Array.isArray(record.message?.content) ? record.message.content as { type?: string; input?: unknown }[] : []) {
        if (block.type === "tool_use") block.input = { path: "a.txt" };
      }
      return message;
    });
    const firstDelta = script.findIndex((message) => JSON.stringify(message).includes("input_json_delta"));
    (script[firstDelta] as unknown as { event: { delta: { partial_json: string } } }).event.delta.partial_json = "{\"path\": \"a.txt\"}";
    const { start, runs } = replaying(script);
    const models = createModels();
    models.setProvider(claudeCodeProvider(anthropic, { query: start, signedIn: async () => true }));
    const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-claude-code-sessions-")), verifier: accepts,
      models, model: models.getModel("claude-code", "claude-haiku-4-5") as Model<"anthropic-messages"> });
    open.push(session);
    await session.prompt("read a.txt, then say done");
    expect(session.lastAssistantText()).toBe("done");
    expect(session.outcome()).toBe("completed");
    expect(JSON.stringify(runs[0]?.results)).toContain("the file's text");
    const entries = readSessionFile(session.file).entries;
    expect(entries.some((entry) => entry.type === "permission" && entry.decision === "allow")).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.listed).toContain("read");
  });
});
