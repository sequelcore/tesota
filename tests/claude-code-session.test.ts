import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeCodeStatus } from "../src/auth.js";
import { ClaudeCodeSession, claudeCodeTurn, onlyTesotaTools, resultTokens, toolShape } from "../src/integrations/claude-code-session.js";
import { type AgentActivity, readOnlyFileTools } from "../src/integrations/pi-coding-session.js";

// The SDK is replaced: tools keep their handlers, and query plays a scripted run against them.
const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], script: undefined as unknown, session: undefined as unknown }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, description: string, shape: unknown, handler: (args: unknown) => Promise<unknown>) =>
    ({ name, description, shape, handler }),
  createSdkMcpServer: (options: unknown) => options,
  getSessionInfo: async () => sdk.session,
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    return (sdk.script as (options: Record<string, unknown>) => AsyncGenerator<unknown>)(options);
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  sdk.options.length = 0;
  sdk.session = undefined;
});
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-claude-"));
  roots.push(root);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  return root;
}

const usage = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 5, webSearchRequests: 0,
  costUSD: 0.01, contextWindow: 200_000, maxOutputTokens: 32_000 };
const success = (text: string): SDKResultMessage => ({ type: "result", subtype: "success", is_error: false, result: text,
  modelUsage: { "claude-opus-5-5": usage, "claude-haiku-4-5": { ...usage, inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0 } } } as unknown as SDKResultMessage);
type Handler = { name: string; handler: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
function handlers(options: Record<string, unknown>): Handler[] {
  return (options["mcpServers"] as { tesota: { tools: Handler[] } }).tesota.tools;
}

it("counts every token of every model and reads how a run ended", () => {
  expect(resultTokens(success("done"))).toBe(425 + 11);
  expect(claudeCodeTurn(success("  done  "), false)).toEqual({ status: "completed", reply: "done" });
  expect(claudeCodeTurn(success("done"), true)).toEqual({ status: "cancelled" });
  expect(claudeCodeTurn(undefined, false)).toEqual({ status: "failed", reason: "Claude Code stopped without a result" });
  expect(claudeCodeTurn({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns"] } as unknown as
    SDKResultMessage, false)).toEqual({ status: "failed", reason: "too many turns" });
});

it("allows only Tesota's tools", async () => {
  const signal = new AbortController().signal;
  expect(await onlyTesotaTools("mcp__tesota__read", { path: "a.ts" }, { signal } as never))
    .toEqual({ behavior: "allow", updatedInput: { path: "a.ts" } });
  for (const name of ["Bash", "Read", "mcp__other__read", "WebFetch"]) {
    expect(await onlyTesotaTools(name, {}, { signal } as never)).toMatchObject({ behavior: "deny" });
  }
});

it("turns a Tesota tool's parameters into the shape the SDK takes", () => {
  const read = readOnlyFileTools(checkout()).find((tool) => tool.name === "read");
  expect(Object.keys(toolShape(read?.parameters))).toContain("path");
  expect(() => toolShape({ type: "string" })).toThrow("must be an object");
});

it("runs Claude Code with Tesota's tools only and none of the operator's setup, reporting activity and usage", async () => {
  const root = checkout();
  const activity: AgentActivity[] = [];
  let tokens = 0;
  sdk.script = async function* (options: Record<string, unknown>) {
    const [read] = handlers(options);
    const result = await read?.handler({ path: "a.ts" });
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: `Read: ${result?.content[0]?.text.trim()}` }] } };
    yield success("The constant is 1.");
  };
  const session = await ClaudeCodeSession.start({ cwd: root, model: "opus", systemPrompt: "You review.",
    tools: readOnlyFileTools(root), onActivity: (entry) => { activity.push(entry); }, onUsage: (count) => { tokens += count; } });
  expect(await session.run("What is a?", new AbortController().signal)).toEqual({ status: "completed", reply: "The constant is 1." });
  const [options] = sdk.options;
  expect(options).toMatchObject({ model: "opus", tools: [], settingSources: [], strictMcpConfig: true, skills: [],
    canUseTool: onlyTesotaTools, persistSession: false });
  expect(options?.["allowedTools"]).toBeUndefined();
  expect(String(options?.["systemPrompt"])).toMatch(/^You review\.[\s\S]*mcp__tesota__read/u);
  expect(options?.["resume"]).toBeUndefined();
  expect(activity.map((entry) => entry.type)).toEqual(["tool_started", "tool_finished", "reply"]);
  expect(activity[0]).toMatchObject({ tool: "read", subject: "a.ts" });
  expect(tokens).toBe(436);
});

it("returns a tool's failure to the model as an error, not as a result", async () => {
  const root = checkout();
  let returned: { isError?: boolean } | undefined;
  sdk.script = async function* (options: Record<string, unknown>) {
    returned = await handlers(options)[0]?.handler({ path: "../outside.ts" });
    yield success("done");
  };
  const session = await ClaudeCodeSession.start({ cwd: root, model: "opus", systemPrompt: "p", tools: readOnlyFileTools(root) });
  await session.run("go", new AbortController().signal);
  expect(returned?.isError).toBe(true);
});

it("keeps the working agent's conversation: starts it under its id, then resumes it", async () => {
  const root = checkout();
  sdk.script = async function* () { yield success("ok"); };
  const first = await ClaudeCodeSession.start({ cwd: root, model: "opus", systemPrompt: "p", tools: [], conversationId: "c-1" });
  await first.run("one", new AbortController().signal);
  await first.run("two", new AbortController().signal);
  expect(sdk.options.map((options) => [options["sessionId"], options["resume"]])).toEqual([["c-1", undefined], [undefined, "c-1"]]);
  sdk.session = { sessionId: "c-1" };
  const restarted = await ClaudeCodeSession.start({ cwd: root, model: "opus", systemPrompt: "p", tools: [], conversationId: "c-1" });
  await restarted.run("three", new AbortController().signal);
  expect(sdk.options.at(-1)?.["resume"]).toBe("c-1");
});

it("stops when the turn is cancelled, and fails when Claude Code cannot start", async () => {
  const root = checkout();
  const stop = new AbortController();
  sdk.script = async function* () { stop.abort(); yield* []; throw new Error("aborted"); };
  const session = await ClaudeCodeSession.start({ cwd: root, model: "opus", systemPrompt: "p", tools: [] });
  expect(await session.run("go", stop.signal)).toEqual({ status: "cancelled" });
  sdk.script = async function* () { yield* []; throw new Error("Not logged in"); };
  expect(await session.run("go", new AbortController().signal)).toEqual({ status: "failed", reason: "Not logged in" });
});

it("reports Claude Code's sign-in without any credential", () => {
  expect(claudeCodeStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })))
    .toBe("Claude Code: signed in (claude.ai). Tesota does not hold this login.");
  expect(claudeCodeStatus(JSON.stringify({ loggedIn: false }))).toContain("signed out");
});
