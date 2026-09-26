import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { chooseModel, DEFAULT_MODEL, readModelChoices } from "../src/model-roles.js";
import { runModelsCommand, type OfferedModel } from "../src/models-command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-models-"));
  roots.push(root);
  return join(root, "models.json");
}
const offered: OfferedModel[] = [{ id: "gpt-6-luna", name: "Luna", input: 0.1, output: 0.5 },
  { id: "gpt-6-sol", name: "Sol", input: 2, output: 10 }, { id: "gpt-6-astra", name: "Astra", input: 10, output: 50 }];

it("gives every role the default until the operator chooses, with explorers off", () => {
  expect(readModelChoices(file())).toEqual({ agent: DEFAULT_MODEL, explorer: "off", reviewer: DEFAULT_MODEL,
    refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL });
});

it("turns explorers on with a model and off again, and accepts off for no other role", () => {
  const path = file();
  const ids = offered.map((model) => model.id);
  expect(chooseModel("explorer", "gpt-6-luna", ids, path).explorer).toBe("gpt-6-luna");
  expect(chooseModel("explorer", "off", ids, path).explorer).toBe("off");
  expect(() => chooseModel("reviewer", "off", ids, path)).toThrow("off is not offered");
  expect(chooseModel("explorer", "default", ids, path).explorer).toBe("off");
});

it("keeps one role's choice, refuses a model the provider does not offer, and clears it with default", () => {
  const path = file();
  const ids = offered.map((model) => model.id);
  expect(chooseModel("reviewer", "gpt-6-astra", ids, path).reviewer).toBe("gpt-6-astra");
  expect(chooseModel("agent", "gpt-6-sol", ids, path)).toMatchObject({ agent: "gpt-6-sol", reviewer: "gpt-6-astra" });
  expect(() => chooseModel("refuter", "gpt-9", ids, path)).toThrow("gpt-9 is not offered");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ agent: "gpt-6-sol", reviewer: "gpt-6-astra" });
  expect(chooseModel("reviewer", "default", ids, path).reviewer).toBe(DEFAULT_MODEL);
});

it("refuses a file it cannot read as model choices instead of guessing", () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ reviewer: "gpt-6-astra", judge: "gpt-6-sol" }));
  expect(() => readModelChoices(path)).toThrow("not a valid model choice file");
});

it("lists each role with its model and price, and sets one from the command line", () => {
  const path = file();
  let output = "";
  const write = (text: string): void => { output += text; };
  expect(runModelsCommand(["reviewer", "gpt-6-astra"], write, offered, path)).toBe(0);
  expect(output).toBe("The reviewer now uses gpt-6-astra.\n");
  output = "";
  expect(runModelsCommand([], write, offered, path)).toBe(0);
  expect(output).toContain("  reviewer  gpt-6-astra           $10 in, $50 out per million tokens");
  expect(output).toContain("Offered: gpt-6-luna, gpt-6-sol, gpt-6-astra");
  expect(runModelsCommand(["judge", "gpt-6-sol"], write, offered, path)).toBe(2);
  expect(runModelsCommand(["agent", "gpt-9"], write, offered, path)).toBe(1);
});
