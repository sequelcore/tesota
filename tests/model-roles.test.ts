import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { addRoute, chooseModel, DEFAULT_MODEL, parseModelChoice, readModelChoices } from "../src/model-roles.js";
import { dataNotice, modelCost, offeredChoices, offeredModels, rolePicker, runModelsCommand, runRolesCommand,
  type OfferedModel } from "../src/models-command.js";

// A home of the test's own, so the routes it adds are never the operator's, and the operator's never reach it.
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  const { mkdtempSync: temporary } = await import("node:fs");
  const path = await import("node:path");
  const home = temporary(path.join(os.tmpdir(), "tesota-home-"));
  return { ...os, homedir: () => home };
});
afterAll(() => { rmSync(homedir(), { recursive: true, force: true }); });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-models-"));
  roots.push(root);
  return join(root, "models.json");
}
const all = ["low", "medium", "high", "xhigh", "max"] as const;
const offered: OfferedModel[] = [
  { id: "codex:gpt-6-luna", route: "codex", kind: "codex", name: "Luna", listPrice: { input: 0.1, output: 0.5 }, reasoning: all },
  { id: "codex:gpt-6-sol", route: "codex", kind: "codex", name: "Sol", listPrice: { input: 2, output: 10 }, reasoning: all },
  { id: "anthropic:claude-opus-5-5", route: "anthropic", kind: "anthropic", name: "Opus 5.5", listPrice: { input: 4, output: 20 }, reasoning: all },
  { id: "claude-code:opus", route: "claude-code", kind: "claude-code", name: "Claude Code's opus", reasoning: all },
  { id: "claude-code:claude-opus-5-5", route: "claude-code", kind: "claude-code", name: "Opus 5.5", listPrice: { input: 4, output: 20 }, reasoning: all },
  { id: "claude-code:haiku", route: "claude-code", kind: "claude-code", name: "Claude Code's haiku", reasoning: [] },
];
const ids = offeredChoices(offered);

it("reads route:model and nothing else", () => {
  expect(parseModelChoice("codex:gpt-6-luna")).toEqual({ route: "codex", kind: "codex", model: "gpt-6-luna" });
  expect(parseModelChoice("claude-code:opus")).toEqual({ route: "claude-code", kind: "claude-code", model: "opus" });
  expect(parseModelChoice("anthropic:claude-opus-5-5")).toEqual({ route: "anthropic", kind: "anthropic", model: "claude-opus-5-5" });
  for (const value of ["gpt-6-luna", "off", "openai:gpt-6", "codex:", ":opus", "codex:bad model", "codex:a/b",
    "codex:gpt-6-astra@turbo", "codex:gpt-6-astra@", "codex:@high"]) {
    expect(parseModelChoice(value)).toBeUndefined();
  }
});

it("reads a reasoning level after the model, and offers only the levels each model supports", () => {
  expect(parseModelChoice("codex:gpt-6-astra@xhigh")).toEqual({ route: "codex", kind: "codex", model: "gpt-6-astra", reasoning: "xhigh" });
  expect(parseModelChoice("claude-code:opus@max")).toEqual({ route: "claude-code", kind: "claude-code", model: "opus", reasoning: "max" });
  expect(ids).toContain("codex:gpt-6-sol@high");
  expect(ids).not.toContain("claude-code:haiku@high");
  const path = file();
  expect(chooseModel("reviewer", "codex:gpt-6-sol@xhigh", ids, path).reviewer).toBe("codex:gpt-6-sol@xhigh");
  expect(() => chooseModel("agent", "claude-code:haiku@high", ids, path)).toThrow("claude-code:haiku@high is not offered");
  // The real catalogues: Astra has no level below minimal that Tesota offers, and Haiku through Claude Code has no effort.
  const real = offeredModels();
  expect(real.find((model) => model.id === "codex:gpt-6-astra")?.reasoning).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(real.find((model) => model.id === "claude-code:opus")?.reasoning).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(real.find((model) => model.id === "claude-code:haiku")?.reasoning).toEqual([]);
});

it("gives every role the default until the operator chooses, with explorers and the advisor off", () => {
  expect(readModelChoices(file())).toEqual({ agent: DEFAULT_MODEL, explorer: "off", advisor: "off", reviewer: DEFAULT_MODEL,
    refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL, triage: DEFAULT_MODEL, namer: "codex:gpt-6-luna@low" });
  expect(DEFAULT_MODEL).toBe("codex:gpt-6-luna");
});

it("turns the answer check's first pass off, so every answer gets the full check, and back to its default", () => {
  const path = file();
  expect(chooseModel("triage", "codex:gpt-6-sol@low", ids, path).triage).toBe("codex:gpt-6-sol@low");
  expect(chooseModel("triage", "off", ids, path).triage).toBe("off");
  expect(chooseModel("triage", "default", ids, path).triage).toBe(DEFAULT_MODEL);
});

it("turns explorers and the advisor on with a model and off again, and accepts off for no other role", () => {
  const path = file();
  expect(chooseModel("explorer", "codex:gpt-6-luna", ids, path).explorer).toBe("codex:gpt-6-luna");
  expect(chooseModel("explorer", "off", ids, path).explorer).toBe("off");
  expect(() => chooseModel("reviewer", "off", ids, path)).toThrow("off is not offered");
  expect(() => chooseModel("agent", "off", ids, path)).toThrow("off is not offered");
  expect(chooseModel("explorer", "default", ids, path).explorer).toBe("off");
  expect(chooseModel("advisor", "claude-code:opus", ids, path).advisor).toBe("claude-code:opus");
  expect(chooseModel("advisor", "off", ids, path).advisor).toBe("off");
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

it("lists each role with who pays for it and the model's list price, and sets one from the command line", () => {
  const path = file();
  let output = "";
  const write = (text: string): void => { output += text; };
  expect(runRolesCommand(["reviewer", "claude-code:opus"], write, offered, path)).toBe(0);
  expect(output).toBe("The reviewer now uses claude-code:opus.\n");
  output = "";
  expect(runRolesCommand(["refuter", "anthropic:claude-opus-5-5"], write, offered, path)).toBe(0);
  expect(runRolesCommand(["validator", "claude-code:claude-opus-5-5"], write, offered, path)).toBe(0);
  output = "";
  expect(runRolesCommand([], write, offered, path)).toBe(0);
  expect(output).toContain("  reviewer  claude-code:opus              your Claude Code sign-in");
  expect(output).toContain("  refuter   anthropic:claude-opus-5-5     your Anthropic API key, $4 in and $20 out per million tokens");
  expect(output).toContain("  agent     codex:gpt-6-luna              your ChatGPT plan's limits; list price $0.1 in and $0.5 out");
  expect(output).toContain("  validator claude-code:claude-opus-5-5   your Claude Code sign-in; list price $4 in and $20 out");
  expect(output).toContain("Use tesota models to see available models");
  expect(output).toContain("  advisor   off                           no advisor; choose a model to turn it on");
  output = "";
  expect(runRolesCommand(["advisor", "off"], write, offered, path)).toBe(0);
  expect(output).toBe("The advisor is off.\n");
  // Judges that share the author's model or lab are named, under the listing and after a choice.
  output = "";
  expect(runRolesCommand([], write, offered, path)).toBe(0);
  expect(output).toContain("Same model judging its own output");
  expect(output).toContain("a second check tests the review's reported problems, and both use claude-code:opus");
  output = "";
  expect(runRolesCommand(["advisor", "claude-code:opus"], write, offered, path)).toBe(0);
  expect(output).toContain("The advisor now uses claude-code:opus.\n");
  expect(output).toContain("the reviewer judges work the advisor's guidance shaped, and both use claude-code:opus");
  // A choice with a reasoning level is priced as its model.
  expect(runRolesCommand(["validator", "codex:gpt-6-sol@high"], write, offered, path)).toBe(0);
  output = "";
  expect(runRolesCommand([], write, offered, path)).toBe(0);
  expect(output).toContain("  validator codex:gpt-6-sol@high          your ChatGPT plan's limits; list price $2 in and $10 out");
  expect(runRolesCommand(["judge", "codex:gpt-6-sol"], write, offered, path)).toBe(2);
  expect(runRolesCommand(["agent", "codex:gpt-9"], write, offered, path)).toBe(1);
});

it("reads OpenRouter's vendor/model:variant ids only on OpenRouter, and OpenCode's ids on Zen and Go", () => {
  expect(parseModelChoice("openrouter:qwen/qwen3.8-27b:free")).toEqual({ route: "openrouter", kind: "openrouter", model: "qwen/qwen3.8-27b:free" });
  expect(parseModelChoice("openrouter:anthropic/claude-opus-5.5@high"))
    .toEqual({ route: "openrouter", kind: "openrouter", model: "anthropic/claude-opus-5.5", reasoning: "high" });
  expect(parseModelChoice("openrouter:auto")).toEqual({ route: "openrouter", kind: "openrouter", model: "auto" });
  expect(parseModelChoice("opencode:big-pickle")).toEqual({ route: "opencode", kind: "opencode", model: "big-pickle" });
  expect(parseModelChoice("opencode-go:glm-5.3@max")).toEqual({ route: "opencode-go", kind: "opencode-go", model: "glm-5.3", reasoning: "max" });
  for (const value of ["openrouter:a//b", "openrouter:/b", "openrouter:a/b/c", "openrouter:a/b:", "opencode:a/b",
    "opencode-go:x:free", "codex:a:free"]) {
    expect(parseModelChoice(value)).toBeUndefined();
  }
});

it("offers the gateways' models, with who pays and what a free model's provider may do with your code", () => {
  const real = offeredModels();
  for (const id of ["openrouter:qwen/qwen3.8-27b:free", "openrouter:anthropic/claude-opus-5.5", "opencode:gpt-6-luna",
    "opencode-go:glm-5.3", "opencode-go:muse-spark-1.3-contributor"]) {
    expect(real.some((model) => model.id === id), id).toBe(true);
  }
  // OpenCode refuses Zen's free models to every client but its own (403 FreeTierError, 2026-09-26).
  expect(real.filter((model) => model.route === "opencode" && model.free === true)).toEqual([]);
  expect(real.some((model) => model.id === "opencode:big-pickle")).toBe(false);
  const find = (id: string): OfferedModel | undefined => real.find((model) => model.id === id);
  expect(modelCost(find("opencode:gpt-6-luna"))).toBe("your OpenCode Zen balance, $0.1 in and $0.5 out per million tokens");
  expect(modelCost(find("opencode-go:glm-5.3"))).toMatch(/^your OpenCode Go subscription's limits; list price/u);
  expect(modelCost(find("openrouter:qwen/qwen3.8-27b:free"))).toMatch(/^free on OpenRouter/u);
  // OpenRouter's own routers pick a model per request, so no one price applies.
  expect(modelCost(find("openrouter:auto"))).toBe("your OpenRouter credits; the price is the model it picks");
  for (const id of ["openrouter:qwen/qwen3.8-27b:free", "openrouter:openrouter/free", "opencode-go:muse-spark-1.3-contributor"]) {
    expect(dataNotice(id), id).toMatch(/may keep your prompts and code/u);
  }
  for (const id of ["openrouter:anthropic/claude-opus-5.5", "opencode:gpt-6-luna", "opencode-go:glm-5.3", "codex:gpt-6-luna"]) {
    expect(dataNotice(id), id).toBeUndefined();
  }
});

it("lists a large route by count, and all of its models on request", () => {
  const writes: string[] = [];
  expect(runModelsCommand([], (text) => { writes.push(text); }, offeredModels())).toBe(0);
  expect(writes.join("")).toMatch(/openrouter: \d+ models, \d+ of them free; tesota models openrouter lists them/u);
  writes.length = 0;
  expect(runModelsCommand(["openrouter"], (text) => { writes.push(text); }, offeredModels())).toBe(0);
  expect(writes.join("")).toContain("qwen/qwen3.8-27b:free");
  writes.length = 0;
  expect(runModelsCommand(["reviewer", "codex:gpt-6-luna"], (text) => { writes.push(text); }, offered)).toBe(2);
  expect(writes.join("")).toContain("Usage: tesota models [<");
});

it("lets only the triage role use a typed decision model, and says what TypeSafe receives", () => {
  const path = file();
  const writes: string[] = [];
  expect(runRolesCommand(["reviewer", "typesafe:jev-1.13.0"], (text) => { writes.push(text); }, offered, path)).toBe(1);
  expect(writes.join("")).toContain("answers only the answer check's first pass");
  writes.length = 0;
  expect(runRolesCommand(["triage", "typesafe:jev-1.13.0"], (text) => { writes.push(text); }, offered, path)).toBe(0);
  expect(writes.join("")).toContain("TypeSafe receives each such turn's requests and the agent's reply");
  expect(readModelChoices(path).triage).toBe("typesafe:jev-1.13.0");
  // An unpinned or unknown version is not offered: only a qualified one may skip a check.
  expect(() => chooseModel("triage", "typesafe:jev-latest", offeredChoices(offered, "triage"), path)).toThrow("not offered");
  writes.length = 0;
  runRolesCommand([], (text) => { writes.push(text); }, offered, path);
  expect(writes.join("")).toMatch(/triage +typesafe:jev-1\.13\.0 +your TypeSafe key/u);
  writes.length = 0;
  expect(runModelsCommand([], (text) => { writes.push(text); }, offered)).toBe(0);
  expect(writes.join("")).toContain("typesafe, for triage only: typesafe:jev-1.13.0");
});

it("refuses a decision model saved by hand for any role but triage", () => {
  const path = file();
  writeFileSync(path, JSON.stringify({ reviewer: "typesafe:jev-1.13.0" }));
  expect(() => readModelChoices(path)).toThrow("not a valid model choice file");
});

it("offers /roles a role, then that role's models with default and, when it can be off, off", () => {
  const path = file();
  const roles = rolePicker("/roles ", offered, path);
  expect(roles?.completes).toBe(true);
  expect(roles?.entries.map((entry) => entry.id)).toEqual(["agent", "explorer", "advisor", "reviewer", "refuter", "validator", "triage",
    "namer"]);
  const triage = rolePicker("/roles triage ", offered, path)?.entries.map((entry) => entry.id) ?? [];
  expect(triage[0]).toBe("typesafe:jev-1.13.0");
  expect(triage.slice(-2)).toEqual(["default", "off"]);
  const reviewer = rolePicker("/roles reviewer ", offered, path)?.entries.map((entry) => entry.id) ?? [];
  expect(reviewer).not.toContain("typesafe:jev-1.13.0");
  expect(reviewer).not.toContain("off");
  expect(rolePicker("/roles nobody ", offered, path)).toBeUndefined();
  expect(rolePicker("/models ", offered, path)).toBeUndefined();
});

it("says when roles spread across routes draw on one account, under the listing and after a choice that makes it so", () => {
  const path = file();
  const added = addRoute("claude-2", "claude-code");
  const withSecond: OfferedModel[] = [...offered, { id: "claude-2:opus", route: "claude-2", kind: "claude-code", name: "Claude Code's opus",
    reasoning: all }];
  const ours = { id: "45e4b49f" };
  const accounts = [{ route: "claude-code", account: ours }, { route: "claude-2", account: ours }, { route: "codex", account: { id: "plus" } }];
  let output = "";
  const write = (text: string): void => { output += text; };
  expect(runRolesCommand(["agent", "claude-code:opus"], write, withSecond, path, accounts, added)).toBe(0);
  expect(output).not.toContain("share one plan's limits");
  output = "";
  expect(runRolesCommand(["advisor", "claude-2:opus"], write, withSecond, path, accounts, added)).toBe(0);
  const note = "Roles on claude-code (agent) and claude-2 (advisor) share one plan's limits: both routes are signed in to the same account.";
  expect(output).toContain(`${note}\n`);
  output = "";
  expect(runRolesCommand([], write, withSecond, path, accounts, added)).toBe(0);
  expect(output).toContain(note);
  // A choice on a route of its own account says nothing of the others.
  output = "";
  expect(runRolesCommand(["refuter", "codex:gpt-6-sol"], write, withSecond, path, accounts, added)).toBe(0);
  expect(output).not.toContain("share one plan's limits");
  // Signed in to different accounts, the same roles share nothing.
  output = "";
  expect(runRolesCommand([], write, withSecond, path, [{ route: "claude-code", account: ours }, { route: "claude-2", account: { id: "b7" } }],
    added)).toBe(0);
  expect(output).not.toContain("share one plan's limits");
});
