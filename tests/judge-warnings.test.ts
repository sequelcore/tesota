import { expect, it } from "vitest";
import { judgeWarnings, sameModel } from "../src/judge-warnings.js";

const choices = (overrides: Record<string, string>) => ({ agent: "codex:gpt-6-luna", explorer: "off", advisor: "off",
  reviewer: "codex:gpt-6-luna", refuter: "codex:gpt-6-luna", validator: "codex:gpt-6-luna", triage: "codex:gpt-6-luna",
  namer: "codex:gpt-6-luna@low", searcher: "codex:gpt-6-luna", ...overrides });

it("treats a Claude Code alias and the model of its family on either Claude route as the same model", () => {
  expect(sameModel("claude-code:opus", "claude-code:opus")).toBe(true);
  expect(sameModel("claude-code:opus", "anthropic:claude-opus-5-5")).toBe(true);
  expect(sameModel("claude-code:claude-sonnet-5", "anthropic:claude-sonnet-5")).toBe(true);
  expect(sameModel("claude-code:opus", "claude-code:sonnet")).toBe(false);
  expect(sameModel("codex:gpt-6-sol", "codex:gpt-6-astra")).toBe(false);
  expect(sameModel("codex:gpt-6-sol", "claude-code:opus")).toBe(false);
});

it("warns when a judge uses the author's model, and notes when it is from the same lab", () => {
  const all = judgeWarnings(choices({}));
  expect(all).toContainEqual({ level: "same_model", judge: "reviewer", author: "agent",
    text: "the reviewer judges the agent's work, and both use codex:gpt-6-luna" });
  expect(all.map((warning) => `${warning.author}>${warning.judge}`).sort())
    .toEqual(["agent>refuter", "agent>reviewer", "agent>validator", "reviewer>refuter"]);
  const operator = judgeWarnings(choices({ agent: "claude-code:opus", reviewer: "codex:gpt-6-astra",
    refuter: "codex:gpt-6-sol", validator: "codex:gpt-6-luna" }));
  expect(operator).toEqual([{ level: "same_lab", judge: "refuter", author: "reviewer",
    text: "a second check tests the review's reported problems, and both are OpenAI models" }]);
});

it("checks the advisor against the roles that judge work it shaped, and skips roles that are off", () => {
  const advised = judgeWarnings(choices({ agent: "claude-code:opus", advisor: "codex:gpt-6-astra",
    reviewer: "codex:gpt-6-astra", refuter: "claude-code:fable", validator: "claude-code:haiku" }));
  expect(advised).toContainEqual({ level: "same_model", judge: "reviewer", author: "advisor",
    text: "the reviewer judges work the advisor's guidance shaped, and both use codex:gpt-6-astra" });
  expect(advised).toContainEqual(expect.objectContaining({ level: "same_lab", judge: "validator", author: "agent" }));
  expect(judgeWarnings(choices({ agent: "claude-code:opus", reviewer: "codex:gpt-6-astra", refuter: "claude-code:fable",
    validator: "claude-code:haiku" })).some((warning) => warning.author === "advisor")).toBe(false);
});

it("knows a model's lab through the gateways, and the same model on any route", () => {
  expect(sameModel("openrouter:anthropic/claude-opus-5.5", "anthropic:claude-opus-5-5")).toBe(true);
  expect(sameModel("opencode:gpt-6-luna", "codex:gpt-6-luna")).toBe(true);
  expect(sameModel("opencode-go:glm-5.3", "openrouter:z-ai/glm-5.3")).toBe(true);
  expect(sameModel("openrouter:qwen/qwen3.8-27b:free", "openrouter:qwen/qwen3.8-27b")).toBe(true);
  expect(sameModel("opencode:claude-opus-5-5", "claude-code:opus")).toBe(true);
  expect(sameModel("opencode:glm-5.3", "opencode:kimi-k3")).toBe(false);
  const warned = judgeWarnings(choices({ agent: "opencode-go:kimi-k3", reviewer: "openrouter:moonshotai/kimi-k2.6",
    refuter: "opencode:gpt-6-sol", validator: "codex:gpt-6-luna" }));
  expect(warned).toContainEqual(expect.objectContaining({ level: "same_lab", author: "agent", judge: "reviewer",
    text: "the reviewer judges the agent's work, and both are Moonshot AI models" }));
  // A router picks the model per request, and a stealth model hides its lab: no warning claims either way.
  expect(judgeWarnings(choices({ agent: "openrouter:auto", reviewer: "openrouter:auto", refuter: "opencode:big-pickle",
    validator: "opencode:big-pickle" })).filter((warning) => warning.author === "agent")).toEqual([]);
});
