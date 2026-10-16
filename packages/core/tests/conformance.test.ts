import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, Session } from "../../../src/contract.ts";
import { piEngine } from "./adapters/pi.ts";
import { tesotaEngine } from "./adapters/tesota.ts";
import type { Capability, Guarantee, ScriptStep, TestEngine } from "./engine.ts";

/** Every engine Tesota can run on: Pi as the reference, and `@tesota/core`. */
const engines: readonly TestEngine[] = [piEngine, tesotaEngine];

const open: Session[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const echo = (pi: ExtensionAPI) => pi.registerTool({
  name: "echo", label: "Echo", description: "Returns its text.", parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, params) => ({ content: [{ type: "text", text: params.text }], details: undefined }),
});

const sendBackOnce = (customType: string): ExtensionFactory => (pi) => {
  let sent = false;
  pi.on("agent_before_settle", () => {
    if (sent) return undefined;
    sent = true;
    return { entries: [{ type: "custom_message", customType, content: "Not verified; try again.", display: true }], continue: true };
  });
};

for (const engine of engines) {
  /** Every test here needs extensions' events; an engine without what a test needs yet skips it, naming the slice that brings it. */
  const check = (name: string, run: () => Promise<void>, needs: Capability = "events") => {
    const waiting = engine.pending.get(needs);
    return waiting === undefined ? test(name, run) : test.skip(`${name} (waits for ${waiting})`, run);
  };
  /** A test of a guarantee this engine lacks runs as expected to fail. */
  const guaranteed = (guarantee: Guarantee, name: string, run: () => Promise<void>) => {
    const waiting = engine.pending.get("events");
    return waiting !== undefined ? test.skip(`${name} (waits for ${waiting})`, run)
      : engine.lacks.has(guarantee) ? test.failing(`${name} (${engine.name} lacks it)`, run) : test(name, run);
  };

  const start = async (script: readonly ScriptStep[], extensions: readonly ExtensionFactory[], slow = false) => {
    const session = await engine.createSession({ cwd: mkdtempSync(join(tmpdir(), "tesota-core-cwd-")), script, extensions, slow });
    open.push(session);
    return session;
  };

  describe(engine.name, () => {
    check("events arrive in order, and input handlers finish before the agent's first step", async () => {
      const seen: string[] = [];
      const session = await start([{ tool: "read", args: { path: "missing.txt" } }, "done"], [(pi) => {
        pi.on("session_start", (event) => { seen.push(`session_start:${event.reason}`); });
        pi.on("input", async (event) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          seen.push(`input:${event.text}:${event.source}`);
          return undefined;
        });
        pi.on("tool_execution_start", (event) => { seen.push(`tool_execution_start:${event.toolName}`); });
        pi.on("tool_result", (event) => { seen.push(`tool_result:${event.toolName}:${String(event.input["path"])}:${event.isError}`); });
        pi.on("agent_before_settle", (event) => { seen.push(`agent_before_settle:${event.outcome}`); return undefined; });
      }]);
      await session.prompt("go");
      expect(seen).toEqual(["session_start:startup", "input:go:interactive", "tool_execution_start:read",
        "tool_result:read:missing.txt:true", "agent_before_settle:completed"]);
      expect(session.outcome()).toBe("completed");
    });

    check("a settle handler sends the agent back once, and the agent answers again", async () => {
      const session = await start(["first", "second"], [sendBackOnce("gate")]);
      await session.prompt("go");
      expect(session.messages().map((message) => message.customType ?? message.role))
        .toEqual(["user", "assistant", "gate", "assistant"]);
      expect(session.lastAssistantText()).toBe("second");
    });

    check("an empty result from a later settle handler keeps the earlier send-back", async () => {
      const session = await start(["first", "second"], [sendBackOnce("gate"), (pi) => { pi.on("agent_before_settle", () => undefined); }]);
      await session.prompt("go");
      expect(session.lastAssistantText()).toBe("second");
    });

    guaranteed("settle-results-accumulate", "a later settle handler cannot cancel an earlier send-back or drop its message", async () => {
      const session = await start(["first", "second", "third"], [sendBackOnce("gate"), (pi) => {
        pi.on("agent_before_settle", () => ({ entries: [], continue: false }));
      }]);
      await session.prompt("go");
      expect(session.messages().some((message) => message.customType === "gate")).toBe(true);
      expect(session.lastAssistantText()).toBe("second");
    });

    check("a settle handler that throws does not stop the run from settling", async () => {
      const session = await start(["first"], [(pi) => { pi.on("agent_before_settle", () => { throw new Error("verifier crashed"); }); }]);
      await session.prompt("go");
      expect(session.lastAssistantText()).toBe("first");
    });

    guaranteed("settle-failure-is-incomplete", "a settle handler that throws ends the run as incomplete", async () => {
      const session = await start(["first"], [(pi) => { pi.on("agent_before_settle", () => { throw new Error("verifier crashed"); }); }]);
      await session.prompt("go");
      expect(session.outcome()).toBe("incomplete");
    });

    check("an aborted run settles as aborted, and no settle handler treats it as completed", async () => {
      const outcomes: string[] = [];
      const session = await start(["a long answer that streams slowly enough to be stopped part of the way through"], [(pi) => {
        pi.on("agent_before_settle", (event) => { outcomes.push(event.outcome); return undefined; });
      }], true);
      const run = session.prompt("go");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await session.abort();
      await run;
      expect(session.outcome()).toBe("aborted");
      expect(outcomes).not.toContain("completed");
    });

    check("handlers see the session's folder, model, context usage and branch", async () => {
      let seen: ExtensionContext | undefined;
      let branch = 0;
      const session = await start(["done"], [(pi) => {
        pi.on("agent_before_settle", (_event, ctx) => {
          seen = ctx;
          branch = ctx.sessionManager.getBranch().length;
          return undefined;
        });
      }]);
      await session.prompt("go");
      expect(seen?.cwd).toMatch(/tesota-core-cwd-/);
      expect(seen?.model?.provider).toBeString();
      expect(typeof seen?.mode).toBe("string");
      expect(seen?.getContextUsage()?.contextWindow).toBeGreaterThan(0);
      expect(branch).toBeGreaterThan(0);
    }, "tools");

    guaranteed("settle-can-be-cancelled", "stopping the run stops a settle handler, which is awaited, and the run ends aborted", async () => {
      let stopped = false;
      let started: () => void = () => undefined;
      const settling = new Promise<void>((resolve) => { started = resolve; });
      const session = await start(["done"], [(pi) => {
        pi.on("agent_before_settle", async (_event, ctx) => {
          started();
          await new Promise((resolve) => {
            ctx.signal?.addEventListener("abort", resolve);
            setTimeout(resolve, 2000);
          });
          stopped = ctx.signal?.aborted === true;
          return undefined;
        });
      }]);
      const run = session.prompt("go");
      await settling;
      await session.abort();
      await run;
      expect(stopped).toBe(true);
      expect(session.outcome()).toBe("aborted");
    });

    check("a verifier asks a model through the session's model registry", async () => {
      let answer: string | undefined;
      const session = await start(["done", "the model's answer"], [(pi) => {
        pi.on("agent_before_settle", async (_event, ctx) => {
          const model = ctx.model === undefined ? undefined : ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
          if (model === undefined) return undefined;
          const reply = await ctx.modelRegistry.complete(model,
            { messages: [{ role: "user", content: [{ type: "text", text: "check" }], timestamp: Date.now() }] });
          answer = reply.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          return undefined;
        });
      }]);
      await session.prompt("go");
      expect(answer).toBe("the model's answer");
    });

    check("tools, flags and settings an extension registers and reads", async () => {
      let active: string[] = [];
      let flag: boolean | string | undefined = "unset";
      let quiet: boolean | string | undefined;
      const session = await start(["done"], [echo, (pi) => {
        pi.registerFlag("claimcheck-model", { type: "string", description: "A second model" });
        pi.on("session_start", () => {
          if (!pi.getActiveTools().includes("echo")) pi.setActiveTools([...pi.getActiveTools(), "echo"]);
          active = pi.getActiveTools();
          flag = pi.getFlag("claimcheck-model");
          quiet = pi.getSettings().quietStartup;
          expect(typeof pi.getThinkingLevel()).toBe("string");
        });
      }]);
      await session.prompt("go");
      expect(active).toContain("echo");
      expect(flag).toBeUndefined();
      expect(quiet === undefined || ["boolean", "string"].includes(typeof quiet)).toBe(true);
    }, "tools");

    /** A tool whose call fails as `how` says, or returns its text with details. */
    const tool = (name: string, how: "returns" | "fails" | "throws" = "returns", extra: object = {}): ExtensionFactory => (pi) => {
      pi.registerTool({
        name, label: name, description: `The ${name} tool.`, parameters: Type.Object({ text: Type.String() }), ...extra,
        execute: async (_id, params) => {
          if (how === "throws") throw new Error(`${name} broke`);
          return { content: [{ type: "text", text: params.text }], details: { echoed: params.text }, ...how === "fails" ? { isError: true } : {} };
        },
      });
    };
    const detailsOf = (entry: { readonly message?: unknown }) => (entry.message as { details?: unknown } | undefined)?.details;

    check("an extension's tool runs for the model, and a resumed session keeps its details", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const first = await engine.createSession({ cwd, script: [{ tool: "echo", args: { text: "hi" } }, "done"], extensions: [tool("echo")] });
      open.push(first);
      await first.prompt("go");
      expect(first.messages().find((message) => message.role === "toolResult")).toMatchObject({ toolName: "echo", text: "hi", isError: false });
      let details: unknown;
      const resumed = await engine.resume(first, { cwd, script: ["again"], extensions: [tool("echo"), (pi) => {
        pi.on("agent_before_settle", (_event, ctx) => {
          details = ctx.sessionManager.getBranch().map(detailsOf).find((found) => found !== undefined);
          return undefined;
        });
      }] });
      open.push(resumed);
      await resumed.prompt("once more");
      expect(details).toEqual({ echoed: "hi" });
    });

    check("a tool that returns an error and one that throws both fail the call", async () => {
      const session = await start([{ calls: [{ tool: "failing", args: { text: "no" } }, { tool: "throwing", args: { text: "no" } }] }, "done"],
        [tool("failing", "fails"), tool("throwing", "throws")]);
      await session.prompt("go");
      expect(session.messages().filter((message) => message.role === "toolResult").map(({ toolName, isError }) => [toolName, isError]))
        .toEqual([["failing", true], ["throwing", true]]);
    });

    check("a tool registered inactive cannot run until activated, and a resumed session keeps it active", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const call: ScriptStep = { tool: "hidden", args: { text: "hi" } };
      const hidden = tool("hidden", "returns", { defaultActive: false });
      let active: string[] = [];
      const activate: ExtensionFactory = (pi) => {
        pi.on("input", (event) => {
          if (event.text === "activate") pi.setActiveTools([...pi.getActiveTools(), "hidden", "hidden", "no such tool"]);
          active = pi.getActiveTools();
          return undefined;
        });
      };
      const first = await engine.createSession({ cwd, script: [call, "before", call, "after"], extensions: [hidden, activate] });
      open.push(first);
      await first.prompt("go");
      await first.prompt("activate");
      expect(active.filter((name) => name === "hidden")).toHaveLength(1);
      expect(active).not.toContain("no such tool");
      const resumed = await engine.resume(first, { cwd, script: [call, "resumed"], extensions: [hidden] });
      open.push(resumed);
      await resumed.prompt("go on");
      expect(resumed.messages().filter((message) => message.role === "toolResult").map(({ isError }) => isError))
        .toEqual([true, false, false]);
    });

    check("an active tool's snippet and guidelines reach the system prompt", async () => {
      let prompt = "";
      // Both engines send the system prompt as a system message; Pi splits it into sections.
      const systemText = (context: { messages: readonly unknown[] }) => context.messages.flatMap((message) => {
        const { role, content, sections } = message as { role: string; content?: unknown; sections?: Record<string, string> };
        return role === "system" ? [String(content ?? ""), ...Object.values(sections ?? {})] : [];
      }).join("\n");
      const session = await start([{ seen: (context) => { prompt = systemText(context); }, reply: "done" }],
        [tool("lookup", "returns", { promptSnippet: "Look   a word\n up", promptGuidelines: ["  Look up before guessing ", "Look up before guessing"] })]);
      await session.prompt("go");
      expect(prompt).toContain("- lookup: Look a word up");
      expect(prompt.split("Look up before guessing")).toHaveLength(2);
    });

    check("two sessions in one process run at the same time, each with its own messages and usage", async () => {
      const [a, b] = await Promise.all([start(["from a", "a again"], [sendBackOnce("gate-a")]), start(["from b"], [])]);
      expect(b?.stats().tokens.total).toBe(0);
      await Promise.all([a?.prompt("first"), b?.prompt("second")]);
      expect(a?.lastAssistantText()).toBe("a again");
      expect(b?.lastAssistantText()).toBe("from b");
      expect(b?.messages().some((message) => message.customType === "gate-a")).toBe(false);
      expect(a?.stats().tokens.total).toBeGreaterThan(0);
      expect(b?.stats().tokens.total).toBeGreaterThan(0);
    });
  });
}
