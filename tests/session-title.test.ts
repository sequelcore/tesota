import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TurnResult } from "../src/integrations/model-session-contract.js";
import { nameSession, titleMessage } from "../src/integrations/session-namer.js";
import { cleanTitle, seedTitle } from "../src/session-title.js";
import { openShellSessionStore } from "../src/shell-session-store.js";
import { replacesTitle } from "../src/verification/session-title-rule.js";

/**
 * A session's name (decision 036): the first request shortened at once, a
 * model's title after it, and the operator's own name above both.
 */

// The namer's session is captured here instead of reaching a model; `title` is what the model gives.
const session = vi.hoisted(() => ({ tools: [] as string[][], requests: [] as string[], title: undefined as string | undefined,
  turn: { status: "completed", reply: "" } as TurnResult }));
vi.mock("../src/integrations/model-session.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/integrations/model-session.js")>(),
  startModelSession: async (_access: unknown, options: { tools: readonly ToolDefinition[] }) => {
    session.tools.push(options.tools.map((tool) => tool.name));
    return { usable: true, dispose() {}, run: async (request: string) => {
      session.requests.push(request);
      const record = options.tools.find((tool) => tool.name === "title");
      if (session.title !== undefined) await record?.execute("t", { title: session.title } as never, undefined, undefined, undefined as never);
      return session.turn;
    } };
  },
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  session.tools.length = 0;
  session.requests.length = 0;
  session.title = undefined;
  session.turn = { status: "completed", reply: "" };
});

const access = { target: { engine: "claude-code" as const, route: "claude-code", model: "haiku" } };

it("names a session from its first request's first line, shortened at a word", () => {
  expect(seedTitle("Add a farewell() helper to src/greet.ts")).toBe("Add a farewell() helper to src/greet.ts");
  expect(seedTitle("\n\n  Revisa el presupuesto\ny agrega totales")).toBe("Revisa el presupuesto");
  expect(seedTitle("Refactor the pricing module so discounts and taxes are computed in one place")).toBe(
    "Refactor the pricing module so discounts and…");
  expect(seedTitle("  \n ")).toBeUndefined();
});

it("keeps a title to one printable line, without quotes, a final period or control characters", () => {
  expect(cleanTitle("\"Add farewell helper.\"")).toBe("Add farewell helper");
  expect(cleanTitle("Fix\u001b[31m login\nbug")).toBe("Fix [31m login bug");
  expect(cleanTitle("  ")).toBeUndefined();
  expect(cleanTitle("x".repeat(80))?.length).toBe(60);
});

it("lets the operator's name win, and a model's title replace only what shows at once", () => {
  expect(replacesTitle("counter", "request")).toBe(true);
  expect(replacesTitle("request", "generated")).toBe(true);
  expect(replacesTitle("generated", "generated")).toBe(false);
  expect(replacesTitle("operator", "generated")).toBe(false);
  expect(replacesTitle("request", "request")).toBe(false);
  expect(replacesTitle("generated", "operator")).toBe(true);
});

it("saves a session's name and where it came from, so a late title never undoes a rename", () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-titles-"));
  roots.push(root);
  const source = join(root, "repository");
  const store = openShellSessionStore(source, root);
  const { id } = store.create();
  expect(store.setTitle(id, "Add farewell() helper", "request")).toBe(true);
  expect(store.setTitle(id, "Budget totals", "operator")).toBe(true);
  expect(store.setTitle(id, "Farewell helper", "generated")).toBe(false);
  store.close();
  const reopened = openShellSessionStore(source, root);
  expect(reopened.list()[0]).toMatchObject({ title: "Budget totals", titleSource: "operator" });
  // The counter keeps counting past sessions that were named.
  expect(reopened.create().title).toBe("Session 1");
  reopened.close();
});

it("asks for a title from the requests alone, with only the title tool, and takes it only from a finished turn", async () => {
  session.title = "  \"Farewell helper\"  ";
  expect(await nameSession(access, ["Add a farewell() helper"], new AbortController().signal)).toBe("Farewell helper");
  expect(session.tools).toEqual([["title"]]);
  expect(session.requests[0]).toBe(titleMessage(["Add a farewell() helper"]));
  session.turn = { status: "failed", reason: "the model stopped" };
  expect(await nameSession(access, ["Add a farewell() helper"], new AbortController().signal)).toBeUndefined();
  session.title = undefined;
  session.turn = { status: "completed", reply: "Farewell helper" };
  expect(await nameSession(access, ["hi"], new AbortController().signal)).toBeUndefined();
  expect(titleMessage(["x".repeat(2_000)]).length).toBeLessThan(1_100);
});
