import { expect, it } from "vitest";
import { judgeWarnings, sameModel } from "../src/judge-warnings.js";

const choices = (overrides: Record<string, string>) => ({ agent: "codex:gpt-6-luna", explorer: "off", advisor: "off",
  reviewer: "codex:gpt-6-luna", refuter: "codex:gpt-6-luna", validator: "codex:gpt-6-luna", ...overrides });

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
    text: "the refuter tests the reviewer's findings, and both are OpenAI models" }]);
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
