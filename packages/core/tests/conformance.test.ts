import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, Session } from "../../../src/contract.ts";
import { tesotaEngine } from "./adapters/tesota.ts";
import type { ScriptStep, TestEngine } from "./engine.ts";

/** The engine: the contract Tesota uses, as `@tesota/core` meets it. */
const engines: readonly TestEngine[] = [tesotaEngine];

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
  const start = async (script: readonly ScriptStep[], extensions: readonly ExtensionFactory[], slow = false) => {
    const session = await engine.createSession({ cwd: mkdtempSync(join(tmpdir(), "tesota-core-cwd-")), script, extensions, slow });
    open.push(session);
    return session;
  };

  describe(engine.name, () => {
    test("events arrive in order, and input handlers finish before the agent's first step", async () => {
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

    test("stopping during a tool start handler prevents the write and records a stopped call", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      let entered: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const session = await engine.createSession({ cwd,
        script: [{ tool: "write", args: { path: "after-stop.md", content: "after stop" } }, "never reached"],
        extensions: [(pi) => {
          pi.on("tool_execution_start", async () => {
            entered();
            await waiting;
          });
        }],
      });
      open.push(session);
      const run = session.prompt("go");
      await started;
      const stopping = session.abort();
      release();
      await Promise.all([run, stopping]);
      expect(session.outcome()).toBe("aborted");
      expect(existsSync(join(cwd, "after-stop.md"))).toBe(false);
      expect(session.messages().filter((message) => message.role === "toolResult"))
        .toMatchObject([{ toolName: "write", isError: true }]);
    });

    test("a settle handler sends the agent back once, and the agent answers again", async () => {
      const session = await start(["first", "second"], [sendBackOnce("gate")]);
      await session.prompt("go");
      expect(session.messages().map((message) => message.customType ?? message.role))
        .toEqual(["user", "assistant", "gate", "assistant"]);
      expect(session.lastAssistantText()).toBe("second");
    });

    test("an empty result from a later settle handler keeps the earlier send-back", async () => {
      const session = await start(["first", "second"], [sendBackOnce("gate"), (pi) => { pi.on("agent_before_settle", () => undefined); }]);
      await session.prompt("go");
      expect(session.lastAssistantText()).toBe("second");
    });

    test("a later settle handler cannot cancel an earlier send-back or drop its message", async () => {
      const session = await start(["first", "second", "third"], [sendBackOnce("gate"), (pi) => {
        pi.on("agent_before_settle", () => ({ entries: [], continue: false }));
      }]);
      await session.prompt("go");
      expect(session.messages().some((message) => message.customType === "gate")).toBe(true);
      expect(session.lastAssistantText()).toBe("second");
    });

    test("a settle handler that throws does not stop the run from settling", async () => {
      const session = await start(["first"], [(pi) => { pi.on("agent_before_settle", () => { throw new Error("verifier crashed"); }); }]);
      await session.prompt("go");
      expect(session.lastAssistantText()).toBe("first");
    });

    test("a settle handler that throws ends the run as incomplete", async () => {
      const session = await start(["first"], [(pi) => { pi.on("agent_before_settle", () => { throw new Error("verifier crashed"); }); }]);
      await session.prompt("go");
      expect(session.outcome()).toBe("incomplete");
    });

    test("an aborted run settles as aborted, and no settle handler treats it as completed", async () => {
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

    test("handlers see the session's folder, model, context usage and branch", async () => {
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
    });

    test("stopping the run stops a settle handler, which is awaited, and the run ends aborted", async () => {
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

    test("a verifier asks a model through the session's model registry", async () => {
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

    test("tools, flags and settings an extension registers and reads", async () => {
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
    });

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

    test("an extension's tool runs for the model, and a resumed session keeps its details", async () => {
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

    test("a tool that returns an error and one that throws both fail the call", async () => {
      const session = await start([{ calls: [{ tool: "failing", args: { text: "no" } }, { tool: "throwing", args: { text: "no" } }] }, "done"],
        [tool("failing", "fails"), tool("throwing", "throws")]);
      await session.prompt("go");
      expect(session.messages().filter((message) => message.role === "toolResult").map(({ toolName, isError }) => [toolName, isError]))
        .toEqual([["failing", true], ["throwing", true]]);
    });

    test("a tool registered inactive cannot run until activated, and a resumed session keeps it active", async () => {
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

    test("an active tool's snippet and guidelines reach the system prompt", async () => {
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

    test("a tool deactivated during a call still runs that call, and leaves the prompt from the next request", async () => {
      let prompts: string[] = [];
      // The last system message is the prompt in force: Pi adds one when the tools change.
      const systemOf = (context: { messages: readonly unknown[] }) => context.messages.flatMap((message) => {
        const { role, content, sections } = message as { role: string; content?: unknown; sections?: Record<string, string> };
        return role === "system" ? [[String(content ?? ""), ...Object.values(sections ?? {})].join("\n")] : [];
      }).at(-1) ?? "";
      const see = (step: ScriptStep | string): ScriptStep => typeof step === "string"
        ? { seen: (context) => { prompts = [...prompts, systemOf(context)]; }, reply: step } : step;
      const lookup = tool("lookup", "returns", { promptSnippet: "Look a word up" });
      const drop: ExtensionFactory = (pi) => {
        pi.on("tool_execution_start", () => { pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "lookup")); });
      };
      const session = await start([{ tool: "lookup", args: { text: "word" } }, see("done")], [lookup, drop]);
      await session.prompt("go");
      expect(session.messages().find((message) => message.role === "toolResult")).toMatchObject({ toolName: "lookup", isError: false });
      expect(prompts.at(-1)).not.toContain("- lookup: Look a word up");
    });

    test("the same tools reach the model in the same order and words, whatever order they were turned on in (#779)", async () => {
      // A provider caches the request's head: the same tools in another order would be written to the cache again.
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const sent = async (order: readonly string[]) => {
        let request = "";
        const activate: ExtensionFactory = (pi) => {
          pi.on("input", () => { for (const name of order) pi.setActiveTools([...pi.getActiveTools(), name]); return undefined; });
        };
        // The prompt and tools as sent, but for each session's own scratch folder and when it started.
        const head = (context: Context) => JSON.stringify(context.messages.filter(({ role }) => role === "system"),
          (key, value: unknown) => key === "timestamp" ? undefined : value).replace(/[\w-]+\.scratch/gu, "<scratch>");
        const session = await engine.createSession({ cwd, script: [{ seen: (context) => { request = head(context); }, reply: "done" }],
          extensions: [tool("beta", "returns", { defaultActive: false, promptSnippet: "Beta" }),
            tool("alpha", "returns", { defaultActive: false, promptSnippet: "Alpha" }), activate] });
        await session.prompt("go");
        await session.dispose();
        return request;
      };
      const forward = await sent(["alpha", "beta"]);
      expect(forward).toContain("- alpha: Alpha");
      expect(await sent(["beta", "alpha"])).toBe(forward);
    });

    test("a session's requests repeat the same prompt and tools while nothing changes them (#779)", async () => {
      const heads: string[] = [];
      const see = (reply: string): ScriptStep => ({
        seen: (context) => { heads.push(JSON.stringify(context.messages.filter(({ role }) => role === "system"))); }, reply });
      const session = await start([{ tool: "echo", args: { text: "hi" } }, see("first"), see("second")], [echo]);
      await session.prompt("go");
      await session.prompt("again");
      expect(heads).toHaveLength(2);
      expect(heads[1]).toBe(heads[0]);
    });

    test("a tool turned on mid-run leaves the head as it was and reaches the model appended after the results (#779)", async () => {
      const sent: Context[] = [];
      const see = (reply: string): ScriptStep => ({ seen: (context) => { sent.push(structuredClone(context)); }, reply });
      const turnOn: ExtensionFactory = (pi) => {
        pi.on("tool_execution_start", () => { pi.setActiveTools([...pi.getActiveTools(), "late"]); });
      };
      const session = await start([see("first"), { tool: "echo", args: { text: "hi" } }, see("done")],
        [echo, tool("late", "returns", { defaultActive: false, promptSnippet: "Late" }), turnOn]);
      await session.prompt("go");
      await session.prompt("again");
      const [before, after] = sent;
      expect(after?.messages[0]).toEqual(before?.messages[0]);
      const changes = after?.messages.slice(1).flatMap((message, index) => message.role === "system" ? [{ message, index: index + 1 }] : []) ?? [];
      expect(changes).toHaveLength(1);
      expect(changes[0]?.message).toMatchObject({ toolsAdded: [{ name: "late" }], sections: { tools: expect.stringContaining("- late: Late") } });
      expect(after?.messages[(changes[0]?.index ?? 0) - 1]?.role).toBe("toolResult");
    });

    test("a resumed session sends the system messages it had (#779)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      let last = "";
      const system = (context: Context) => JSON.stringify(context.messages.filter(({ role }) => role === "system"));
      const turnOn: ExtensionFactory = (pi) => {
        pi.on("input", (event) => { if (event.text === "activate") pi.setActiveTools([...pi.getActiveTools(), "late"]); return undefined; });
      };
      const late = tool("late", "returns", { defaultActive: false, promptSnippet: "Late" });
      const first = await engine.createSession({ cwd, script: ["started", { seen: (context) => { last = system(context); }, reply: "activated" }],
        extensions: [late, turnOn] });
      await first.prompt("go");
      await first.prompt("activate");
      let resumedHead = "";
      const resumed = await engine.resume(first, { cwd, script: [{ seen: (context) => { resumedHead = system(context); }, reply: "again" }],
        extensions: [late, turnOn] });
      open.push(resumed);
      await resumed.prompt("go on");
      expect(last).toContain("- late: Late");
      expect(resumedHead).toBe(last);
    });

    test("a tool registered as the session starts keeps its activation across a resume", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const late: ExtensionFactory = (pi) => {
        pi.on("session_start", () => {
          if (!pi.getActiveTools().includes("late")) {
            pi.registerTool({ name: "late", label: "late", description: "Registered late.", parameters: Type.Object({ text: Type.String() }),
              defaultActive: false, execute: async (_id, params) => ({ content: [{ type: "text", text: params.text }], details: undefined }) });
          }
        });
        pi.on("input", (event) => { if (event.text === "activate") pi.setActiveTools([...pi.getActiveTools(), "late"]); return undefined; });
      };
      const first = await engine.createSession({ cwd, script: ["activated"], extensions: [late] });
      open.push(first);
      await first.prompt("activate");
      const resumed = await engine.resume(first, { cwd, script: [{ tool: "late", args: { text: "hi" } }, "done"], extensions: [late] });
      open.push(resumed);
      await resumed.prompt("use it");
      expect(resumed.messages().find((message) => message.role === "toolResult")).toMatchObject({ toolName: "late", isError: false });
    });

    test("a resumed session keeps the tools it had, though an extension's default changed since", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const first = await engine.createSession({ cwd, script: ["done"], extensions: [tool("helper")] });
      open.push(first);
      await first.prompt("go");
      const resumed = await engine.resume(first, { cwd, script: [{ tool: "helper", args: { text: "hi" } }, "done"],
        extensions: [tool("helper", "returns", { defaultActive: false })] });
      open.push(resumed);
      await resumed.prompt("use it");
      expect(resumed.messages().find((message) => message.role === "toolResult")).toMatchObject({ toolName: "helper", isError: false });
    });

    test("a failed call is failed in the tool_result event, and still failed in a resumed session", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const events: [string, boolean][] = [];
      const watch: ExtensionFactory = (pi) => { pi.on("tool_result", (event) => { events.push([event.toolName, event.isError]); }); };
      const failing = [tool("failing", "fails"), tool("throwing", "throws")];
      const first = await engine.createSession({ cwd, script: [{ calls: [{ tool: "failing", args: { text: "no" } },
        { tool: "throwing", args: { text: "no" } }] }, "done"], extensions: [...failing, watch] });
      open.push(first);
      await first.prompt("go");
      expect(events).toEqual([["failing", true], ["throwing", true]]);
      const resumed = await engine.resume(first, { cwd, script: ["again"], extensions: failing });
      open.push(resumed);
      expect(resumed.messages().filter((message) => message.role === "toolResult").map(({ toolName, isError }) => [toolName, isError]))
        .toEqual([["failing", true], ["throwing", true]]);
    });

    test("context usage after a reply is that reply's usage, and the same after a resume", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tesota-core-cwd-"));
      const usage: (number | null | undefined)[] = [];
      const read: ExtensionFactory = (pi) => {
        pi.on("agent_before_settle", (_event, ctx) => {
          const replies = ctx.sessionManager.getBranch().flatMap(({ message }) => message?.role === "assistant" ? [message] : []);
          const last = replies.at(-1) as { usage?: { totalTokens: number } } | undefined;
          usage.push(last?.usage?.totalTokens, ctx.getContextUsage()?.tokens);
          return undefined;
        });
      };
      const first = await engine.createSession({ cwd, script: ["a reply of some length"], extensions: [read] });
      open.push(first);
      await first.prompt("go");
      const resumed = await engine.resume(first, { cwd, script: ["another reply"], extensions: [read] });
      open.push(resumed);
      await resumed.prompt("again");
      expect(usage[0]).toBeGreaterThan(0);
      expect(usage[1]).toBe(usage[0]);
      expect(usage[3]).toBe(usage[2]);
    });

    test("two sessions in one process run at the same time, each with its own messages and usage", async () => {
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
