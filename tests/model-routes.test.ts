import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { namingRoute, sameAccount } from "../src/integrations/model-session.js";
import type { ModelSession, TurnResult } from "../src/integrations/model-session-contract.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";
import { judgeWarnings } from "../src/judge-warnings.js";
import { addRoute, type AddedRoute, type ModelChoice, parseModelChoice, readAddedRoutes, readModelChoices, removeRoute }
  from "../src/model-roles.js";
import { statusTable } from "../src/auth.js";
import { modelCost, offeredModels, routeListing } from "../src/models-command.js";

/**
 * Routes as a kind and one account (decision 050): the operator adds routes
 * of a kind under names of their own, whose models are the kind's, whose
 * account is their own, and whose failures say which account it was.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-routes-"));
  roots.push(root);
  return root;
}

const work: readonly AddedRoute[] = [{ name: "chatgpt-work", kind: "chatgpt" }, { name: "claude-work", kind: "claude-code" }];

it("adds routes of the kinds that hold accounts, under names that are no kind's, and removes them", () => {
  const path = join(folder(), "routes.json");
  expect(readAddedRoutes(path)).toEqual([]);
  expect(addRoute("chatgpt-work", "chatgpt", path)).toEqual([{ name: "chatgpt-work", kind: "chatgpt" }]);
  addRoute("claude-work", "claude-code", path);
  expect(() => addRoute("chatgpt-work", "chatgpt", path)).toThrow("already a route");
  for (const reserved of ["chatgpt", "claude-code", "typesafe", "off", "Codex_Work", "-work", "work-"]) {
    expect(() => addRoute(reserved, "chatgpt", path), reserved).toThrow("cannot name a route");
  }
  expect(() => addRoute("keys", "openrouter", path)).toThrow("openrouter has one account");
  expect(removeRoute("chatgpt-work", path)).toEqual([{ name: "claude-work", kind: "claude-code" }]);
});

it("reads an added route's choice as its own route of its kind, with the same models and levels", () => {
  expect(parseModelChoice("chatgpt-work:gpt-6-luna@low", work)).toEqual({ route: "chatgpt-work", kind: "chatgpt", model: "gpt-6-luna",
    reasoning: "low" });
  expect(parseModelChoice("claude-work:sonnet", work)).toEqual({ route: "claude-work", kind: "claude-code", model: "sonnet" });
  expect(parseModelChoice("chatgpt-home:gpt-6-luna", work)).toBeUndefined();
  expect(parseModelChoice("chatgpt:gpt-6-luna", work)).toEqual({ route: "chatgpt", kind: "chatgpt", model: "gpt-6-luna" });
});

it("continues a conversation in place only on one account: the same route, or two kinds' own routes", () => {
  const choice = (value: string): ModelChoice => parseModelChoice(value, work) ?? { route: "", kind: "chatgpt", model: "" };
  expect(sameAccount(choice("chatgpt:gpt-6-luna"), choice("chatgpt:gpt-6-sol"))).toBe(true);
  expect(sameAccount(choice("chatgpt:gpt-6-luna"), choice("anthropic:claude-opus-5-5"))).toBe(true);
  expect(sameAccount(choice("chatgpt-work:gpt-6-luna"), choice("chatgpt-work:gpt-6-sol"))).toBe(true);
  expect(sameAccount(choice("chatgpt:gpt-6-luna"), choice("chatgpt-work:gpt-6-luna"))).toBe(false);
  expect(sameAccount(choice("claude-code:sonnet"), choice("claude-work:sonnet"))).toBe(false);
});

it("offers an added route its kind's models under its own name, paid by its own account", () => {
  const offered = offeredModels(work);
  const luna = offered.find((model) => model.id === "chatgpt-work:gpt-6-luna");
  expect(luna).toMatchObject({ route: "chatgpt-work", kind: "chatgpt" });
  expect(modelCost(luna)).toMatch(/^your ChatGPT plan's limits \(chatgpt-work\); list price/u);
  expect(offered.some((model) => model.id === "claude-work:sonnet")).toBe(true);
  expect(routeListing(offered)).toMatch(/^ {2}chatgpt-work: .*gpt-6-luna/mu);
  expect(offered.filter((model) => model.route === "chatgpt-work").length)
    .toBe(offered.filter((model) => model.route === "chatgpt").length);
});

it("treats two routes of one kind as one lab, and the same model on both as the same model", () => {
  const choices = { ...readModelChoices(join(folder(), "models.json")), agent: "chatgpt:gpt-6-luna", reviewer: "chatgpt-work:gpt-6-luna",
    refuter: "claude-work:sonnet", validator: "chatgpt-work:gpt-6-sol" };
  const warnings = judgeWarnings(choices, work);
  expect(warnings.find((warning) => warning.judge === "reviewer" && warning.author === "agent")?.level).toBe("same_model");
  expect(warnings.find((warning) => warning.judge === "validator" && warning.author === "agent")?.level).toBe("same_lab");
});

it("keeps an added route's login in a file of its own, beside the default route's", async () => {
  // The store creates its folder itself, so it can confirm who owns it.
  const directory = join(folder(), "auth");
  const credential = { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000, accountId: "work" };
  await TesotaCredentials.forRoute("chatgpt-work", "openai", directory).modify("openai", async () => credential);
  expect(existsSync(join(directory, "chatgpt-work.json"))).toBe(true);
  expect(existsSync(join(directory, "chatgpt.json"))).toBe(false);
  expect(await new TesotaCredentials(directory).read("openai")).toBeUndefined();
  expect(await TesotaCredentials.forRoute("chatgpt-work", "openai", directory).read("openai")).toMatchObject({ accountId: "work" });
});

it("names the route in a failed request, so the operator knows which account's plan refused it", async () => {
  let reply: TurnResult = { status: "failed", reason: "Codex error: The 'gpt-6-sol' model is not supported" };
  const session: ModelSession = { usable: true, run: async () => reply, dispose: () => undefined };
  const named = namingRoute("chatgpt-work", session);
  expect(await named.run("x", new AbortController().signal))
    .toEqual({ status: "failed", reason: "chatgpt-work: Codex error: The 'gpt-6-sol' model is not supported" });
  reply = { status: "completed", reply: "ok" };
  expect(await named.run("x", new AbortController().signal)).toEqual({ status: "completed", reply: "ok" });
  expect(named.usable).toBe(true);
});

it("shows every route's sign-in as one table, its account and the roles that use it, and says once what a sign-in does not show", () => {
  const ours = { id: "45e4b49f", email: "r3xed@outlook.es" };
  const rows = [{ route: "chatgpt", kind: "ChatGPT", signIn: "signed in", account: { id: "acct-1", email: "plus@example.com" } },
    { route: "chatgpt-free1", kind: "ChatGPT", signIn: "signed out: tesota auth login chatgpt-free1" },
    { route: "claude-code", kind: "Claude Code", signIn: "signed in with claude.ai (your own Claude Code)", account: ours },
    { route: "claude-2", kind: "Claude Code", signIn: "signed in with claude.ai", account: ours }];
  const usedBy = (route: string): string[] => route === "chatgpt" ? ["reviewer", "refuter"] : route === "claude-2" ? ["advisor"] : [];
  const table = statusTable(rows, usedBy);
  const lines = table.split("\n");
  expect(lines[0]).toMatch(/^Route {10}Kind {9}Sign-in {42}Account {10}Used by$/u);
  expect(lines[1]).toMatch(/^chatgpt {8}.*signed in {40}pl…@example\.com +reviewer, refuter$/u);
  expect(lines[2]).toMatch(/^chatgpt-free1 {2}ChatGPT .*signed out: tesota auth login chatgpt-free1 +— +—$/u);
  // Emails are masked unless shown; two routes on one account are named once under the table (#235).
  expect(table).not.toContain("r3xed@outlook.es");
  expect(table).toContain("claude-code and claude-2 are signed in to the same account");
  expect(table).toContain("tesota auth status --show-accounts");
  expect(table.match(/checked when a role first uses them/gu)).toHaveLength(1);
  const shown = statusTable(rows, usedBy, true);
  expect(shown).toContain("r3xed@outlook.es");
  expect(shown).not.toContain("--show-accounts");
});
