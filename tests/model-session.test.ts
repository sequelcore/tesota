import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openModelTarget } from "../src/integrations/model-session.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function credentials(): TesotaCredentials {
  const root = mkdtempSync(join(tmpdir(), "tesota-routes-"));
  roots.push(root);
  return new TesotaCredentials(join(root, "auth"));
}

it("sends each route to its engine and model", async () => {
  const store = credentials();
  expect(await openModelTarget("claude-code:opus", undefined, store)).toEqual({ engine: "claude-code", model: "opus" });
  const codex = await openModelTarget("codex:gpt-6-luna", undefined, store);
  expect(codex.engine === "pi" && [codex.model.provider, codex.model.id]).toEqual(["openai-codex", "gpt-6-luna"]);
  const anthropic = await openModelTarget("anthropic:claude-opus-5-5", undefined, store);
  expect(anthropic.engine === "pi" && [anthropic.model.provider, anthropic.model.id]).toEqual(["anthropic", "claude-opus-5-5"]);
});

it("refuses a choice that is not route:model, or a model the route does not have", async () => {
  const store = credentials();
  await expect(openModelTarget("gpt-6-luna", undefined, store)).rejects.toThrow("not a route:model choice");
  await expect(openModelTarget("codex:claude-opus-5-5", undefined, store)).rejects.toThrow("unavailable");
});
