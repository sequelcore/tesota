import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import tesota from "../src/extension.js";
import { hasContracts, proveTool } from "../src/prove-tool.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-prove-"));
  roots.push(root);
  return root;
}

async function call(root: string, path: string): Promise<string> {
  const result = await proveTool.execute("c", { path }, new AbortController().signal, undefined, { cwd: root } as never);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

/** The tools the extension leaves active after a session starts in `root`. */
function activeTools(root: string): string[] {
  let active = ["read", "bash"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  tesota({ registerTool: () => undefined, on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); },
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; } } as never);
  handlers.get("session_start")?.({}, { cwd: root, ui: { setStatus: () => undefined } });
  return active;
}

it("offers prove with its measured guidance only in a project with contracts", () => {
  expect(proveTool.defaultActive).toBe(false);
  expect(proveTool.promptGuidelines?.join("\n")).toContain("never remove or loosen a contract, or add //@ assume");
  expect(proveTool.promptGuidelines?.join("\n")).toContain("forall(j: nat, j < items.length ==> P)");
  const root = folder();
  writeFileSync(join(root, "plain.ts"), "export const a = 1;\n");
  expect(activeTools(root)).toEqual(["read", "bash"]);
  writeFileSync(join(root, "rule.ts"), "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n");
  expect(activeTools(root)).toEqual(["read", "bash", "prove"]);
});

it("proves only TypeScript files with annotations inside the project", async () => {
  const root = folder();
  writeFileSync(join(root, "plain.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  expect(await call(root, "plain.ts")).toBe("plain.ts has no //@ annotations, so there is nothing to prove.");
  expect(await call(root, "notes.md")).toBe("notes.md is not a TypeScript file; prove checks .ts files with //@ annotations.");
  expect(await call(root, "missing.ts")).toBe("missing.ts does not exist.");
  expect(await call(root, "../outside.ts")).toBe("../outside.ts is outside the project; prove checks files inside it.");
});

it.runIf(dafny)("reports a proved contract and a failing obligation, then asks the agent to keep going", async () => {
  const root = folder();
  writeFileSync(join(root, "good.ts"), "//@ ensures \\result >= 0\nexport function zero(): number {\n  return 0;\n}\n");
  writeFileSync(join(root, "bad.ts"), "//@ ensures \\result >= 0\nexport function minus(): number {\n  return -1;\n}\n");
  const proved = await call(root, "good.ts");
  expect(proved).toMatch(/^Proved: every \/\/@ contract in good\.ts holds\./u);
  expect(proved).not.toContain("run prove again");
  const failed = await call(root, "bad.ts");
  expect(failed).toMatch(/^Not proved: an obligation in bad\.ts failed\./u);
  expect(failed).toMatch(/run prove again\. Keep going until it passes;.*never loosen the contract to make it pass\.$/u);
  expect(readdirSync(root).sort()).toEqual(["bad.dfy", "bad.dfy.gen", "bad.ts", "good.dfy", "good.dfy.gen", "good.ts"]);
}, 120_000);

it("finds contracts outside dependency, build and hidden folders only", () => {
  const root = folder();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules", "lib"), { recursive: true });
  mkdirSync(join(root, ".cache"));
  writeFileSync(join(root, "src", "plain.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "node_modules", "lib", "rule.ts"), "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n");
  writeFileSync(join(root, ".cache", "rule.ts"), "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n");
  writeFileSync(join(root, "src", "notes.md"), "//@ ensures in a document\n");
  expect(hasContracts(root)).toBe(false);
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n");
  expect(hasContracts(root)).toBe(true);
  expect(hasContracts(join(root, "missing"))).toBe(false);
});
