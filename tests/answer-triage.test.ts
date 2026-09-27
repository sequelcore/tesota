import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TurnResult } from "../src/integrations/model-session-contract.js";
import { triageAnswer, triageMessage } from "../src/integrations/answer-triage.js";
import { runsAnswerCheck } from "../src/verification/answer-check-rule.js";

/**
 * The answer check's first pass (decision 034): a cheap model decides whether a
 * turn that changed no files holds anything worth checking. Only a decision
 * that nothing is checkable skips the full check; anything else runs it.
 */

// The first pass's session is captured here instead of reaching a model; `decide` sets what the model decides.
const session = vi.hoisted(() => ({ tools: [] as string[][], requests: [] as string[],
  decide: undefined as { checkable: boolean; reason: string } | undefined,
  turn: { status: "completed", reply: "" } as TurnResult }));
vi.mock("../src/integrations/model-session.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/integrations/model-session.js")>(),
  startModelSession: async (_access: unknown, options: { tools: readonly ToolDefinition[] }) => {
    session.tools.push(options.tools.map((tool) => tool.name));
    return { usable: true, dispose() {}, run: async (request: string) => {
      session.requests.push(request);
      const decide = options.tools.find((tool) => tool.name === "decide");
      if (session.decide !== undefined) await decide?.execute("c", session.decide as never, undefined, undefined, undefined as never);
      return session.turn;
    } };
  },
}));

afterEach(() => {
  session.tools.length = 0;
  session.requests.length = 0;
  session.decide = undefined;
  session.turn = { status: "completed", reply: "" };
});

const access = { target: { engine: "claude-code" as const, model: "haiku" } };

it("skips the full check only when the first pass decided that nothing is checkable", () => {
  expect(runsAnswerCheck(true, false)).toBe(false);
  expect(runsAnswerCheck(true, true)).toBe(true);
  // A first pass that failed, timed out or never decided runs the full check, never skips it.
  expect(runsAnswerCheck(false, false)).toBe(true);
  expect(runsAnswerCheck(false, true)).toBe(true);
});

it("shows the first pass every pending request and the reply, and gives it only the decide tool", async () => {
  session.decide = { checkable: false, reason: "a greeting" };
  const decision = await triageAnswer(access, ["hi"], "Hello! What would you like to work on?", new AbortController().signal);
  expect(decision).toEqual({ decided: true, checkable: false, reason: "a greeting" });
  expect(session.tools).toEqual([["decide"]]);
  expect(triageMessage(["Add a farewell() helper", "continue"], "Done."))
    .toBe("The user's requests, in order:\n1. Add a farewell() helper\n2. continue\n\nThe agent's reply:\nDone.");
});

it("counts a failed, stopped or undecided first pass as undecided", async () => {
  session.turn = { status: "failed", reason: "no model" };
  expect(await triageAnswer(access, ["hi"], "Hello", new AbortController().signal)).toMatchObject({ decided: false });
  session.turn = { status: "completed", reply: "It is a greeting." };
  expect(await triageAnswer(access, ["hi"], "Hello", new AbortController().signal)).toMatchObject({ decided: false });
  session.decide = { checkable: false, reason: "small talk" };
  session.turn = { status: "cancelled" };
  expect(await triageAnswer(access, ["hi"], "Hello", new AbortController().signal)).toMatchObject({ decided: false });
});
