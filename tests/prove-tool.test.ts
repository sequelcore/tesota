import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import tesota from "../src/extension.js";
import { hasContracts, proveTool } from "../src/prove-tool.js";
import { loadThemes, themeIn } from "./pi-themes.js";

let theme: Theme;
beforeAll(async () => {
  theme = themeIn(await loadThemes(), "tesota-dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } } as never));
}, 30_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-prove-"));
  roots.push(root);
  return root;
}

async function run(root: string, path: string): Promise<Awaited<ReturnType<typeof proveTool.execute>>> {
  return await proveTool.execute("c", { path }, new AbortController().signal, undefined, { cwd: root } as never);
}

async function call(root: string, path: string): Promise<string> {
  return (await run(root, path)).content.map((part) => part.type === "text" ? part.text : "").join("");
}

/** The tools the extension leaves active after a session starts in `root`. */
function activeTools(root: string): string[] {
  let active = ["read", "bash"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  tesota({ registerTool: () => undefined, registerFlag: () => undefined, registerMessageRenderer: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); },
    getActiveTools: () => active, getSettings: () => ({}), setActiveTools: (names: string[]) => { active = names; } } as never);
  handlers.get("session_start")?.({}, { cwd: root, sessionManager: { getBranch: () => [] }, ui: { setStatus: () => undefined,
    setHeader: () => undefined, setEditorComponent: () => undefined, setFooter: () => undefined } });
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
  // The operator's view gets the evidence, and a proof that fails is an error result, which Pi draws on its error background.
  const pass = await run(root, "good.ts");
  expect(pass.isError).toBeUndefined();
  expect(pass.details).toMatchObject({ path: "good.ts", evidence: { verifier: "lemmascript", outcome: "passed" } });
  const fail = await run(root, "bad.ts");
  expect(fail.isError).toBe(true);
  expect(fail.details).toMatchObject({ path: "bad.ts", evidence: { outcome: "failed" } });
}, 120_000);

it.runIf(dafny)("tells the agent to check where its //@ lines sit when Dafny verified nothing", async () => {
  const root = folder();
  writeFileSync(join(root, "detached.ts"),
    "//@ ensures \\result >= 0\nconst unit = 1;\nexport function one(): number {\n  return unit;\n}\n");
  const vacuous = await call(root, "detached.ts");
  expect(vacuous).toMatch(/^Not proved: Dafny verified nothing in detached\.ts, so none of its contracts was proved\./u);
  expect(vacuous).toMatch(/anything between the \/\/@ block and the function drops its contracts\. Fix that and run prove again\.$/u);
  expect(vacuous).not.toContain("Read the obligation that failed");
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

function evidence(outcome: Evidence["outcome"], output: string): Evidence {
  return { verifier: "lemmascript", claim: "", limits: "", outcome, output, durationMs: 2118, files: ["src/range.ts"], contentHash: "h" };
}

/** What Pi's shell shows for a `prove` call and its result, without escape sequences. */
function drawn(result: { outcome: Evidence["outcome"]; output: string } | string, expanded = false, isPartial = false): string[] {
  const context = { durationMs: isPartial ? undefined : 2118 } as never;
  const call = proveTool.renderCall?.({ path: "src/range.ts" }, theme, context).render(80) ?? [];
  const shown = typeof result === "string" ? { content: [{ type: "text" as const, text: result }], details: undefined }
    : { content: [{ type: "text" as const, text: "what the agent reads" }],
      details: { path: "src/range.ts", evidence: evidence(result.outcome, result.output) } };
  const rows = proveTool.renderResult?.(shown, { expanded, isPartial }, theme, context).render(80) ?? [];
  return [...call, ...rows].map((row) => stripTerminalSequences(row).trimEnd());
}

const failure = "Generated: C:\\work\\src\\range.dfy.gen\r\nRunning dafny verify...\r\n" +
  "range.dfy(16,0): Error: a postcondition could not be proved on this return path\r\n   |\r\n16 | {\r\n   | ^\r\n\r\n" +
  "range.dfy(15,30): Related location: this is the postcondition that could not be proved\r\n   |\r\n" +
  "15 |   ensures (inRange(x, lo, hi) <= hi)\r\n   |                               ^^\r\n\r\n" +
  "Dafny program verifier finished with 1 verified, 1 error";

it("shows a proof's result in a few words, and Dafny's output only when expanded", () => {
  expect(drawn({ outcome: "passed", output: "Dafny program verifier finished with 2 verified, 0 errors" })).toEqual([
    "prove src/range.ts                                                          2.1s", "",
    "✓ Proved — every contract holds · 2 verified, 0 errors"]);
  const failed = drawn({ outcome: "failed", output: failure });
  expect(failed.slice(1)).toEqual(["", "✗ Not proved — a postcondition could not be proved on this return path",
    "   at ensures (inRange(x, lo, hi) <= hi)", "", "ctrl+o for Dafny's output"]);
  const expanded = drawn({ outcome: "failed", output: failure }, true);
  expect(expanded).toContain("range.dfy(16,0): Error: a postcondition could not be proved on this return path");
  expect(expanded).toContain("Dafny program verifier finished with 1 verified, 1 error");
  // The lines that only report lsc's own steps, such as where it wrote a file, are left out.
  expect(expanded.join("\n")).not.toContain("Generated:");
  expect(drawn({ outcome: "vacuous", output: "Dafny program verifier finished with 0 verified, 0 errors" })[2])
    .toBe("✗ Not proved — Dafny verified nothing, so no contract was proved");
  expect(drawn({ outcome: "passed", output: "" }, false, true)).toEqual(["prove src/range.ts", "", "◐ proving…"]);
  expect(drawn("src/notes.md is not a TypeScript file; prove checks .ts files with //@ annotations.").slice(1))
    .toEqual(["", "src/notes.md is not a TypeScript file; prove checks .ts files with //@", "annotations."]);
});
