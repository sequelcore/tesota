// Live: the operator's own sign-ins and settings, not the isolated test home.
import "./operator-home.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AgentActivity } from "../src/integrations/model-session-contract.js";
import { openModelTarget, startModelSession } from "../src/integrations/model-session.js";
import { readOnlyFileTools } from "../src/integrations/pi-coding-session.js";
import { NO_TOKENS, type TokenUsage, addTokens } from "../src/token-usage.js";

/**
 * The model-session contract against real engines and models, through
 * Tesota's own routes: the evidence that `model-session-contract.test.ts`'s
 * Claude Code double behaves as Claude Code does. Opt-in, because it uses the
 * operator's sign-ins and model usage: `TESOTA_LIVE_MODELS=1`, with
 * `TESOTA_LIVE_MODEL_CHOICES` naming the `route:model` choices to hold to it
 * (default `claude-code:haiku,chatgpt:gpt-6-luna`).
 */

const live = process.env["TESOTA_LIVE_MODELS"] === "1";
const choices = (process.env["TESOTA_LIVE_MODEL_CHOICES"] ?? "claude-code:haiku,chatgpt:gpt-6-luna").split(",");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-contract-live-"));
  roots.push(root);
  writeFileSync(join(root, "a.ts"), "export const a = 41 + 1;\n");
  return root;
}

function submitTool(submitted: string[]): ToolDefinition {
  return defineTool({ name: "submit", label: "Submit", description: "Submit your answer. Call it exactly once.",
    parameters: Type.Object({ answer: Type.String() }),
    execute: async (_id, params) => {
      submitted.push(params.answer);
      return { content: [{ type: "text", text: "Recorded." }], details: undefined, terminate: true };
    } });
}

describe.each(choices)("the model-session contract, live on %s", (choice) => {
  async function open(tools: (root: string) => readonly ToolDefinition[]) {
    const root = checkout();
    const observed = { activity: [] as AgentActivity[], usage: NO_TOKENS as TokenUsage };
    const session = await startModelSession({ target: await openModelTarget(choice),
      onUsage: (usage) => { observed.usage = addTokens(observed.usage, usage); } },
    { cwd: root, systemPrompt: "You answer questions about a small repository using only the tools you are given.", tools: tools(root),
      onActivity: (entry) => { observed.activity.push(entry); } });
    return { root, observed, session };
  }

  it.runIf(live)("ends the turn with the submission, reporting tokens with cached input inside input", async () => {
    const submitted: string[] = [];
    const { session, observed } = await open((root) => [...readOnlyFileTools(root), submitTool(submitted)]);
    const turn = await session.run("Read a.ts, then submit the value of a as a number with the submit tool.", AbortSignal.timeout(180_000));
    expect(turn.status).toBe("completed");
    expect(submitted).toEqual(["42"]);
    // Nothing follows the submission: no model call, so no reply after the submit tool finished.
    const finished = observed.activity.findLastIndex((entry) => entry.type === "tool_finished");
    expect(observed.activity.slice(finished + 1).filter((entry) => entry.type === "reply")).toEqual([]);
    expect(observed.usage.input).toBeGreaterThan(0);
    expect(observed.usage.input).toBeGreaterThanOrEqual(observed.usage.cacheRead + observed.usage.cacheCreation);
  }, 200_000);

  it.runIf(live)("never runs a tool it was not given", async () => {
    const { session, root } = await open(readOnlyFileTools);
    await session.run("Create a file named b.ts containing `export const b = 2;`. Use any tool you have.", AbortSignal.timeout(180_000));
    expect(existsSync(join(root, "b.ts"))).toBe(false);
  }, 200_000);

  it.runIf(live)("stops when the caller cancels", async () => {
    const { session } = await open(readOnlyFileTools);
    const stop = new AbortController();
    setTimeout(() => { stop.abort(); }, 1_500);
    expect((await session.run("Read a.ts and explain it in detail, line by line.", stop.signal)).status).toBe("cancelled");
  }, 60_000);
});
