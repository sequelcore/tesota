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

const work: readonly AddedRoute[] = [{ name: "codex-work", kind: "codex" }, { name: "claude-work", kind: "claude-code" }];

it("adds routes of the kinds that hold accounts, under names that are no kind's, and removes them", () => {
  const path = join(folder(), "routes.json");
  expect(readAddedRoutes(path)).toEqual([]);
  expect(addRoute("codex-work", "codex", path)).toEqual([{ name: "codex-work", kind: "codex" }]);
  addRoute("claude-work", "claude-code", path);
  expect(() => addRoute("codex-work", "codex", path)).toThrow("already a route");
  for (const reserved of ["codex", "claude-code", "typesafe", "off", "Codex_Work", "-work", "work-"]) {
    expect(() => addRoute(reserved, "codex", path), reserved).toThrow("cannot name a route");
  }
  expect(() => addRoute("keys", "openrouter", path)).toThrow("openrouter has one account");
  expect(removeRoute("codex-work", path)).toEqual([{ name: "claude-work", kind: "claude-code" }]);
});

it("reads an added route's choice as its own route of its kind, with the same models and levels", () => {
  expect(parseModelChoice("codex-work:gpt-6-luna@low", work)).toEqual({ route: "codex-work", kind: "codex", model: "gpt-6-luna",
    reasoning: "low" });
  expect(parseModelChoice("claude-work:sonnet", work)).toEqual({ route: "claude-work", kind: "claude-code", model: "sonnet" });
  expect(parseModelChoice("codex-home:gpt-6-luna", work)).toBeUndefined();
  expect(parseModelChoice("codex:gpt-6-luna", work)).toEqual({ route: "codex", kind: "codex", model: "gpt-6-luna" });
});

it("continues a conversation in place only on one account: the same route, or two kinds' own routes", () => {
  const choice = (value: string): ModelChoice => parseModelChoice(value, work) ?? { route: "", kind: "codex", model: "" };
  expect(sameAccount(choice("codex:gpt-6-luna"), choice("codex:gpt-6-sol"))).toBe(true);
  expect(sameAccount(choice("codex:gpt-6-luna"), choice("anthropic:claude-opus-5-5"))).toBe(true);
  expect(sameAccount(choice("codex-work:gpt-6-luna"), choice("codex-work:gpt-6-sol"))).toBe(true);
  expect(sameAccount(choice("codex:gpt-6-luna"), choice("codex-work:gpt-6-luna"))).toBe(false);
  expect(sameAccount(choice("claude-code:sonnet"), choice("claude-work:sonnet"))).toBe(false);
});

it("offers an added route its kind's models under its own name, paid by its own account", () => {
  const offered = offeredModels(work);
  const luna = offered.find((model) => model.id === "codex-work:gpt-6-luna");
  expect(luna).toMatchObject({ route: "codex-work", kind: "codex" });
  expect(modelCost(luna)).toMatch(/^your ChatGPT plan's limits \(codex-work\); list price/u);
  expect(offered.some((model) => model.id === "claude-work:sonnet")).toBe(true);
  expect(routeListing(offered)).toMatch(/^ {2}codex-work: .*gpt-6-luna/mu);
  expect(offered.filter((model) => model.route === "codex-work").length)
    .toBe(offered.filter((model) => model.route === "codex").length);
});

it("treats two routes of one kind as one lab, and the same model on both as the same model", () => {
  const choices = { ...readModelChoices(join(folder(), "models.json")), agent: "codex:gpt-6-luna", reviewer: "codex-work:gpt-6-luna",
    refuter: "claude-work:sonnet", validator: "codex-work:gpt-6-sol" };
  const warnings = judgeWarnings(choices, work);
  expect(warnings.find((warning) => warning.judge === "reviewer" && warning.author === "agent")?.level).toBe("same_model");
  expect(warnings.find((warning) => warning.judge === "validator" && warning.author === "agent")?.level).toBe("same_lab");
});

it("keeps an added route's login in a file of its own, beside the default route's", async () => {
  const directory = folder();
  const credential = { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000, accountId: "work" };
  await TesotaCredentials.forRoute("codex-work", "openai-codex", directory).modify("openai-codex", async () => credential);
  expect(existsSync(join(directory, "codex-work.json"))).toBe(true);
  expect(existsSync(join(directory, "codex.json"))).toBe(false);
  expect(await new TesotaCredentials(directory).read("openai-codex")).toBeUndefined();
  expect(await TesotaCredentials.forRoute("codex-work", "openai-codex", directory).read("openai-codex")).toMatchObject({ accountId: "work" });
});

it("names the route in a failed request, so the operator knows which account's plan refused it", async () => {
  let reply: TurnResult = { status: "failed", reason: "Codex error: The 'gpt-6-sol' model is not supported" };
  const session: ModelSession = { usable: true, run: async () => reply, dispose: () => undefined };
  const named = namingRoute("codex-work", session);
  expect(await named.run("x", new AbortController().signal))
    .toEqual({ status: "failed", reason: "codex-work: Codex error: The 'gpt-6-sol' model is not supported" });
  reply = { status: "completed", reply: "ok" };
  expect(await named.run("x", new AbortController().signal)).toEqual({ status: "completed", reply: "ok" });
  expect(named.usable).toBe(true);
});
