import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contentHash, type Evidence } from "../src/evidence.js";
import type { ModelCheck } from "../src/model-check.js";
import type { Clarification, RequestInput } from "../src/clarification.js";
import { evidenceParts, evidenceText } from "../src/footer.js";
import { changedFiles, GateProgress, type GateStatus, type RecordedRequest, registerGate, type SentBack } from "../src/gate.js";
import { headCommit } from "../src/git.js";
import { openCasesSystemPrompt } from "../src/open-cases.js";
import { receiptDecisions, receiptFindings, type Receipt } from "../src/receipt.js";
import { gateVerdict, keepsWorking, toolMayChangeFiles } from "../src/verification/gate-rule.js";
import type { ProofOutcome } from "../src/verification/proof-outcome-rule.js";
import { emptyReceipt } from "./receipts.js";

/** The proofs the gate runs, scripted per file: the gate's decisions, not LemmaScript, are under test here. */
const scripted = new Map<string, { outcome: ProofOutcome; output: string }>();
let mutantOutcome: ProofOutcome = "failed";
vi.mock("../src/verification/lemmascript-verifier.js", async (original) => ({
  ...await original<typeof import("../src/verification/lemmascript-verifier.js")>(),
  proveFile: (_root: string, path: string): Promise<Evidence> => {
    const { outcome, output } = scripted.get(path) ?? { outcome: "passed", output: "1 verified, 0 errors" };
    if (output === "throws") return Promise.reject(new Error("the prover broke"));
    return Promise.resolve({ verifier: "lemmascript", claim: `claim of ${path}`, limits: "", outcome, output, durationMs: 1,
      files: [path, path.replace(/\.ts$/u, ".dfy")], contentHash: `hash of ${path}` });
  },
  // Every mutant ends as scripted, failing its proof unless a test says otherwise, so strength is measured without Dafny;
  // a survivor's equivalence proof (`equivalenceSource`) always fails, so it stays a survivor.
  proveSource: (_name: string, source: string) => Promise.resolve(/Mutant\d*\(/u.test(source) ? "failed" : mutantOutcome),
}));

/** Model checks scripted per model, each call counted: the gate's decisions, not TLC, are under test here. */
const scriptedModels = new Map<string, (calls: number) => Pick<ModelCheck, "run" | "faults"> & { outcome: ProofOutcome }>();
const modelCalls = new Map<string, number>();
vi.mock("../src/model-check.js", async (original) => {
  const real = await original<typeof import("../src/model-check.js")>();
  return { ...real, checkModel: async (root: string, path: string, changed: readonly string[]): Promise<ModelCheck> => {
    const calls = (modelCalls.get(path) ?? 0) + 1;
    modelCalls.set(path, calls);
    const { outcome, run, faults } = scriptedModels.get(path)?.(calls)
      ?? { outcome: "passed", run: "passed", faults: [{ path: "models/Fault.cfg", description: "lock removed", verdict: "caught", output: "", durationMs: 1 }] };
    const header = { covers: [{ path: "src/counter.ts", names: [] }], invariants: ["Safe"], atomic: ["each step"], omits: ["crashes"],
      faults: [{ path: "models/Fault.cfg", description: "lock removed" }] };
    // Bound to the content as the real check binds it, so the gate can tell a check of the same content.
    const content = await real.modelContent(root, path, header);
    return { path, language: "tla", header, problems: [], evidence: { verifier: "tlc", claim: `claim of ${path}`, limits: "", outcome,
      output: "", durationMs: 1, files: content.map((file) => file.path), contentHash: contentHash(content) }, run, states: 9, faults,
    staleness: "possibly_stale", stale: ["src/counter.ts"], writtenWithCode: changed.includes(path) && changed.includes("src/counter.ts"),
    link: "no_replay" };
  } };
});

const roots: string[] = [];

it("asking a question alone cannot change project files, while unknown tools remain eligible", () => {
  expect(toolMayChangeFiles("ask_user", true, false)).toBe(false);
  expect(toolMayChangeFiles("ask_user", false, false)).toBe(true);
  expect(toolMayChangeFiles("unknown_tool", false, false)).toBe(true);
  expect(toolMayChangeFiles("agent", false, true)).toBe(false);
});
beforeEach(() => { scripted.clear(); scriptedModels.clear(); modelCalls.clear(); mutantOutcome = "failed"; });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): void {
  expect(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status).toBe(0);
}

const contract = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
}

/** A new empty folder, removed after the test. */
function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  return root;
}

/** A repository with these files committed, in `root` or a new folder. */
function repository(files: Record<string, string>, root = folder()): string {
  write(root, files);
  git(root, "init", "-q");
  commit(root, "base");
  return root;
}

/** A repository with one committed contract file, `src/rule.ts`, and a committed plain file. */
function project(root?: string): string {
  return repository({ "src/rule.ts": contract, "notes.md": "# Notes\n" }, root);
}

/**
 * A package whose `test` script runs Node's test runner, with a dependency
 * that only the checkout's ignored `node_modules` holds, as installed ones are.
 */
function testedProject(test = "node --test", at?: string): string {
  const root = repository({
    "package.json": JSON.stringify({ type: "module", scripts: { test } }), "bun.lock": "",
    ".gitignore": "node_modules\nreport.xml\n", "src/price.mjs": "export const total = (n) => n;\n",
    "test/price.test.mjs": "import assert from \"node:assert\";\nimport { test } from \"node:test\";\nimport { one } from \"dep\";\n" +
      "import { total } from \"../src/price.mjs\";\ntest(\"one\", () => { assert.equal(total(1), one); });\n",
  }, at);
  write(root, { "node_modules/dep/package.json": JSON.stringify({ name: "dep", type: "module", main: "index.js" }),
    "node_modules/dep/index.js": "export const one = 1;\n" });
  return root;
}

/** A Node test file with one test, `name`, asserting `total(input) === expected`. */
function priceTest(input: number, expected: number, name = "total"): string {
  return "import assert from \"node:assert\";\nimport { test } from \"node:test\";\nimport { total } from \"../src/price.mjs\";\n" +
    `test(${JSON.stringify(name)}, () => { assert.equal(total(${input}), ${expected}); });\n`;
}

interface Settled { entries?: { type?: string; customType: string; content: string; details?: unknown; data?: unknown }[]; continue?: boolean }

/** The gate's handlers on a fake Pi, run as Pi runs them in `root`; the open-case list is off unless `session` sets its flag. */
function gate(root: string, active = ["read", "edit", "prove"], session: object = {}, recorded?: () => RecordedRequest): {
  input: (source?: string, streamingBehavior?: string, text?: string) => Promise<void>; agentStart: () => void;
  tool: (name: string, readOnly?: boolean) => Promise<void>;
  settle: (outcome?: string, reason?: string) => Promise<Settled | undefined>; progress: GateProgress; steps: GateStatus[];
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const progress = registerGate({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    registerFlag: () => undefined,
    getFlag: (name: string) => ({ "open-cases-model": "off", ...(session as { flags?: Record<string, string | undefined> }).flags })[name],
    getActiveTools: () => active } as never, recorded);
  const steps: GateStatus[] = [];
  progress.subscribe(() => { steps.push(progress.status); });
  const ctx = { cwd: root, signal: undefined, ...session };
  return {
    progress, steps,
    input: async (source = "interactive", streamingBehavior, text = "fix it") => {
      await handlers.get("input")?.({ type: "input", text, source, streamingBehavior }, ctx);
    },
    agentStart: () => { handlers.get("agent_start")?.({ type: "agent_start" }, ctx); },
    tool: async (toolName, readOnly) => {
      await handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolName, ...readOnly === undefined ? {} : { readOnly } }, ctx);
    },
    settle: async (outcome = "completed", reason) =>
      await handlers.get("agent_before_settle")?.({ type: "agent_before_settle", outcome, reason }, ctx) as Settled | undefined,
  };
}

it.each([false, true])("verifies clarifications and amendments in their journal order (answer first: %s)", async (answerFirst) => {
  const root = project();
  const commit = await headCommit(root);
  const clarification: Clarification = { reply: 0, callId: "ask", at: "2026-10-20T00:00:00.000Z",
    questions: [{ question: "Which behavior?", options: [
      { label: "A", description: "Use behavior A." }, { label: "B", description: "Use behavior B." },
    ] }], answers: [{ selected: [0], text: "Explain before implementing." }] };
  const amendment = { kind: "amendment", origin: "interactive", text: "Use behavior B instead." } as const;
  const answer = { kind: "clarification", clarification } as const;
  const inputs: RequestInput[] = answerFirst ? [answer, amendment] : [amendment, answer];
  inputs.push({ kind: "amendment", origin: "extension", text: "Not operator input." });
  const prompts: string[] = [];
  const run = gate(root, undefined, { flags: { "open-cases-model": "test/lister" }, modelRegistry: {
    find: () => ({ provider: "test", id: "lister" }), complete: (_model: unknown, context: { messages: { content: { text: string }[] }[] }) => {
      prompts.push(context.messages[0]?.content[0]?.text ?? "");
      return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "result", name: "record_open_cases", arguments: { status: "listed", cases: [] } }] });
    },
  } }, () => ({ text: "Choose the behavior.", at: clarification.at, inputs,
    base: { units: [{ folder: "", kind: "commit", commit }] } }));
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "# Changed\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.clarifications).toEqual([clarification]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Operator selected: A — Use behavior A.");
  expect(prompts[0]).not.toContain("Not operator input.");
  const answerAt = prompts[0]?.indexOf("Explain before implementing.") ?? -1;
  const amendmentAt = prompts[0]?.indexOf("Use behavior B instead.") ?? -1;
  expect(answerAt >= 0 && amendmentAt >= 0).toBe(true);
  expect(answerFirst ? answerAt < amendmentAt : amendmentAt < answerAt).toBe(true);
});

/** The one entry a settle appended. */
/** The receipt's facts as its message fences them, without the line naming its base: plain, so nothing in them is escaped. */
function facts(content: string): string {
  const fence = /^(`{3,})text\n/mu.exec(content);
  if (fence === null) throw new Error(`no fenced details in ${content}`);
  const start = fence.index + fence[0].length;
  return content.slice(start, content.lastIndexOf("\nFrom ", content.indexOf(`\n${fence[1]}`, start)));
}

function entry(settled: Settled | undefined): { customType: string; content: string; details?: unknown } {
  expect(settled?.entries).toHaveLength(1);
  const found = (settled?.entries ?? [])[0];
  return found === undefined ? { customType: "", content: "" } : { ...found, details: found.type === "custom" ? found.data : found.details };
}

it.each(["tui", "print"])("fingerprints inherited dirt without verifying an unchanged shell request in %s", async (mode) => {
  const root = project();
  write(root, { "src/rule.ts": `${contract}// old\n` });
  const find = vi.fn();
  const run = gate(root, undefined, { mode, modelRegistry: { find }, flags: { "open-cases-model": undefined } });
  run.progress.ready("proofs_and_tests");
  await run.input();
  await run.tool("bash");
  expect(await run.settle()).toBeUndefined();
  expect(find).not.toHaveBeenCalled();
  expect(run.steps.some(({ step }) => step === "proving" || step === "testing")).toBe(false);
  expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
});

it.each(["tui", "print"])("attributes only the request edit and preserves inherited files in %s", async (mode) => {
  const root = project();
  write(root, { "src/rule.ts": `${contract}// old\n`, "old.txt": "old\n" });
  const run = gate(root, undefined, { mode });
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "new\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: expect.any(String) }]);
  expect(receipt).toMatchObject({ inherited: ["old.txt", "src/rule.ts"], proofs: [], unverified: ["notes.md"] });
});

it.each(["commit", "delete", "stash", "switch"])("makes a %s eligible even without a remaining worktree diff", async (action) => {
  const root = project();
  if (action === "switch") {
    git(root, "branch", "before");
    write(root, { "notes.md": "other branch\n" });
    commit(root, "other branch");
  }
  if (action === "stash") write(root, { "notes.md": "old dirt\n" });
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  if (action === "commit") { write(root, { "notes.md": "committed\n" }); commit(root, "agent commit"); }
  if (action === "delete") rmSync(join(root, "notes.md"));
  if (action === "stash") git(root, "-c", "user.name=t", "-c", "user.email=t@t", "stash");
  if (action === "switch") git(root, "switch", "before");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: action === "delete" ? null : expect.any(String) }]);
  expect(receipt).toMatchObject({ inherited: [] });
});

it("keeps earlier stopped weakening against H when a new request edits another file", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/price.test.mjs": "// stopped request removed the test\n" });
  await run.settle("aborted");
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "new request\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: expect.any(String) }]);
  expect(receipt).toMatchObject({ inherited: ["test/price.test.mjs"], exercises: [] });
  expect(Array.isArray(receipt.weakened) && receipt.weakened.some(({ path }) => path === "test/price.test.mjs")).toBe(true);
  expect(receiptFindings(receipt)).toContainEqual(expect.objectContaining({ standing: "decide", check: "weakening" }));
});

it("reports oversized dirty files and a 200-file untracked directory as unmeasured", async () => {
  const root = project();
  write(root, { "large.txt": "x".repeat(10 * 1024 * 1024 + 1),
    ...Object.fromEntries(Array.from({ length: 200 }, (_, k) => [`many/${k}.txt`, "x"])) });
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt).toMatchObject({ inherited: [], changed: [] });
  expect(receipt.unmeasured).toHaveLength(201);
  expect(receipt.unmeasured).toContainEqual({ path: "large.txt", reason: expect.stringContaining("10 MiB") });
  expect(receipt.unmeasured).toContainEqual({ path: "many/0.txt", reason: expect.stringContaining("200") });
});

it("writes no objects, refs or index bytes while fingerprinting", async () => {
  const root = project();
  write(root, { "notes.md": "old dirt\n", "untracked.txt": "old\n" });
  const state = () => ({ objects: spawnSync("git", ["count-objects", "-v"], { cwd: root, encoding: "utf8" }).stdout,
    refs: spawnSync("git", ["for-each-ref"], { cwd: root, encoding: "utf8" }).stdout,
    index: readFileSync(join(root, ".git/index")) });
  const before = state();
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  write(root, { "notes.md": "during request\n" });
  expect(entry(await run.settle()).customType).toBe("tesota-receipt");
  expect(state()).toEqual(before);
});

it("fingerprints and attributes repositories independently in a workspace", async () => {
  const root = folder();
  const a = project(join(root, "a"));
  const b = project(join(root, "b"));
  write(a, { "notes.md": "old a\n" });
  write(b, { "notes.md": "old b\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(b, { "new.txt": "during request\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.units).toHaveLength(1);
  expect(receipt.units?.[0]).toMatchObject({ folder: "b", inherited: ["notes.md"],
    changed: [{ path: "new.txt", blob: expect.any(String) }] });
});

it("reports a failed start capture and still verifies against H", async () => {
  const root = project();
  write(root, { "notes.md": "old dirt\n" });
  const run = gate(root);
  await run.input();
  const index = readFileSync(join(root, ".git/index"));
  writeFileSync(join(root, ".git/index"), "broken index");
  await run.tool("write");
  writeFileSync(join(root, ".git/index"), index);
  write(root, { "new.txt": "during request\n" });
  const settled = entry(await run.settle());
  expect(settled.details).toMatchObject({ startState: { status: "unknown", reason: expect.stringContaining("Git") },
    inherited: [], changed: [{ path: "new.txt", blob: expect.any(String) }, { path: "notes.md", blob: expect.any(String) }] });
  expect(settled.content).toContain("Unknown start state");
});

it("discloses a failed settlement capture when Git can no longer read the index", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  writeFileSync(join(root, ".git/index"), "broken index");
  const settled = entry(await run.settle());
  expect(settled.details).toMatchObject({ startState: { status: "known" },
    endState: { status: "unknown", reason: expect.stringContaining("Git") }, changed: "unreadable", weakened: "unreadable" });
  expect(settled.content).toContain("Unknown end state");
});

it("keeps index conflicts eligible and explains the unknown start state", async () => {
  const root = project();
  git(root, "branch", "other");
  write(root, { "notes.md": "one\n" });
  commit(root, "one");
  git(root, "switch", "other");
  write(root, { "notes.md": "two\n" });
  commit(root, "two");
  expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-"], { cwd: root }).status).toBe(1);
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt).toMatchObject({ startState: { status: "unknown", reason: "the index has unresolved conflicts" },
    inherited: [], changed: [{ path: "notes.md", blob: expect.any(String) }] });
});

it("measures exactly 10 MiB and 199 untracked files, and keeps paths relative inside a repository", async () => {
  const root = project();
  write(root, { "src/large.txt": "x".repeat(10 * 1024 * 1024),
    ...Object.fromEntries(Array.from({ length: 199 }, (_, k) => [`src/many/${k}.txt`, "x"])) });
  const run = gate(join(root, "src"));
  await run.input();
  await run.tool("bash");
  expect(await run.settle()).toBeUndefined();
  write(root, { "src/new space ñ.txt": "during request\n" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "new space ñ.txt", blob: expect.any(String) }]);
  expect(receipt.unmeasured).toEqual([]);
  expect(receipt.inherited).toHaveLength(200);
  expect(receipt.inherited).toContain("large.txt");
});

it("counts the 200-file limit within untracked directories, excluding tracked ancestors", async () => {
  const root = project();
  write(root, { "src/one.txt": "x", "src/two.txt": "x",
    ...Object.fromEntries(Array.from({ length: 199 }, (_, k) => [`src/many/${k}.txt`, "x"])) });
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  expect(await run.settle()).toBeUndefined();
});

it("attributes both sides of a rename and retains an unchanged deletion as inherited", async () => {
  const root = project();
  rmSync(join(root, "src/rule.ts"));
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  git(root, "mv", "notes.md", "renamed space.md");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.changed).toEqual([{ path: "notes.md", blob: null }, { path: "renamed space.md", blob: expect.any(String) }]);
  expect(receipt.inherited).toEqual(["src/rule.ts"]);
});

it.each(["tui", "print"])("leaves a %s request ready without verification when no tool or only readers started", async (mode) => {
  const root = repository({ "src/rule.ts": contract, "bun.lock": "",
    "package.json": JSON.stringify({ scripts: { check: "node -e \"require('node:fs').writeFileSync('.git/check-ran','ran')\"" } }) });
  const find = vi.fn(() => ({ provider: "openai", id: "gpt-6-sol" }));
  const run = gate(root, undefined, { mode, modelRegistry: { find }, flags: { "open-cases-model": undefined } });
  run.progress.ready("proofs_and_tests");
  await run.input("interactive", undefined, "hi");
  write(root, { "src/rule.ts": `${contract}// external change\n` });
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  const gitCalls = vi.spyOn(await import("../src/git.js"), "git");
  const diffCalls = vi.spyOn(await import("../src/git.js"), "gitOutput");
  try {
    expect(await run.settle()).toBeUndefined();
    for (const reader of ["read", "grep", "find", "ls"]) await run.tool(reader);
    expect(await run.settle()).toBeUndefined();
    expect(gitCalls).not.toHaveBeenCalled();
    expect(diffCalls).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".git", "check-ran"))).toBe(false);
    expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
    expect(run.steps.map(({ step }) => step)).toEqual(["ready", "waiting", "ready", "ready"]);
  } finally { gitCalls.mockRestore(); diffCalls.mockRestore(); }
});

it("never verifies, in a read-only session, the edits a parent makes in the folder it shares (#585)", async () => {
  const root = repository({ "src/rule.ts": contract, "bun.lock": "",
    "package.json": JSON.stringify({ scripts: { check: "node -e \"require('node:fs').writeFileSync('.git/check-ran','ran')\"" } }) });
  const run = gate(root, undefined, { mode: "print", flags: { "open-cases-model": undefined } });
  await run.input("interactive", undefined, "review the change");
  // The reviewer delegates to readers of its own, while its parent edits the folder they share.
  await run.tool("agent", true);
  await run.tool("grep", true);
  write(root, { "src/rule.ts": `${contract}// the parent's half-finished edit\n` });
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  expect(await run.settle()).toBeUndefined();
  expect(existsSync(join(root, ".git", "check-ran"))).toBe(false);
});

it.each(["prove", "bash", "powershell", "mcp__files__write", "unknown", "extension-tool", "agent"])(
  "verifies changed files after %s starts, even if the call never succeeds", async (name) => {
    const root = project();
    const run = gate(root);
    await run.input();
    await run.tool(name);
    write(root, { "notes.md": "changed\n" });
    expect((entry(await run.settle()).details as Receipt).changed).toMatchObject([{ path: "notes.md" }]);
    expect(entry(await run.settle("aborted")).details).toMatchObject({ stopped: expect.any(String), proofs: [], tests: [] });
  });

it.each(["steer", "followUp"])("keeps eligibility and send-back history through a %s and repeated settlements", async (behavior) => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/rule.ts": `${contract}// changed\n` });
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect((await run.settle())?.continue).toBe(true);
  await run.input("interactive", behavior, "also keep the change");
  run.agentStart();
  expect((entry(await run.settle()).details as Receipt).proofs).toMatchObject([{ verdict: "no_progress" }]);
  scripted.delete("src/rule.ts");
  expect((entry(await run.settle()).details as Receipt).proofs).toMatchObject([{ verdict: "proved" }]);
});

it.each(["interactive", "extension"])("starts a new %s request ineligible after an editing request", async (source) => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "notes.md": "changed\n" });
  expect(entry(await run.settle()).customType).toBe("tesota-receipt");
  await run.input(source, undefined, "hi");
  expect(await run.settle()).toBeUndefined();
  expect(run.progress.status.step).toBe("ready");
});

it("discloses a check script narrowed after its failing test went back, even when the remaining tests pass", async () => {
  const root = repository({
    "package.json": JSON.stringify({ type: "module", scripts: { check: "node --test test/positive.test.mjs test/negative.test.mjs" } }),
    "bun.lock": "", "src/price.mjs": "export const total = (n) => n;\n",
    "test/positive.test.mjs": priceTest(1, 1, "positive"), "test/negative.test.mjs": priceTest(-1, -1, "negative"),
  });
  const run = gate(root);
  await run.input("interactive", undefined, "Keep totals unchanged, including negative values.");
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(0, n);\n" });
  expect((await run.settle())?.continue).toBe(true);
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { check: "node --test test/positive.test.mjs" } }) });
  const settled = entry(await run.settle());
  expect(settled.customType).toBe("tesota-receipt");
  expect((settled.details as Receipt).tests).toMatchObject([{ evidence: { outcome: "passed" } }]);
  expect((settled.details as Receipt).weakened).toEqual([
    { path: "package.json", kind: "changed_check_script", script: "check" },
  ]);
  expect(settled.content).toContain("changes the command or selection of check script check");
  expect(receiptFindings(settled.details as Receipt)).toContainEqual({
    standing: "decide", check: "weakening", label: "May weaken the evidence", subject: "package.json",
    detail: "changes the command or selection of check script check", more: [],
    group: { title: "Review check script changes · %", noun: ["heuristic flag", "heuristic flags"],
      note: "May weaken evidence; not confirmed weakening.", item: "package.json: changes the command or selection of check script check" },
  });
  const excluded = spawnSync(process.execPath, ["--test", "test/negative.test.mjs"], { cwd: root, encoding: "utf8" });
  expect(excluded.status, excluded.stderr).toBe(1);
  expect(excluded.stdout).toContain("ERR_ASSERTION");
});

it("sends a failed or vacuous proof back, and lets the operator resolve one that could not run", () => {
  expect(gateVerdict("passed", "", [])).toBe("proved");
  expect(gateVerdict("failed", "A", [])).toBe("send_back");
  expect(gateVerdict("vacuous", "B", ["A"])).toBe("send_back");
  expect(gateVerdict("failed", "A", ["A", "B"])).toBe("no_progress");
  expect(gateVerdict("not_started", "A", [])).toBe("operator");
  expect(gateVerdict("timed_out", "A", ["A"])).toBe("operator");
  expect(keepsWorking(["proved", "operator", "no_progress"])).toBe(false);
  expect(keepsWorking(["proved", "send_back"])).toBe(true);
});

it("lists changed and untracked files, relative to the project, and nothing outside Git", async () => {
  const root = project();
  const base = await headCommit(root);
  expect(await changedFiles(root, base)).toEqual([]);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "src", "new.ts"), "export const a = 1;\n");
  rmSync(join(root, "notes.md"));
  expect(await changedFiles(root, base)).toEqual(["src/new.ts", "src/rule.ts"]);
  expect(await changedFiles(join(root, "src"), base)).toEqual(["new.ts", "rule.ts"]);
  const outside = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(outside);
  expect(await headCommit(outside)).toBeNull();
  expect(await changedFiles(outside, null)).toBeUndefined();
});

it("keeps the agent working while a changed contract fails, and settles with a receipt once it proves", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  expect(await run.settle()).toBeUndefined();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}export const changed = true;\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  writeFileSync(join(root, "src", "rule.dfy.gen"), "// regenerated\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: src/rule.ts does not prove yet.");
  expect(entry(failed).content).toContain("This is not finished yet.");
  expect(entry(failed).content).toContain("and run prove again.");
  // The operator's view of what went back: the proof and its evidence.
  expect(entry(failed).details).toMatchObject({ round: "proofs",
    proofs: [{ path: "src/rule.ts", evidence: { outcome: "failed", output: "1 verified, 1 error" } }] });
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect((await run.settle())?.continue).toBe(true);
  scripted.delete("src/rule.ts");
  const proved = await run.settle();
  expect(proved?.continue).toBeUndefined();
  expect(entry(proved).customType).toBe("tesota-receipt");
  expect(facts(entry(proved).content)).toBe(["  proved        src/rule.ts",
    "                content sha256 hash of src/rule.ts",
    "  not verified  src/rule.ts line 3: outside the contracts that proved, and no verifier covers them",
    "  not verified  notes.md: no verifier covers it",
    "  changed lines implementation +1 -0 · other +2 -1"].join("\n"));
  const receipt = entry(proved).details as Receipt;
  expect(receipt.proofs.map(({ path, verdict, evidence }) => [path, verdict, evidence.contentHash]))
    .toEqual([["src/rule.ts", "proved", "hash of src/rule.ts"]]);
  expect(receipt).toMatchObject({ version: 2, base: await headCommit(root), engine: "0.1.0" });
  expect(receipt.model).toBeUndefined();
  expect(Date.parse(receipt.settledAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
});

it("publishes each step for the footer: waiting, proving, sent back, testing, measuring, settled, and waiting on the next request", async () => {
  const root = project();
  const run = gate(root);
  run.progress.ready("proofs_only");
  await run.input();
  await run.tool("write");
  expect(run.progress.status).toEqual({ step: "waiting", readiness: "proofs_only" });
  writeFileSync(join(root, "src", "rule.ts"), contract.replace("return 0;", "return 1;"));
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  run.steps.length = 0;
  await run.settle();
  expect(run.steps).toEqual([{ step: "proving", path: "src/rule.ts", startedAt: expect.any(Number), tally: { proved: 0, notProved: 0 } },
    { step: "sent_back", tally: { proved: 0, notProved: 1 } }]);
  scripted.delete("src/rule.ts");
  run.steps.length = 0;
  const began = performance.now();
  const receipt = entry(await run.settle()).details as Receipt;
  const ended = performance.now();
  expect(run.steps.map(({ step }) => step)).toEqual(["proving", "testing", "measuring", "settled"]);
  for (const status of run.steps) {
    if ("startedAt" in status) {
      expect(status.startedAt).toBeGreaterThanOrEqual(began);
      expect(status.startedAt).toBeLessThanOrEqual(ended);
    }
  }
  expect(run.steps[2]).toEqual({ step: "measuring", startedAt: expect.any(Number), tally: { proved: 1, notProved: 0 } });
  expect(run.progress.status).toEqual({ step: "settled", receipt });
  await run.input();
  expect(run.progress.status).toEqual({ step: "waiting", readiness: "proofs_only" });
});

it("leaves a receipt verifying nothing when a run is stopped after a write starts", async () => {
  const root = project();
  const run = gate(root, undefined, { model: { provider: "provider", id: "model" } });
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), contract.replace("return 0;", "return 1;"));
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  const settled = await run.settle("aborted");
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).customType).toBe("tesota-receipt");
  const receipt = entry(settled).details as Receipt;
  expect(receipt).toMatchObject({ version: 2, repository: true, base: await headCommit(root), engine: "0.1.0",
    model: "provider/model", stopped: "the operator stopped the run before Tesota verified it",
    proofs: [], tests: [], contracts: [], exercises: [], weakened: [], unverified: [], uncovered: [], changed: [] });
  expect(receipt.claimcheck).toBeUndefined();
  expect(receipt.openCases).toBeUndefined();
  expect(Date.parse(receipt.settledAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
  expect(run.progress.status).toEqual({ step: "settled", receipt });
  expect(run.steps.map(({ step }) => step)).toEqual(["waiting", "settled"]);
});

it.each([
  ["the engine's reason", "quota exhausted", "quota exhausted"],
  ["its own reason when the host gives none", undefined, "the run failed before Tesota verified it"],
])("records why a run failed after a write starts: %s", async (_case, reason, stopped) => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  const settled = await run.settle("error", reason);
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).details).toMatchObject({ stopped, repository: true, base: await headCommit(root), proofs: [], tests: [] });
});

it("leaves no receipt when an aborted run only started a read", async () => {
  const run = gate(project());
  await run.input();
  // While the agent works, the footer says the gate waits for it, not that it is ready.
  expect(run.progress.status).toEqual({ step: "waiting", readiness: "nothing" });
  await run.tool("read");
  expect(await run.settle("aborted")).toBeUndefined();
  expect(run.progress.status).toEqual({ step: "ready", readiness: "nothing" });
});

it("keeps unknown bases unknown when a stopped write had no request input", async () => {
  const run = gate(folder());
  await run.tool("write");
  expect(entry(await run.settle("aborted")).details).toMatchObject({ repository: false, base: null,
    stopped: "the operator stopped the run before Tesota verified it", proofs: [], tests: [] });
});

it("clears a running footer operation when the run is aborted or fails", async () => {
  const run = gate(project());
  run.progress.ready("proofs_only");
  for (const outcome of ["aborted", "error"]) {
    run.progress.publish({ step: "proving", path: "src/rule.ts", startedAt: performance.now(), tally: { proved: 0, notProved: 0 } });
    expect(await run.settle(outcome)).toBeUndefined();
    expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_only" });
  }
});

it("shows a resumed session's receipt again, unless the operator spoke after it", () => {
  const progress = new GateProgress();
  progress.ready("proofs_and_tests");
  const receipt = { ...emptyReceipt, proofs: [] };
  const user = { type: "message", message: { role: "user", content: "a request", timestamp: 0 } };
  const settled = { type: "custom_message", customType: "tesota-receipt", content: "Tesota receipt", display: true, details: receipt };
  const gate = { type: "custom_message", customType: "tesota-gate", content: "sent back", display: true };
  progress.resume([user, gate, settled] as never);
  expect(progress.status).toEqual({ step: "settled", receipt });
  progress.reset();
  progress.resume([user, settled, user] as never);
  expect(progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
  progress.resume([user, gate] as never);
  expect(progress.status.step).toBe("ready");
  progress.resume([user, { ...settled, details: { version: 0 } }] as never);
  expect(progress.status.step).toBe("ready");
  progress.resume([user, { type: "custom", customType: "tesota-receipt", data: receipt }] as never);
  expect(progress.status).toEqual({ step: "settled", receipt });
});

it("settles a print-mode run with the receipt outside the conversation, so Pi prints the final answer (#427)", async () => {
  const root = repository({ "notes.md": "# Notes\n" });
  const printRun = gate(root, undefined, { mode: "print" });
  await printRun.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  const printed = (await printRun.settle())?.entries ?? [];
  expect(printed).toMatchObject([{ type: "custom", customType: "tesota-receipt", data: { version: 2 } }]);
  const tuiRun = gate(root, undefined, { mode: "tui" });
  await tuiRun.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes, changed again\n");
  const shown = (await tuiRun.settle())?.entries ?? [];
  expect(shown).toMatchObject([{ type: "custom_message", customType: "tesota-receipt", display: true, details: { version: 2 } }]);
});

it("goes back to ready when the gate fails midway or the run changed nothing", async () => {
  const root = project();
  const run = gate(root);
  run.progress.ready("proofs_and_tests");
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "throws" });
  await expect(run.settle()).rejects.toThrow("the prover broke");
  expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  await run.settle();
  expect(run.progress.status.step).toBe("sent_back");
  writeFileSync(join(root, "src", "rule.ts"), contract);
  expect(await run.settle()).toBeUndefined();
  expect(run.progress.status).toEqual({ step: "ready", readiness: "proofs_and_tests" });
});

it("lists the changed lines of a proved file that no contract covers, and not those of a contract that proved", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract.replace("return 0;", "return 1;")}\nexport function g(): number {\n` +
    "  return 1;\n}\n");
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toContain("  not verified  src/rule.ts lines 4-6: outside the contracts that proved, and no verifier covers them");
  expect((settled.details as Receipt).uncovered).toEqual([{ path: "src/rule.ts", lines: [[4, 6]] }]);
});

it("records the blob of every file the run left changed, and a deleted one as null", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "new.md"), "# New\n");
  rmSync(join(root, "notes.md"));
  const blob = spawnSync("git", ["hash-object", "src/new.md"], { cwd: root, encoding: "utf8" }).stdout.trim();
  expect((entry(await run.settle()).details as Receipt).changed).toEqual([{ path: "notes.md", blob: null },
    { path: "src/new.md", blob }]);
});

it("measures the strength of the contracts the request changed once they prove, judged against what the operator asked", async () => {
  const root = repository({ "src/rule.ts": contract,
    "src/other.ts": "//@ ensures \\result >= 0\nexport function g(): number {\n  return 1;\n}\n" });
  const asked: string[] = [];
  const complete = (_model: unknown, context: { messages: { content: { text: string }[] }[]; tools: { name: string }[] }): Promise<unknown> => {
    asked.push(context.messages[0]?.content[0]?.text ?? "");
    const name = context.tools[0]?.name;
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name, arguments: name === "record_comparisons"
      ? { comparisons: [{ function: 1, verdict: "not_justified", explanation: "It allows any non-negative result." }] }
      : { informalizations: [{ function: 1, preconditions: "none", postcondition: "non-negative", strength: "weak" }] } }] });
  };
  const run = gate(root, undefined, { model: { provider: "provider", id: "model" }, modelRegistry: { complete } });
  await run.input("interactive", undefined, "f returns zero");
  await run.tool("write");
  await run.input("interactive", "steer", "and only zero");
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result >= 0\n//@ ensures \\result <= 1\n" +
    "export function f(): number {\n  return 0;\n}\n");
  writeFileSync(join(root, "src", "other.ts"), "//@ ensures \\result >= 0\nexport function g(): number {\n  return 2;\n}\n");
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toContain(["  contract      f in src/rule.ts: all 1 decided changes to its code fail the proof",
    "  model judged  by ClaimCheck on provider/model, one model for both requests, a model's judgment against the request, not a proof:",
    "                f in src/rule.ts does not express what was asked: It allows any non-negative result."].join("\n"));
  expect(settled.content).not.toContain("g in src/other.ts");
  expect(asked[1]).toContain("1. f returns zero\n2. and only zero");
  expect((settled.details as Receipt).contracts.map(({ name, judgment }) => [name, judgment?.verdict])).toEqual([["f", "not_justified"]]);
});

it("restates with the model the claimcheck-model flag names", async () => {
  const root = project();
  const run = gate(root, undefined, { model: { provider: "provider", id: "model" }, flags: { "claimcheck-model": "other/missing" },
    modelRegistry: { find: () => undefined } });
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `//@ ensures true\n${contract}`);
  expect(entry(await run.settle()).content).toContain("ClaimCheck its restating model other/missing is not a provider/id in Pi's model registry");
});

it("lists the cases the request leaves open with GPT-6 Sol unless the operator names another model", async () => {
  const asked: { model: string; text: string; system: string }[] = [];
  const complete = (model: { provider: string; id: string }, context: { systemPrompt: string; messages: { content: { text: string }[] }[] }):
    Promise<unknown> => {
    asked.push({ model: `${model.provider}/${model.id}`, text: context.messages[0]?.content[0]?.text ?? "", system: context.systemPrompt });
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "record_open_cases",
      arguments: { status: "listed", cases: [{ input: "lateFee(-1)", outcomes: ["0", "-5"] }] } }] });
  };
  const find = (provider: string, id: string): object => ({ provider, id });
  for (const [named, model] of [[undefined, "openai/gpt-6-sol"], ["other/lister", "other/lister"]] as const) {
    const root = project();
    const run = gate(root, undefined, { model: { provider: "provider", id: "model" }, modelRegistry: { complete, find },
      flags: { "open-cases-model": named } });
    await run.input("interactive", undefined, "lateFee charges 5 per day late, at most 50");
    await run.tool("write");
    writeFileSync(join(root, "src", "notes.md"), "notes\n");
    const settled = entry(await run.settle());
    expect((settled.details as Receipt).openCases).toEqual({ status: "listed", model, cases: [{ input: "lateFee(-1)", outcomes: ["0", "-5"] }] });
    expect(facts(settled.content)).toContain(`  model listed  by ${model}, cases the request may leave open`);
    expect(asked.at(-1)).toMatchObject({ model, system: openCasesSystemPrompt });
    expect(asked.at(-1)?.text).toContain("A person gave a coding agent this request:\n\nlateFee charges 5 per day late, at most 50\n\n");
  }
});

it("reports missing issue contents instead of inventing an open case for the #575 request (#582)", async () => {
  const root = project();
  const reason = "Issue #575 and its comments are not supplied in the request; their requirements cannot be read.";
  const asked: string[] = [];
  const complete = (_model: unknown, context: { messages: { content: { text: string }[] }[] }): Promise<unknown> => {
    asked.push(context.messages[0]?.content[0]?.text ?? "");
    return Promise.resolve({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "record_open_cases",
      arguments: { status: "not_listed", reason } }] });
  };
  const run = gate(root, undefined, { model: { provider: "provider", id: "model" },
    modelRegistry: { complete, find: (provider: string, id: string) => ({ provider, id }) },
    flags: { "open-cases-model": "openai/gpt-6-sol" } });
  await run.input("interactive", undefined, "Fix issue #575 (read it and its comments with gh issue view 575 --comments).");
  await run.tool("write");
  writeFileSync(join(root, "src", "notes.md"), "The agent's solution must not reach the lister.\n");
  const settled = entry(await run.settle());
  expect((settled.details as Receipt).openCases).toEqual({ status: "not_listed", reason: `openai/gpt-6-sol ${reason}` });
  expect(facts(settled.content)).toContain("  not listed    the cases the request leaves open:");
  expect(settled.content).not.toContain("cases the request may leave open");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("Fix issue #575 (read it and its comments with gh issue view 575 --comments).");
  expect(asked[0]).not.toContain("The agent's solution");
  expect(asked[0]).toContain("Missing reference contents are not an open case");
});

it("leaves the open cases out when the operator turns the list off, and says why when no model lists them", async () => {
  const root = project();
  const off = gate(root, undefined, { model: { provider: "provider", id: "model" }, modelRegistry: { find: () => undefined } });
  await off.input();
  await off.tool("write");
  writeFileSync(join(root, "src", "notes.md"), "notes\n");
  expect((entry(await off.settle()).details as Receipt).openCases).toBeUndefined();
  const missing = gate(root, undefined, { model: { provider: "provider", id: "model" }, modelRegistry: { find: () => undefined },
    flags: { "open-cases-model": "nobody/none" } });
  await missing.input();
  await missing.tool("write");
  writeFileSync(join(root, "src", "notes.md"), "more notes\n");
  const settled = entry(await missing.settle());
  expect((settled.details as Receipt).openCases).toEqual({ status: "not_listed", reason: "nobody/none is not a provider/id in Pi's model registry" });
  expect(facts(settled.content)).toContain("  not listed    the cases the request leaves open: nobody/none is not a provider/id in Pi's model registry");
});

it("sends a weak contract back once, then lists it in the receipt", async () => {
  mutantOutcome = "passed";
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result <= 5\nexport function f(): number {\n  return 0;\n}\n");
  const sent = await run.settle();
  expect(sent?.continue).toBe(true);
  expect(entry(sent).content).toMatch(/^Tesota: the contract of f in src\/rule\.ts proves, but these changes to its code prove too, so it does not rule them out:\n {2}line 3: 0 became 1\n\nStrengthen the contract/u);
  expect(entry(sent).details).toMatchObject({ round: "contracts",
    contracts: [{ path: "src/rule.ts", name: "f", mutation: { survived: [{ line: 3, before: "0", after: "1" }] } }] });
  const settled = entry(await run.settle());
  expect(settled.customType).toBe("tesota-receipt");
  expect(facts(settled.content)).toContain("  weak contract f in src/rule.ts");
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), "//@ ensures \\result <= 6\nexport function f(): number {\n  return 0;\n}\n");
  expect((await run.settle())?.continue).toBe(true);
});

it("stops on any failure already sent back, alternating ones included, and forgets them on the operator's input only", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "A" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  scripted.set("src/rule.ts", { outcome: "failed", output: "B" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  scripted.set("src/rule.ts", { outcome: "failed", output: "A" });
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toContain(
    "  NOT proved    src/rule.ts: an obligation fails, repeating a failure already sent back");
  expect((entry(stuck).details as Receipt).proofs.map(({ verdict }) => verdict)).toEqual(["no_progress"]);
  await run.input("extension", "followUp");
  expect((await run.settle())?.continue).toBeUndefined();
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed again\n`);
  expect((await run.settle())?.continue).toBe(true);
});

it("reports a proof that could not run to the operator instead of sending it back", async () => {
  const root = project();
  const run = gate(root);
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "not_started", output: "Dafny is not installed, so nothing was proved." });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).content).toContain(
    "  NOT proved    src/rule.ts: the proof could not run: Dafny is not installed, so nothing was proved.");
});

it("tells the agent to finish its turn instead of running prove when prove is not active", async () => {
  const root = project();
  const run = gate(root, ["read", "edit"]);
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = entry(await run.settle()).content;
  expect(failed).toContain("and finish your turn, and Tesota will prove the file again.");
  expect(failed).not.toContain("prove again");
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect(entry(await run.settle()).content).toContain("Fix that and finish your turn, and Tesota will prove the file again.");
});

/** A tested package in a folder that is in no Git repository. */
function plainProject(): string {
  const root = folder();
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }), "bun.lock": "",
    "src/price.mjs": "export const total = (n) => n;\n", "test/price.test.mjs": priceTest(1, 1) + priceTest(2, 2, "two").split("\n").at(-2) });
  return root;
}

it("verifies a folder in no repository against Tesota's snapshot of it, whatever changed its files, and leaves it as it was", async () => {
  const root = plainProject();
  const run = gate(root);
  await run.input();
  await run.tool("bash");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  expect(facts(entry(settled).content)).toBe([
    "  passed        bun run test",
    "  notices change test/negative.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; added in this request",
    "  not proved    src/price.mjs: no proof covers it; the project's commands pass with it",
    "  changed lines implementation +1 -1 · tests +4 -0"].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect([receipt.repository, receipt.snapshot]).toEqual([false, true]);
  expect(receipt.base).toMatch(/^[0-9a-f]{40}$/u);
  expect(existsSync(join(root, ".git"))).toBe(false);
  // The next request's snapshot holds these changes, so a run that changes nothing settles with no receipt.
  await run.input();
  expect(await run.settle()).toBeUndefined();
}, 60_000);

it("flags a test weakened in a folder in no repository", async () => {
  const root = plainProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/price.test.mjs": priceTest(1, 1) });
  expect(facts(entry(await run.settle()).content)).toContain("  may weaken    test/price.test.mjs: edits a test file");
}, 60_000);

it("says why a folder Tesota does not snapshot was not verified, once a tool may have changed files", async () => {
  const home = homedir();
  const run = gate(home);
  await run.input();
  await run.tool("read");
  expect(await run.settle()).toBeUndefined();
  await run.tool("edit");
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe("  not verified  this request's changes: Tesota does not snapshot a home folder " +
    "or a drive's root");
  expect((settled.details as Receipt).repository).toBe(false);
});

it("proves a contract file whose .dfy alone changed, and leaves runs that did not complete alone", async () => {
  const root = project();
  const run = gate(root);
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  expect(await run.settle("aborted")).toBeUndefined();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.dfy"), "// hand-written proof line\n");
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});

it("proves a contract file whose .dfy alone changed where LemmaScript's proof-dir keeps it, and only there (#403)", async () => {
  const root = repository({ "lemmascript.json": JSON.stringify({ "proof-dir": "proofs" }), "src/rule.ts": contract,
    "proofs/src/rule.dfy": "// proof\n", "notes.md": "# Notes\n" });
  const run = gate(root);
  await run.tool("write");
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  // LemmaScript keeps this project's proofs under proofs/, so a .dfy beside the source is not its proof.
  writeFileSync(join(root, "src", "rule.dfy"), "// stray\n");
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  expect(entry(await run.settle()).customType).toBe("tesota-receipt");
  writeFileSync(join(root, "proofs", "src", "rule.dfy"), "// proof\n// hand-written proof line\n");
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});

it("measures from the commit the request started at, so an agent's commit hides nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  commit(root, "agent");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
  scripted.delete("src/rule.ts");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
  expect(receipt.unverified).toEqual(["notes.md"]);
  await run.input();
  expect(await run.settle()).toBeUndefined();
});

it("keeps the running request's base through a steer or follow-up sent after the agent committed", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  commit(root, "agent");
  await run.input("interactive", "steer");
  await run.input("interactive", "followUp");
  expect((entry(await run.settle()).details as Receipt).proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
});

it("leaves out of the receipt's files those whose changed lines are all blank or comments, //@ lines aside", async () => {
  const root = repository({ "src/rule.ts": contract, "notes.md": "# Notes\n", "src/helper.ts": "export const one = 1;\n",
    "src/tool.py": "x = 1\n", "src/legacy.js": "export const two = 2;\n", "logo.bin": "\0\u0001" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/helper.ts": "// One, as a constant.\n\nexport const one = 1;\n", "src/note.ts": "/* Nothing yet.\n * Later.\n */\n",
    "src/tool.py": "# The tool's value.\nx = 1\n", "src/legacy.js": "//@ ensures true\nexport const two = 2;\n",
    "notes.md": "# Notes, changed\n", "logo.bin": "\0\u0002" });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.unverified).toEqual(["logo.bin", "notes.md", "src/legacy.js"]);
  expect(receipt.commentsOnly).toBeUndefined();
});

it("settles a change of comments and blank lines alone with a receipt and footer that say nothing needed verifying", async () => {
  const root = repository({ "src/helper.ts": "export const one = 1;\n", "src/tool.py": "x = 1\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/helper.ts": "// One, as a constant.\n\nexport const one = 1;\n", "src/tool.py": "# The tool's value.\nx = 1\n" });
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe("  no code       nothing to verify: the changes are comments or blank lines only\n  changed lines implementation +3 -0");
  expect((settled.details as Receipt).commentsOnly).toBe(true);
  expect(evidenceText(evidenceParts(run.progress.status), "full")).toBe("✓ receipt · nothing to verify, comments only");
});

it("lists every file in a repository whose first commit the agent made", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  git(root, "init", "-q");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  commit(root, "agent");
  expect((entry(await run.settle()).details as Receipt).unverified).toEqual(["notes.md"]);
});

it("puts each change that may weaken the evidence in the receipt, committed or not", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  const rule = ["//@ requires x >= 0", "//@ ensures \\result >= 0", "//@ ensures \\result >= x",
    "export function f(x: number): number { return x; }", "", "export function g(y: number): number { return y; }", ""];
  writeFileSync(join(root, "src", "rule.ts"), rule.join("\n"));
  writeFileSync(join(root, "src", "rule.dfy"), "method f(x: int) returns (r: int)\n{\n  r := x;\n}\n");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it('f', () => {});\n");
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), ["//@ requires x >= 1", "//@ ensures   \\result >= x", "//@ assume x < 10",
    "export function f(x: number): number { return x; }", "", "//@ skip", "//@ requires y > 0",
    "export function g(y: number): number { return y; }", "", "//@ skip", "//@ requires z > 0",
    "export function h(z: number): number { return z; }", ""].join("\n"));
  rmSync(join(root, "tests", "old.test.ts"));
  commit(root, "agent");
  // LemmaScript's own model of `split`, which its generated program holds, is not the change's assumption.
  const model = "function {:axiom} StringSplit(s: string, d: string): seq<string>\n";
  writeFileSync(join(root, "src", "rule.dfy"), `${model}method f(x: int) returns (r: int)\n{\n  assume false;\n  r := x;\n}\n` +
    "\nlemma Free()\n  ensures false\n");
  writeFileSync(join(root, "src", "rule.dfy.gen"), `${model}method f(x: int) returns (r: int)\n{\n  r := x;\n}\n`);
  writeFileSync(join(root, "src", "extra.dfy"), "lemma {:axiom} Given()\n  ensures false\n");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it.skip('f', () => {});\n");
  writeFileSync(join(root, "src", "new.ts"), "//@ assume false\nexport const a = 1;\n");
  writeFileSync(join(root, "tests", "new.test.ts"), "it('new', () => {});\n");
  const settled = entry(await run.settle());
  expect(facts(settled.content).split("\n").filter((line) => line.startsWith("  may weaken"))).toEqual([
    "  may weaken    src/extra.dfy: trusts Given without proving it (lemma {:axiom} Given())",
    "  may weaken    src/extra.dfy: takes lemma Given as true without proving it (lemma Given without a body)",
    "  may weaken    src/new.ts: takes false as true without proving it (//@ assume false)",
    "  may weaken    src/rule.dfy: takes false as true without proving it (assume false;)",
    "  may weaken    src/rule.dfy: takes lemma Free as true without proving it (lemma Free without a body)",
    "  may weaken    src/rule.ts: removes or changes //@ requires x >= 0",
    "  may weaken    src/rule.ts: removes or changes //@ ensures \\result >= 0",
    "  may weaken    src/rule.ts: adds //@ requires x >= 1 to a function the base had",
    "  may weaken    src/rule.ts: takes x < 10 as true without proving it (//@ assume x < 10)",
    "  may weaken    src/rule.ts: leaves g out of the proof (//@ skip)",
    "  may weaken    src/rule.ts: adds //@ requires y > 0 to a function the base had",
    "  may weaken    tests/old.test.ts: deletes a test file",
    "  may weaken    tests/rule.test.ts: edits a test file",
  ]);
  expect((settled.details as Receipt).weakened).toContainEqual(
    { path: "tests/old.test.ts", kind: "deleted_test" });
  // The proof holds only given the assumptions added to its source and its .dfy, not those of another file (#399).
  expect(facts(settled.content)).toContain("  proved        src/rule.ts, trusting 3 unproved parts the change added");
});

it("settles with a receipt when the only change deletes a test", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  rmSync(join(root, "tests", "old.test.ts"));
  expect(facts(entry(await run.settle()).content)).toBe("  may weaken    tests/old.test.ts: deletes a test file\n  changed lines tests +0 -1");
});

it("says a change too large to read was not checked for weakening, instead of listing nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "x\n".repeat(9 * 1024 * 1024));
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe([
    "  not measured  Unmeasured: notes.md: file exceeds 10 MiB",
    "  not checked   weakened evidence: the change is too large to check for weakening",
    ].join("\n"));
  expect((settled.details as Receipt).weakened).toBe("too_large");
}, 60_000);
it("runs the project's tests, and runs each changed test on the request's base even after the agent commits", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n",
    "test/negative.test.mjs": priceTest(-1, 0), "test/positive.test.mjs": priceTest(2, 2),
    "test/__snapshots__/price.test.mjs.snap": "exports[`total 1`] = `1`;\n", "test/fixtures/prices.json": "[1, 2]\n" });
  commit(root, "the agent's change");
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  const changed = ["src/price.mjs", "test/__snapshots__/price.test.mjs.snap", "test/fixtures/prices.json", "test/negative.test.mjs",
    "test/positive.test.mjs"];
  // The snapshot and the fixture are no tests a runner runs alone, so they get no line of their own on the base (#615).
  expect(facts(entry(settled).content)).toBe([
    "  passed        bun run test",
    "  notices change test/negative.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; added in this request",
    "  passes on base test/positive.test.mjs: it passes without the change too; " +
    "by the whole check, `bun run test`; added in this request",
    "  not proved    src/price.mjs: no proof covers it; the project's commands pass with it",
    "  changed lines implementation +1 -1 · tests +10 -0"].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect(receipt.tests.map(({ command, evidence }) => [command, evidence.verifier, evidence.files]))
    .toEqual([["bun run test", "command", changed]]);
  // The base ran in a worktree that is gone, and the checkout's dependencies it linked are not.
  expect(spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.match(/^worktree /gmu))
    .toHaveLength(1);
  expect(existsSync(join(root, "node_modules", "dep", "index.js"))).toBe(true);
}, 60_000);

it("neither flags nor lists as not proved a test file that only gains a test", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  const base = readFileSync(join(root, "test", "price.test.mjs"), "utf8");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n",
    "test/price.test.mjs": `${base}test("negative", () => { assert.equal(total(-1), 0); });\n` });
  const settled = entry(await run.settle());
  expect(facts(settled.content)).toBe([
    "  passed        bun run test",
    "  notices change test/price.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; changed in this request",
    "  not proved    src/price.mjs: no proof covers it; the project's commands pass with it",
    "  changed lines implementation +1 -1 · tests +1 -0"].join("\n"));
  const receipt = settled.details as Receipt;
  expect(receipt.weakened).toEqual([]);
  expect(receipt.unverified).toEqual(["src/price.mjs"]);
}, 60_000);

it("sends failing tests back once when the project writes no test report, then settles with the failure", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/negative.test.mjs": priceTest(-1, 0) });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: `bun run test` fails with your changes.");
  expect(entry(failed).details).toMatchObject({ round: "tests", commands: [{ command: "bun run test", evidence: { outcome: "failed" } }] });
  run.agentStart();
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(facts(entry(stuck).content)).toBe([
    "  NOT passed    bun run test: it still fails after its failure went back",
    "  changed lines tests +4 -0"].join("\n"));
  await run.input();
  await run.tool("write");
  write(root, { "test/negative.test.mjs": priceTest(-2, 0) });
  expect((await run.settle())?.continue).toBe(true);
}, 60_000);

it("sends failing tests back until the set that fails repeats one already sent, read from the test report", async () => {
  const root = testedProject("node --test --test-reporter=junit --test-reporter-destination=report.xml");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "test/a.test.mjs": priceTest(-1, 0, "a") });
  const first = await run.settle();
  expect(first?.continue).toBe(true);
  expect(entry(first).content).toContain("These tests fail:\n  test > a\n");
  run.agentStart();
  write(root, { "test/b.test.mjs": priceTest(-2, 0, "b") });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  rmSync(join(root, "test", "b.test.mjs"));
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toContain(
    "  NOT passed    bun run test: these tests fail, as they did when they went back: test > a");
  expect((entry(stuck).details as Receipt).tests.map(({ failingTests }) => failingTests)).toEqual([["test > a"]]);
}, 60_000);

/** A base whose own test already fails, a change that fixes it and adds a test for a module the base lacks. */
async function newTestOverFailingBase(test: string): Promise<Settled | undefined> {
  const root = testedProject(test);
  write(root, { "test/negative.test.mjs": priceTest(-1, 0, "negative") });
  commit(root, "a failing test");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n",
    "src/discount.mjs": "export const discount = (n) => n / 2;\n",
    "test/discount.test.mjs": "import assert from \"node:assert\";\nimport { test } from \"node:test\";\n" +
      "import { discount } from \"../src/discount.mjs\";\ntest(\"discount\", () => { assert.equal(discount(4), 2); });\n" });
  return run.settle();
}

it("counts a new test as exercising the change when its tests newly fail on a base that fails anyway", async () => {
  const settled = await newTestOverFailingBase("node --test --test-reporter=junit --test-reporter-destination=report.xml");
  expect(facts(entry(settled).content)).toContain("  notices change test/discount.test.mjs: fails on the base, passes with the change; " +
    "by the whole check, `bun run test`; added in this request");
}, 60_000);

it("says a test report would tell, when the base fails with and without a new test and writes none", async () => {
  const settled = await newTestOverFailingBase("node --test");
  expect(facts(entry(settled).content)).toContain("  not checked   test/discount.test.mjs: on the base it failed, but so does the " +
    "base without it, and no test report says which tests fail; by the whole check, `bun run test`; " +
    "added in this request");
}, 60_000);

it("gives no verdict on the base when the change touches what decides the dependencies", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" }, description: "changed" }),
    "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  expect(facts(entry(await run.settle()).content)).toContain("  not checked   test/negative.test.mjs: the change touches " +
    "package.json, and the base runs with the checkout's dependencies, so a run there may not be faithful; added in this request");
}, 60_000);

it("runs only the commands of the projects that own the changed files, there and on the base", async () => {
  const passing = "import { test } from \"node:test\";\ntest(\"ok\", () => {});\n";
  const root = repository({
    "a/package.json": JSON.stringify({ scripts: { test: "node --test" } }), "a/bun.lock": "", "a/test/x.test.mjs": passing,
    "b/package.json": JSON.stringify({ scripts: { test: "node -e process.exit(1)" } }), "b/bun.lock": "",
  });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "a/test/y.test.mjs": passing });
  expect(facts(entry(await run.settle()).content)).toBe(["  passed        cd a && bun run test",
    "  passes on base a/test/y.test.mjs: it passes without the change too; " +
    "by the whole check, `cd a && bun run test`; added in this request",
    "  changed lines tests +2 -0"].join("\n"));
}, 60_000);

/** A folder that is no repository, holding `api`, a tested package, and `rules`, a contract, each its own repository, and plain files. */
function workspace(): string {
  const root = folder();
  testedProject("node --test", join(root, "api"));
  project(join(root, "rules"));
  write(root, { "AGENTS.md": "# Rules\n", "notes/todo.md": "- one\n", ".hidden/x.md": "x\n", "node_modules/dep/x.js": "x\n" });
  return root;
}

it("verifies each repository the request changed in a folder of repositories, from its own base with its own commands", async () => {
  const root = workspace();
  const rulesBase = await headCommit(join(root, "rules"));
  const run = gate(root);
  await run.input();
  await run.tool("edit");
  write(join(root, "api"), { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n" });
  writeFileSync(join(root, "rules", "src", "rule.ts"), `${contract}// changed\n`);
  commit(join(root, "rules"), "the agent's commit");
  write(root, { "notes/todo.md": "- one\n- two\n" });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  // The folders in no repository are measured against Tesota's snapshot: the one changed is listed, the workspace's own files are not.
  expect(facts(entry(settled).content)).toBe([
    "  passed        cd api && bun run test",
    "  not proved    api/src/price.mjs: no proof covers it; the project's commands pass with it",
    "  not verified  notes/todo.md: no verifier covers it",
    "  proved        rules/src/rule.ts",
    "                content sha256 hash of src/rule.ts",
    "  changed lines implementation +2 -1 · other +1 -0"].join("\n"));
  const receipt = entry(settled).details as Receipt;
  expect(receipt.units?.map(({ folder: at, repository, snapshot }) => [at, repository, snapshot ?? false]))
    .toEqual([["api", true, false], ["notes", false, true], ["rules", true, false]]);
  expect(receipt.units?.[2]?.base).toBe(rulesBase);
  // Each repository's evidence stays in its own terms, as a pull request in it reads them.
  expect(receipt.units?.[2]?.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
  expect(receipt.units?.[0]?.tests.map(({ command }) => command)).toEqual(["bun run test"]);
  expect(existsSync(join(root, "notes", ".git"))).toBe(false);
}, 60_000);

it("sends a repository's failure back by its path in the folder, and runs nothing in a repository the request left alone", async () => {
  const root = folder();
  project(join(root, "a"));
  testedProject("node -e process.exit(1)", join(root, "b"));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "a", "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const back = entry(await run.settle());
  expect(back.content).toContain("Tesota: a/src/rule.ts does not prove yet.");
  expect((back.details as SentBack).round).toBe("proofs");
  scripted.delete("src/rule.ts");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.units?.map(({ folder: at }) => at)).toEqual(["a"]);
  expect(receipt.base).toBeNull();
});

it("keeps one repository's repeated failure from stopping another's from going back", async () => {
  const root = folder();
  project(join(root, "a"));
  project(join(root, "b"));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "a", "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect(entry(await run.settle()).content).toContain("Tesota: a/src/rule.ts does not prove yet.");
  writeFileSync(join(root, "b", "src", "rule.ts"), `${contract}// changed\n`);
  const back = entry(await run.settle());
  expect(back.content).not.toContain("a/src/rule.ts");
  expect(back.content).toContain("Tesota: b/src/rule.ts does not prove yet.");
});

/** A model of `src/counter.ts`, with its configuration and one planted fault, as a header declares them. */
const counterModel = (name = "Counter"): Record<string, string> => ({
  [`models/${name}.tla`]: `(* tesota-model\n   covers: src/counter.ts\n   invariant: Safe\n   atomic: each step\n   omits: crashes\n` +
    `   fault: models/Fault.cfg lock removed\n*)\n---- MODULE ${name} ----\n====\n`,
  [`models/${name}.cfg`]: "SPECIFICATION Spec\n", "models/Fault.cfg": "SPECIFICATION Spec\n" });

it("model-checks a model when the request changes the code it covers, and leaves it alone otherwise", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", "notes.md": "# Notes\n", ...counterModel() });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes, edited\n");
  const untouched = entry(await run.settle()).details as Receipt;
  expect(untouched.models).toBeUndefined();
  expect(modelCalls.size).toBe(0);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const settled = entry(await run.settle());
  const receipt = settled.details as Receipt;
  expect(receipt.models?.map(({ path, verdict, evidence }) => [path, verdict, evidence.verifier])).toEqual([["models/Counter.tla", "proved", "tlc"]]);
  expect(run.steps.some((status) => status.step === "checking" && status.path === "models/Counter.tla")).toBe(true);
  expect(receiptFindings(receipt).filter(({ check }) => check === "model").map(({ standing, label }) => [standing, label]))
    .toEqual([["holds", "Model-checked"], ["gap", "Model possibly stale"]]);
  expect(facts(settled.content)).toContain("  model-checked models/Counter.tla: Safe holds in all 9 reachable states; caught 1 of 1 planted fault; " +
    "not linked to the code");
  expect(settled.content).toContain("Leaves out: crashes");
});

it("sends back a model whose planted fault passes, keeps each check of unchanged content, and reports the repeat as too weak", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel(), ...counterModel("Other") });
  scriptedModels.set("models/Counter.tla", () => ({ outcome: "failed", run: "passed",
    faults: [{ path: "models/Fault.cfg", description: "lock removed", verdict: "passes", output: "", durationMs: 1 }] }));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const sent = await run.settle();
  expect(sent?.continue).toBe(true);
  expect(entry(sent).content).toMatch(/^Tesota: the model models\/Counter\.tla passes, but these planted faults pass too, so the model cannot tell them from the code:\n {2}models\/Fault\.cfg: lock removed/u);
  expect(entry(sent).details).toMatchObject({ round: "models", models: [{ path: "models/Counter.tla" }], unheaded: [] });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.models?.map(({ path, verdict }) => [path, verdict])).toEqual([["models/Counter.tla", "no_progress"], ["models/Other.tla", "proved"]]);
  expect(modelCalls.get("models/Other.tla")).toBe(1);
  expect(modelCalls.get("models/Counter.tla")).toBe(1);
  expect(receiptFindings(receipt).find(({ label }) => label === "Model too weak")).toMatchObject({ standing: "decide",
    detail: "models/Fault.cfg passes" });
});

it("never fails a run when TLC cannot check a model, and says why", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  scriptedModels.set("models/Counter.tla", () => ({ outcome: "not_started", run: "not_started", faults: [] }));
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.models?.[0]?.verdict).toBe("operator");
  expect(receiptFindings(receipt).find(({ check }) => check === "model")).toMatchObject({ standing: "gap", label: "Model not checked" });
  expect(receiptDecisions(receipt)).toBe(0);
});

it("asks once for a header on a TLA+ model the request wrote without one, then lists it as not checked", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n" });
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "spec/Race.tla": "---- MODULE Race ----\n====\n", "spec/Race.cfg": "INIT Init\n", "spec/Helper.tla": "---- MODULE Helper ----\n====\n" });
  const sent = await run.settle();
  expect(sent?.continue).toBe(true);
  expect(entry(sent).content).toMatch(/^Tesota: spec\/Race\.tla looks like a model with no tesota-model header/u);
  expect(entry(sent).details).toMatchObject({ round: "models", models: [], unheaded: ["spec/Race.tla"] });
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.unheaded).toEqual(["spec/Race.tla"]);
  expect(receiptFindings(receipt).find(({ check }) => check === "model")).toMatchObject({ standing: "gap", subject: "spec/Race.tla" });
});


/** What the gate published of its operations, as the status line and the timeline read them. */
const shape = (run: ReturnType<typeof gate>): (string | undefined)[][] =>
  run.progress.operations.operations().map(({ method, target, state, result }) => [method, target, state, result]);

it("publishes each proof and closes a send-back attempt as returned to the agent, the next as settled (#590)", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "rule.ts"), contract.replace(">= 0", ">= 1").replace("return 0;", "return 1;"));
  scripted.set("src/rule.ts", { outcome: "failed", output: "boom" });
  expect((await run.settle())?.continue).toBe(true);
  const ops = run.progress.operations;
  expect(ops.operations()).toMatchObject([{ method: "proof", unit: "", state: "ended", result: "failed", generation: 1,
    target: expect.stringContaining("src/rule.ts") }]);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "returned_to_agent" }]);
  scripted.set("src/rule.ts", { outcome: "passed", output: "1 verified, 0 errors" });
  run.agentStart();
  expect((await run.settle())?.continue).toBeUndefined();
  const second = ops.operations().filter(({ generation }) => generation === 2);
  expect(second.map(({ method, result }) => [method, result])).toEqual([["proof", "passed"], ["mutation", "done"], ["claimcheck", "done"],
    ["receipt", "done"]]);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "returned_to_agent" }, { generation: 2, closedAs: "settled" }]);
  expect(ops.operations().every(({ state }) => state === "ended")).toBe(true);
  expect(ops.line(performance.now())).toBeUndefined();
});

it("publishes the test rung's commands, each test on the base and its base control, with the exact command (#590)", async () => {
  const root = testedProject();
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, { "src/price.mjs": "export const total = (n) => Math.max(n, 0);\n", "test/negative.test.mjs": priceTest(-1, 0) });
  await run.settle();
  expect(shape(run)).toEqual([["command", "bun run test", "ended", "passed"], ["exercise", "bun run test", "ended", "failed"],
    ["base_control", "bun run test", "ended", "passed"], ["command", "bun run test", "ended", "passed"], ["receipt", "receipt", "ended", "done"]]);
  const [, exercise, control] = run.progress.operations.operations();
  expect(control?.parent).toBe(exercise?.id);
  for (const { startedAt, endedAt, durationMs } of run.progress.operations.operations()) {
    expect(endedAt).toBeGreaterThanOrEqual(startedAt ?? Infinity);
    expect(durationMs).toBe((endedAt ?? 0) - (startedAt ?? 0));
  }
}, 60_000);

it("shows a command that prints nothing with its exact command and growing time, and a stop marks the rest as not started (#590)", async () => {
  const root = repository({ "package.json": JSON.stringify({ scripts: { typecheck: "node -e \"setTimeout(function(){}, 60000)\"",
    lint: "node -e 0", test: "node -e 0" } }), "bun.lock": "", "src/a.mjs": "export const a = 1;\n" });
  const controller = new AbortController();
  const run = gate(root, undefined, { signal: controller.signal });
  await run.input();
  await run.tool("write");
  write(root, { "src/a.mjs": "export const a = 2;\n" });
  const settling = run.settle();
  const ops = run.progress.operations;
  await vi.waitFor(() => expect(ops.line(performance.now())).toMatch(/^Running project check · bun run typecheck · 0:01$/u),
    { timeout: 20_000, interval: 50 });
  expect(ops.line(performance.now())).not.toMatch(/%|remaining|estimat/iu);
  expect(ops.operations().filter(({ state }) => state === "planned").map(({ target }) => target)).toEqual(["bun run lint", "bun run test"]);
  controller.abort();
  expect(entry(await settling).details).toMatchObject({ stopped: "the operator stopped the run while Tesota verified it" });
  expect(shape(run)).toEqual([["command", "bun run typecheck", "ended", "cancelled"], ["command", "bun run lint", "ended", "not_started"],
    ["command", "bun run test", "ended", "not_started"]]);
  expect(ops.operations().slice(1).map(({ startedAt }) => startedAt)).toEqual([undefined, undefined]);
  expect(ops.attempts()).toEqual([{ generation: 1, closedAs: "stopped" }]);
  expect(ops.line(performance.now())).toBeUndefined();
}, 60_000);

it("publishes the open-case listing, and a model check kept from an earlier check as reused (#590)", async () => {
  const root = repository({ "src/counter.ts": "export const n = 0;\n", ...counterModel() });
  const run = gate(root, undefined, { flags: { "open-cases-model": "test/lister" }, modelRegistry: {
    find: () => ({ provider: "test", id: "lister" }), complete: () => Promise.resolve({ stopReason: "toolUse",
      content: [{ type: "toolCall", id: "result", name: "record_open_cases", arguments: { status: "listed", cases: [] } }] }) } });
  await run.input();
  await run.tool("write");
  writeFileSync(join(root, "src", "counter.ts"), "export const n = 1;\n");
  await run.settle();
  // The scripted model check publishes nothing of its own, as TLC's runner does.
  expect(shape(run).map(([method]) => method)).toEqual(["receipt", "open_cases"]);
  expect(run.progress.operations.operations().find(({ method }) => method === "open_cases")).toMatchObject({ target: "test/lister", result: "done" });
  run.agentStart();
  await run.tool("write");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  await run.settle();
  const reused = run.progress.operations.operations().filter(({ reused: kept }) => kept);
  expect(reused).toMatchObject([{ method: "model_main", target: "models/Counter.tla", result: "passed", durationMs: 0 }]);
});
