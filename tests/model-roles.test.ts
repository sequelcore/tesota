import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { chooseModel, DEFAULT_MODEL, parseModelChoice, readModelChoices } from "../src/model-roles.js";
import { runModelsCommand, type OfferedModel } from "../src/models-command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-models-"));
  roots.push(root);
  return join(root, "models.json");
}
const offered: OfferedModel[] = [
  { id: "codex:gpt-6-luna", route: "codex", name: "Luna", price: { input: 0.1, output: 0.5 } },
  { id: "codex:gpt-6-sol", route: "codex", name: "Sol", price: { input: 2, output: 10 } },
  { id: "anthropic:claude-opus-5-5", route: "anthropic", name: "Opus 5.5", price: { input: 4, output: 20 } },
  { id: "claude-code:opus", route: "claude-code", name: "Claude Code's opus" },
];
const ids = offered.map((model) => model.id);

it("reads route:model and nothing else", () => {
  expect(parseModelChoice("codex:gpt-6-luna")).toEqual({ route: "codex", model: "gpt-6-luna" });
  expect(parseModelChoice("claude-code:opus")).toEqual({ route: "claude-code", model: "opus" });
  expect(parseModelChoice("anthropic:claude-opus-5-5")).toEqual({ route: "anthropic", model: "claude-opus-5-5" });
  for (const value of ["gpt-6-luna", "off", "openai:gpt-6", "codex:", ":opus", "codex:bad model", "codex:a/b"]) {
    expect(parseModelChoice(value)).toBeUndefined();
  }
});

it("gives every role the default until the operator chooses, with explorers off", () => {
  expect(readModelChoices(file())).toEqual({ agent: DEFAULT_MODEL, explorer: "off", reviewer: DEFAULT_MODEL,
    refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL });
  expect(DEFAULT_MODEL).toBe("codex:gpt-6-luna");
});

it("turns explorers on with a model and off again, and accepts off for no other role", () => {
  const path = file();
  expect(chooseModel("explorer", "codex:gpt-6-luna", ids, path).explorer).toBe("codex:gpt-6-luna");
  expect(chooseModel("explorer", "off", ids, path).explorer).toBe("off");
  expect(() => chooseModel("reviewer", "off", ids, path)).toThrow("off is not offered");
  expect(chooseModel("explorer", "default", ids, path).explorer).toBe("off");
});

it("keeps each role's route and model, refuses what no route offers, and clears it with default", () => {
  const path = file();
  expect(chooseModel("reviewer", "claude-code:opus", ids, path).reviewer).toBe("claude-code:opus");
  expect(chooseModel("agent", "codex:gpt-6-sol", ids, path)).toMatchObject({ agent: "codex:gpt-6-sol", reviewer: "claude-code:opus" });
  expect(chooseModel("refuter", "anthropic:claude-opus-5-5", ids, path).refuter).toBe("anthropic:claude-opus-5-5");
  expect(() => chooseModel("validator", "gpt-6-sol", ids, path)).toThrow("gpt-6-sol is not offered");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ agent: "codex:gpt-6-sol", reviewer: "claude-code:opus",
    refuter: "anthropic:claude-opus-5-5" });
  expect(chooseModel("reviewer", "default", ids, path).reviewer).toBe(DEFAULT_MODEL);
});

it("refuses a file it cannot read as model choices instead of guessing", () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ reviewer: "gpt-6-astra" }));
  expect(() => readModelChoices(path)).toThrow("not a valid model choice file");
  writeFileSync(path, JSON.stringify({ reviewer: "codex:gpt-6-astra", judge: "codex:gpt-6-sol" }));
  expect(() => readModelChoices(path)).toThrow("not a valid model choice file");
});

it("lists each role with its cost, the Claude plan for Claude Code, and sets one from the command line", () => {
  const path = file();
  let output = "";
  const write = (text: string): void => { output += text; };
  expect(runModelsCommand(["reviewer", "claude-code:opus"], write, offered, path)).toBe(0);
  expect(output).toBe("The reviewer now uses claude-code:opus.\n");
  output = "";
  expect(runModelsCommand(["refuter", "anthropic:claude-opus-5-5"], write, offered, path)).toBe(0);
  output = "";
  expect(runModelsCommand([], write, offered, path)).toBe(0);
  expect(output).toContain("  reviewer  claude-code:opus              your Claude plan's limits");
  expect(output).toContain("  refuter   anthropic:claude-opus-5-5     $4 in, $20 out per million tokens");
  expect(output).toContain("  claude-code: opus");
  expect(runModelsCommand(["judge", "codex:gpt-6-sol"], write, offered, path)).toBe(2);
  expect(runModelsCommand(["agent", "codex:gpt-9"], write, offered, path)).toBe(1);
});
