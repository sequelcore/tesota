import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostProvider } from "../src/host-environment.js";
import { workingAgentSetup } from "../src/integrations/pi-coding-session.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

async function setup(proofs?: "tool" | "guidance"): Promise<{ root: string; tools: ReturnType<typeof workingAgentSetup>["tools"]; prompt: string }> {
  const root = mkdtempSync(join(tmpdir(), "tesota-prove-"));
  roots.push(root);
  const { tools, systemPrompt } = workingAgentSetup({ cwd: root, environment: await hostProvider.prepare(root), sandboxed: false,
    approveCommand: async () => "deny" as const, ...proofs === undefined ? {} : { proofs } });
  return { root, tools, prompt: systemPrompt };
}

async function call(tools: ReturnType<typeof workingAgentSetup>["tools"], path: string): Promise<string> {
  const tool = tools.find((entry) => entry.name === "prove");
  if (tool === undefined) throw new Error("no prove tool");
  const result = await tool.execute("c", { path } as never, new AbortController().signal, undefined, undefined as never);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

it("gives the agent prove with its guidance, the contract guidance alone, or neither", async () => {
  const on = await setup("tool");
  expect(on.tools.map((tool) => tool.name)).toContain("prove");
  expect(on.prompt).toContain("never remove or loosen a contract, or add //@ assume");
  const guidance = await setup("guidance");
  expect(guidance.tools.map((tool) => tool.name)).not.toContain("prove");
  expect(guidance.prompt).toContain("a loop needs //@ invariant lines");
  expect(guidance.prompt).not.toContain("prove runs LemmaScript");
  const off = await setup();
  expect(off.tools.map((tool) => tool.name)).not.toContain("prove");
  expect(off.prompt).not.toContain("prove runs LemmaScript");
});

it("proves only TypeScript files with annotations inside the workspace", async () => {
  const { root, tools } = await setup("tool");
  writeFileSync(join(root, "plain.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  expect(await call(tools, "plain.ts")).toBe("plain.ts has no //@ annotations, so there is nothing to prove.");
  expect(await call(tools, "notes.md")).toBe("notes.md is not a TypeScript file; prove checks .ts files with //@ annotations.");
  expect(await call(tools, "missing.ts")).toBe("missing.ts does not exist.");
  await expect(call(tools, "../outside.ts")).rejects.toThrow("outside the workspace");
});

it.runIf(dafny)("reports a proved contract and a failing obligation, leaving the files as they were", async () => {
  const { root, tools } = await setup("tool");
  const good = "//@ ensures \\result >= 0\nexport function zero(): number {\n  return 0;\n}\n";
  writeFileSync(join(root, "good.ts"), good);
  writeFileSync(join(root, "bad.ts"), "//@ ensures \\result >= 0\nexport function minus(): number {\n  return -1;\n}\n");
  expect(await call(tools, "good.ts")).toMatch(/^Proved: every \/\/@ contract in good\.ts holds\./u);
  expect(await call(tools, "bad.ts")).toMatch(/^Not proved: an obligation in bad\.ts failed\./u);
  expect(readdirSync(root).sort()).toEqual(["bad.ts", "good.ts"]);
}, 120_000);
