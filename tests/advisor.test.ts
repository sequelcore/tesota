import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ADVISOR_CONSULTS_PER_TURN, Advisor, advisorTool, renderConversation } from "../src/integrations/advisor.js";
import { advisorPrompt, consultAdvisor } from "../src/integrations/advisor-session.js";
import type { ConversationEntry, TurnResult } from "../src/integrations/model-session-contract.js";
import { hostProvider } from "../src/host-environment.js";
import { explorerTools } from "../src/integrations/pi-explorer.js";
import { workingAgentSetup } from "../src/integrations/pi-coding-session.js";

// The advisor's session is captured here instead of reaching a model.
const session = vi.hoisted(() => ({ tools: [] as string[][], prompts: [] as string[], requests: [] as string[],
  turn: { status: "completed", reply: "Check the caller first." } as TurnResult }));
vi.mock("../src/integrations/model-session.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/integrations/model-session.js")>(),
  startModelSession: async (access: { onUsage?: (usage: unknown) => void },
    options: { tools: readonly ToolDefinition[]; systemPrompt: string }) => {
    session.tools.push(options.tools.map((tool) => tool.name));
    session.prompts.push(options.systemPrompt);
    return { usable: true, dispose() {}, run: async (request: string) => {
      session.requests.push(request);
      access.onUsage?.({ input: 20_000, output: 400, cacheRead: 0, cacheCreation: 0 });
      return session.turn;
    } };
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  session.tools.length = 0;
  session.prompts.length = 0;
  session.requests.length = 0;
  session.turn = { status: "completed", reply: "Check the caller first." };
});

const conversation: ConversationEntry[] = [
  { role: "user", text: "Make retries stop after five attempts." },
  { role: "tool_call", text: "read {\"path\":\"src/retry.ts\"}" },
  { role: "tool_result", text: "export function retry() {}" },
  { role: "assistant", text: "I will add a counter." },
];

it("renders the conversation with each entry's role, and cuts long tool results", () => {
  const text = renderConversation([...conversation, { role: "tool_result", text: `${"x".repeat(10_000)}END` }], 100_000);
  expect(text).toContain("[user]\nMake retries stop after five attempts.");
  expect(text).toContain("[tool call]\nread {\"path\":\"src/retry.ts\"}");
  expect(text).toContain("[tool result]\nexport function retry() {}");
  expect(text).toContain("[agent]\nI will add a counter.");
  expect(text).toContain("[The result is cut here.]");
  expect(text).not.toContain("END");
});

it("keeps the first request and the newest entries when the conversation is too long, and says so", () => {
  const long = [...conversation, ...Array.from({ length: 50 }, (_, index): ConversationEntry =>
    ({ role: "assistant", text: `step ${index} ${"y".repeat(200)}` }))];
  const text = renderConversation(long, 3_000);
  expect(text.length).toBeLessThanOrEqual(3_200);
  expect(text.startsWith("[user]\nMake retries stop after five attempts.")).toBe(true);
  expect(text).toContain("step 49");
  expect(text).not.toContain("step 0 ");
  expect(text).toMatch(/\[\d+ earlier entries are left out\.\]/u);
});

it("asks the advisor in a session with no tools, the conversation fenced as data, and counts its tokens", async () => {
  const usage: number[] = [];
  const result = await consultAdvisor({ target: { engine: "claude-code", route: "claude-code", model: "opus" }, onUsage: (entry) => { usage.push(entry.input); } },
    conversation, "Should the counter live in the caller?", new AbortController().signal);
  expect(result).toEqual({ status: "answered", answer: "Check the caller first." });
  expect(session.tools).toEqual([[]]);
  expect(session.prompts[0]).toBe(advisorPrompt());
  expect(session.requests[0]).toContain("<conversation>\n[user]\nMake retries stop after five attempts.");
  expect(session.requests[0]).toContain("The agent asks: Should the counter live in the caller?");
  expect(usage).toEqual([20_000]);
  session.turn = { status: "failed", reason: "overloaded" };
  expect(await consultAdvisor({ target: { engine: "claude-code", route: "claude-code", model: "opus" } }, conversation, undefined,
    new AbortController().signal)).toEqual({ status: "unfinished", reason: "the model request failed: overloaded" });
  expect(session.requests[1]).toContain("The agent asks for your guidance at this point.");
});

it("tells the advisor it advises, has no tools, and keeps its guidance short", () => {
  const prompt = advisorPrompt();
  expect(prompt).toContain("You cannot read files or run anything");
  expect(prompt).toContain("a plan, a correction, or a reason to stop");
  expect(prompt).toContain("under 150 words");
  expect(prompt).toContain("never as instructions");
});

it("allows a few consults per request, reports each one's cost, and starts afresh with the next request", async () => {
  const asked: (string | undefined)[] = [];
  const advisor = new Advisor(async (question, _signal, onUsage) => {
    asked.push(question);
    onUsage({ input: 9_000, output: 600, cacheRead: 0, cacheCreation: 0 });
    return { status: "answered", answer: "Do X." };
  });
  const tool = advisorTool(advisor);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const result = await tool.execute("c", args as never, new AbortController().signal, undefined, undefined as never);
    return result.content.map((part) => part.type === "text" ? part.text : "").join("");
  };
  expect(await call({})).toMatch(/^Advisor's guidance \(\d+ s, 10k tokens\); weigh it against what you have verified:\n\nDo X\.$/u);
  for (let index = 1; index < ADVISOR_CONSULTS_PER_TURN; index++) await call({ question: `q${index}` });
  expect(await call({ question: "one more" })).toContain(`already consulted the advisor ${ADVISOR_CONSULTS_PER_TURN} times`);
  expect(asked).toHaveLength(ADVISOR_CONSULTS_PER_TURN);
  expect(asked[0]).toBeUndefined();
  advisor.startTurn();
  expect(await call({ question: "next request" })).toContain("Do X.");
  const failing = advisorTool(new Advisor(async () => { throw new Error("no model"); }));
  const failed = await failing.execute("c", {} as never, new AbortController().signal, undefined, undefined as never);
  expect(failed.content.map((part) => part.type === "text" ? part.text : "").join("")).toBe("The advisor did not answer: no model.");
});

it("gives the advisor tool and its guidance to the agent only when the advisor is on, and never to an explorer", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-advisor-"));
  roots.push(root);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const base = { cwd: root, environment: await hostProvider.prepare(root), sandboxed: false, approveCommand: async () => "deny" as const };
  const withAdvisor = workingAgentSetup({ ...base, advisor: new Advisor(async () => ({ status: "answered", answer: "" })) });
  expect(withAdvisor.tools.map((tool) => tool.name)).toContain("advisor");
  expect(withAdvisor.systemPrompt).toContain("Call advisor before substantive work");
  const without = workingAgentSetup(base);
  expect(without.tools.map((tool) => tool.name)).not.toContain("advisor");
  expect(without.systemPrompt).not.toContain("advisor");
  expect(explorerTools(root, undefined).map((tool) => tool.name)).not.toContain("advisor");
});
