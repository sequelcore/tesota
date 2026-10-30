import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { Theme } from "../src/contract.js";
import { tlaToolsJar } from "../src/model-check.js";
import { hasTlc, modelTool } from "../src/model-tool.js";
import tesota from "../src/tesota.js";
import { shellTheme } from "../src/theme.js";

/** The operator's TLC, copied into this file's own home where Tesota looks for it; the runs that need it are skipped without it. */
const operator = JSON.parse(process.env["TESOTA_TEST_OPERATOR_HOME"] ?? "{}") as { HOME?: string; USERPROFILE?: string };
const operatorJar = join(operator.USERPROFILE ?? operator.HOME ?? "", ".tesota", "tools", "tla2tools.jar");
const withTlc = existsSync(operatorJar) && spawnSync("java", ["-version"]).status === 0;

let theme: Theme;
beforeAll(() => {
  theme = shellTheme("dark", "truecolor");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } } as never));
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(tlaToolsJar(), { force: true });
});

function folder(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-model-tool-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function installTlc(): void {
  mkdirSync(join(tlaToolsJar(), ".."), { recursive: true });
  if (withTlc) copyFileSync(operatorJar, tlaToolsJar());
  else writeFileSync(tlaToolsJar(), "");
}

async function run(root: string, path: string): Promise<Awaited<ReturnType<typeof modelTool.execute>>> {
  return await modelTool.execute("c", { path }, new AbortController().signal, undefined, { cwd: root } as never);
}

const said = (result: Awaited<ReturnType<typeof modelTool.execute>>): string =>
  result.content.map((part) => part.type === "text" ? part.text : "").join("");

/** A session started in `root`, with no Dafny on the PATH: the tools it leaves active, `check_model`'s rules, and a tool result to hand it. */
async function session(root: string): Promise<{ active: () => string[]; rules: () => string; result: (toolName: string, path: string) => void }> {
  let active = ["read", "bash"];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools = new Map<string, { name: string; promptGuidelines?: string[] | (() => readonly string[]) }>();
  tesota({ registerTool: (tool: { name: string; promptGuidelines?: string[] | (() => readonly string[]) }) => { tools.set(tool.name, tool); }, registerFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    getActiveTools: () => active, getSettings: () => ({}), setActiveTools: (names: string[]) => { active = names; } } as never);
  const path = process.env["PATH"];
  process.env["PATH"] = folder();
  try {
    await handlers.get("session_start")?.({}, { cwd: root, sessionManager: { getBranch: () => [] }, ui: { setStatus: () => undefined,
      setHeader: () => undefined, setEditorComponent: () => undefined, setFooter: () => undefined, setWorkingDetail: () => undefined } });
  } finally { process.env["PATH"] = path; }
  const rules = (): string => {
    const guidelines = tools.get("check_model")?.promptGuidelines;
    return (typeof guidelines === "function" ? guidelines() : guidelines ?? []).join("\n");
  };
  return { active: () => active, rules, result: (toolName, path) =>
    handlers.get("tool_result")?.({ type: "tool_result", toolName, input: { path }, isError: false }, { cwd: root }) };
}

/** Two processes adding one to a counter in two steps, read then write; the lock makes the pair atomic when `Locked`. */
const spec = (module: string, fault: string): string => `(* tesota-model
   covers: src/counter.ts increment
   invariant: NoLostUpdate
   atomic: reading and writing the counter are separate steps
   omits: crashes; more than two processes
   fault: ${fault}
*)
---- MODULE ${module} ----
EXTENDS Naturals
CONSTANT Locked
VARIABLES count, pc, tmp, lock
vars == <<count, pc, tmp, lock>>
Procs == {1, 2}
Init == count = 0 /\\ pc = [p \\in Procs |-> "read"] /\\ tmp = [p \\in Procs |-> 0] /\\ lock = 0
Read(p) == pc[p] = "read" /\\ (Locked => lock = 0) /\\ lock' = (IF Locked THEN p ELSE lock)
  /\\ tmp' = [tmp EXCEPT ![p] = count] /\\ pc' = [pc EXCEPT ![p] = "write"] /\\ UNCHANGED count
Write(p) == pc[p] = "write" /\\ count' = tmp[p] + 1 /\\ pc' = [pc EXCEPT ![p] = "done"]
  /\\ lock' = (IF Locked THEN 0 ELSE lock) /\\ UNCHANGED tmp
Done == \\A p \\in Procs : pc[p] = "done"
Next == (\\E p \\in Procs : Read(p) \\/ Write(p)) \\/ (Done /\\ UNCHANGED vars)
Spec == Init /\\ [][Next]_vars
NoLostUpdate == Done => count = 2
====
`;

const config = (locked: boolean): string => `SPECIFICATION Spec\nCONSTANT Locked = ${locked ? "TRUE" : "FALSE"}\n`;

it("offers check_model only where Tesota finds TLC, and its rules once the agent writes a model (#779)", async () => {
  expect(modelTool.defaultActive).toBe(false);
  expect(modelTool.promptSnippet).toContain("TLC, which is installed");
  const root = folder();
  expect(hasTlc()).toBe(false);
  expect((await session(root)).active()).toEqual(["read", "bash"]);
  installTlc();
  expect(hasTlc()).toBe(true);
  const started = await session(root);
  expect(started.active()).toEqual(["read", "bash", "check_model"]);
  expect(started.rules()).toBe("");
  started.result("write", "models/Counter.tla");
  expect(started.rules()).toContain("(* tesota-model");
  expect(started.rules()).toContain("Never weaken an invariant");
});

it("gives check_model's rules from the start in a project that already has a model", async () => {
  installTlc();
  const started = await session(folder({ "models/Counter.tla": spec("Counter", "models/CounterUnlocked.cfg") }));
  expect(started.rules()).toContain("(* tesota-model");
});

it("checks only TLA+ and Quint models with a header inside the project", async () => {
  const root = folder({ "models/Plain.tla": "---- MODULE Plain ----\n====\n", "notes.md": "(* tesota-model *)\n" });
  expect(said(await run(root, "../outside.tla"))).toContain("outside the project");
  expect(said(await run(root, "notes.md"))).toContain("is not a model");
  expect(said(await run(root, "models/Absent.tla"))).toContain("does not exist");
  const plain = await run(root, "models/Plain.tla");
  expect(plain.isError).toBe(true);
  expect(said(plain)).toContain("has no tesota-model header");
  expect(said(plain)).toContain("invariant: <the name of a definition");
});

it("sends back an incomplete header as the gate would, and asks to check again", async () => {
  const root = folder({ "models/Counter.tla": "(* tesota-model\n   covers: src/counter.ts\n*)\n---- MODULE Counter ----\n====\n" });
  const result = await run(root, "models/Counter.tla");
  expect(result.isError).toBe(true);
  expect(said(result)).toContain("the header names no invariant");
  expect(said(result)).toContain("Then run check_model again.");
});

it("says TLC did not run, and that this says nothing about the model, when Tesota does not find it", async () => {
  const root = folder({ "models/Counter.tla": spec("Counter", "models/CounterNoLock.cfg the lock removed"),
    "models/Counter.cfg": config(true), "models/CounterNoLock.cfg": config(false) });
  const result = await run(root, "models/Counter.tla");
  expect(result.isError).toBe(true);
  expect(said(result)).toBe(`Not model-checked: TLC is not installed: Tesota looks for tla2tools.jar at ${tlaToolsJar()}. ` +
    "This says nothing about the model.");
});

it.runIf(withTlc)("model-checks a model whose planted fault breaks it, and returns a counterexample as numbered steps", async () => {
  installTlc();
  const root = folder({ "src/counter.ts": "export async function increment(): Promise<void> {}\n",
    "models/Counter.tla": spec("Counter", "models/CounterNoLock.cfg the lock removed"), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false), "models/Racy.tla": spec("Racy", "models/Counter.cfg the lock kept"),
    "models/Racy.cfg": config(false) });
  const passed = await run(root, "models/Counter.tla");
  expect(passed.isError).toBeUndefined();
  expect(said(passed)).toMatch(/^Model-checked: NoLostUpdate holds in all 9 reachable states; caught 1 of 1 planted fault; not linked to the code\.\n\nChecks the model, not the code/u);
  const shown = stripTerminalSequences(modelTool.renderResult?.(passed, { expanded: false, isPartial: false }, theme).render(100).join("\n") ?? "");
  expect(shown).toContain("✓ Model-checked — NoLostUpdate holds in all 9 reachable states");
  const racy = await run(root, "models/Racy.tla");
  expect(racy.isError).toBe(true);
  expect(said(racy)).toMatch(/Invariant NoLostUpdate is violated\.\n\n1\. initial state: .*\n2\. Read: /u);
  expect(said(racy)).toContain("Then run check_model again.");
  const failed = stripTerminalSequences(modelTool.renderResult?.(racy, { expanded: false, isPartial: false }, theme).render(100).join("\n") ?? "");
  expect(failed).toContain("✗ Not model-checked — Invariant NoLostUpdate is violated.");
}, 120_000);

it.skipIf(!withTlc)("writes and reports graph artifacts beside the tool context's session file", async () => {
  installTlc();
  const root = folder({ "src/counter.ts": "export const count = 0;\n",
    "models/Counter.tla": spec("Counter", "models/CounterNoLock.cfg no lock"), "models/Counter.cfg": config(true),
    "models/CounterNoLock.cfg": config(false) });
  const sessions = folder();
  const sessionFile = join(sessions, "session.jsonl");
  const result = await modelTool.execute("c", { path: "models/Counter.tla" }, new AbortController().signal, undefined,
    { cwd: root, sessionFile } as never);
  expect(result.details?.evidence.outcome).toBe("passed");
  expect(result.details?.capture?.status).toBe("captured");
  expect(result.details?.capture?.manifest).toMatch(/session\.jsonl\.model-.*\.manifest\.json$/u);
  expect(result.details?.capture?.manifest?.startsWith(sessions)).toBe(true);
  expect(said(result)).toContain(result.details?.capture?.manifest);
  expect(existsSync(result.details?.capture?.manifest ?? "")).toBe(true);
  expect(said(result)).toContain("models/Counter.chart.ts");
  expect(said(result)).toContain("export function state(v)");
  writeFileSync(join(root, "models/Counter.chart.ts"), "export function state(): string { return \"counting\"; }\n");
  const read = await modelTool.execute("c", { path: "models/Counter.tla" }, new AbortController().signal, undefined,
    { cwd: root, sessionFile } as never);
  expect(said(read)).not.toContain("export function state(v)");
}, 120_000);
