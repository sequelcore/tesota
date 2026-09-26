import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { activityOf, confinedPath, responseUsage } from "../src/integrations/pi-coding-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tesota-confine-")));
  roots.push(base);
  const root = join(base, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".git"));
  const outside = join(base, "outside");
  await mkdir(outside);
  return { root, outside };
}

it("allows workspace paths, including files that do not exist yet", async () => {
  const { root } = await fixture();
  expect(confinedPath(root, "src/new/file.ts", true)).toBe(join(root, "src", "new", "file.ts"));
  expect(confinedPath(root, "@src", false)).toBe(join(root, "src"));
  expect(confinedPath(root, undefined, false)).toBe(root);
});

it.each(["../outside/secret", "~/secret"])("rejects %s", async (path) => {
  const { root } = await fixture();
  expect(() => confinedPath(root, path, false)).toThrow("outside the workspace");
});

it("rejects absolute paths and links that leave the workspace", async () => {
  const { root, outside } = await fixture();
  expect(() => confinedPath(root, join(outside, "secret"), false)).toThrow("outside the workspace");
  await symlink(outside, join(root, "link"), "junction");
  expect(() => confinedPath(root, "link/secret", true)).toThrow("outside the workspace");
});

it("lets the agent read but not change Git internals", async () => {
  const { root } = await fixture();
  expect(confinedPath(root, ".git/config", false)).toBe(join(root, ".git", "config"));
  expect(() => confinedPath(root, ".git/config", true)).toThrow(".git");
  expect(() => confinedPath(root, ".GIT/hooks/pre-commit", true)).toThrow(".git");
});

it("turns the agent's streamed text and tool calls into activity a surface can show", () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "Checking " }, { type: "toolCall" },
    { type: "text", text: "the tests." }] };
  const events = [
    { type: "message_update", message: assistant },
    { type: "message_end", message: assistant },
    { type: "message_end", message: { role: "user", content: "hi" } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
    { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "ok 1" }] } },
    { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok 1\nok 2" }] }, isError: false },
    { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: { path: "src/a.ts" } },
    { type: "tool_execution_end", toolCallId: "c2", toolName: "edit", isError: false,
      result: { content: [{ type: "text", text: "Edited src/a.ts" }],
        details: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" } } },
    { type: "tool_execution_end", toolCallId: "c3", toolName: "edit", isError: true,
      result: { content: [{ type: "text", text: "Edit failed" }], details: { patch: "+not-applied\n" } } },
    { type: "agent_start" },
  ] as unknown as AgentSessionEvent[];
  expect(events.map((event) => activityOf(event, 3))).toEqual([
    { type: "reply", message: 3, text: "Checking \nthe tests.", final: false },
    { type: "reply", message: 3, text: "Checking \nthe tests.", final: true },
    undefined,
    { type: "tool_started", call: "c1", tool: "bash", subject: "npm test" },
    { type: "tool_output", call: "c1", output: "ok 1" },
    { type: "tool_finished", call: "c1", failed: false, output: "ok 1\nok 2" },
    { type: "tool_started", call: "c2", tool: "edit", subject: "src/a.ts" },
    { type: "tool_finished", call: "c2", failed: false, output: "Edited src/a.ts",
      change: { added: 1, removed: 1, lines: ["@@ -1 +1 @@", "-old", "+new"] } },
    { type: "tool_finished", call: "c3", failed: true, output: "Edit failed" },
    undefined,
  ]);
});

it("names an explorer call by its question", () => {
  const start = { type: "tool_execution_start", toolCallId: "h1", toolName: "explore",
    args: { question: "Where is a finding's origin decided?" } } as unknown as AgentSessionEvent;
  expect(activityOf(start, 1)).toEqual({ type: "tool_started", call: "h1", tool: "explore",
    subject: "Where is a finding's origin decided?" });
});

it("counts the tokens of each finished model response by kind, and nothing else", () => {
  const usage = { input: 900, output: 100, cacheRead: 4_000, cacheWrite: 7, totalTokens: 5_007, cost: { total: 0.1 } };
  const events = [
    { type: "message_update", message: { role: "assistant", content: [], usage } },
    { type: "message_end", message: { role: "assistant", content: [], usage } },
    { type: "message_end", message: { role: "user", content: "hi" } },
  ] as unknown as AgentSessionEvent[];
  expect(events.map(responseUsage)).toEqual([undefined, { input: 4_907, output: 100, cacheRead: 4_000, cacheCreation: 7 }, undefined]);
});
