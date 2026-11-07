import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { contentHash, type Evidence } from "../src/evidence.js";
import type { GateProgress, GateStatus, RecordedRequest } from "../src/gate.js";
import { host, provideHost } from "../src/host.js";
import type { ModelCheck } from "../src/model-check.js";
import { receiptMarkdown } from "../src/pull-request-receipt.js";
import { entryReceipt, receiptFindings, receiptSummary, renderReceipt, type Receipt } from "../src/receipt.js";
import type { ProofOutcome } from "../src/verification/proof-outcome-rule.js";

export const state: {
  verificationModels: ReturnType<ReturnType<typeof host>["verificationModels"]>;
  mutantOutcome: ProofOutcome;
  /** Whether proving writes the proof beside its source, as `lsc regen` does where none was generated yet. */
  regenerates: boolean;
} = { verificationModels: {}, mutantOutcome: "failed", regenerates: false };

/** The proofs the gate runs, scripted per file: the gate's decisions, not LemmaScript, are under test here. */
export const scripted: Map<string, { outcome: ProofOutcome; output: string }> = new Map();

/** Model checks scripted per model, each call counted: the gate's decisions, not TLC, are under test here. */
export const scriptedModels: Map<string, (calls: number) => Pick<ModelCheck, "run" | "faults" | "capture"> & { outcome: ProofOutcome }> = new Map();

export const modelCalls: Map<string, number> = new Map();

export const roots: string[] = [];

export function expectStaleReceipt(recorded: Receipt, check: "tests" | "proof", label: string, subject: string): void {
  // Output is not the source of staleness: presentation must use recorded facts.
  const receipt = { ...recorded,
      codeEvidence: { ...recorded.codeEvidence, tests: recorded.codeEvidence.tests.map((test) => ({ ...test, evidence: { ...test.evidence, output: "checked successfully" } })), proofs: recorded.codeEvidence.proofs.map((proof) => ({ ...proof, evidence: { ...proof.evidence, output: "1 verified, 0 errors" } })) }
};
  expect(receiptFindings(receipt)).toContainEqual(expect.objectContaining({ check, label, subject,
    detail: expect.stringContaining("stale") }));
  expect(receiptSummary(receipt).methods.find(({ method }) => method === (check === "tests" ? "Tested" : "Proved"))?.text)
    .toContain(`${subject} · stale`);
  for (const text of [renderReceipt(receipt), receiptMarkdown(receipt, { commit: "abc123", owner: "operator",
    sessionId: "stale-evidence", stale: [], changedAfter: [] })]) {
    expect(text).toContain("stale");
    expect(text).toContain("current content was not checked");
    expect(text).not.toMatch(/did not run|could not run/u);
    expect(text).toContain(`stale         ${subject}`);
  }
}

export function git(root: string, ...args: string[]): void {
  expect(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status).toBe(0);
}

export const contract = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

export function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
}

/** A new empty folder, removed after the test. */
export function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  return root;
}

/** A repository with these files committed, in `root` or a new folder. */
export function repository(files: Record<string, string>, root: string = folder()): string {
  write(root, files);
  git(root, "init", "-q");
  commit(root, "base");
  return root;
}

/** A repository with one committed contract file, `src/rule.ts`, and a committed plain file. */
export function project(root?: string): string {
  return repository({ "src/rule.ts": contract, "notes.md": "# Notes\n" }, root);
}

/**
 * A package whose `test` script runs Node's test runner, with a dependency
 * that only the checkout's ignored `node_modules` holds, as installed ones are.
 */
export function testedProject(test = "node --test", at?: string): string {
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
export function priceTest(input: number, expected: number, name = "total"): string {
  return "import assert from \"node:assert\";\nimport { test } from \"node:test\";\nimport { total } from \"../src/price.mjs\";\n" +
    `test(${JSON.stringify(name)}, () => { assert.equal(total(${input}), ${expected}); });\n`;
}

export interface Settled { entries?: { type?: string; customType: string; content: string; details?: unknown; data?: unknown }[]; continue?: boolean }

/** The gate's handlers on a fake Pi, run as Pi runs them in `root`; the open-case list is off unless `session` sets its flag. */
export function gate(root: string, active: string[] = ["read", "edit", "prove"], session: object = {}, recorded?: () => RecordedRequest): {
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

/** The one entry a settle appended. */
/** The receipt's facts as its message fences them, without the line naming its base: plain, so nothing in them is escaped. */
export function facts(content: string): string {
  const fence = /^(`{3,})text\n/mu.exec(content);
  if (fence === null) throw new Error(`no fenced details in ${content}`);
  const start = fence.index + fence[0].length;
  return content.slice(start, content.lastIndexOf("\nFrom ", content.indexOf(`\n${fence[1]}`, start)))
    // Disabled review is asserted through its v3 status; these comparisons protect the mechanical detail rows.
    .split("\n").filter((line) => line !== "  not listed    the cases the request leaves open: the operator disabled open cases"
      && line !== "  not listed    the cases the request leaves open: request review was not run").join("\n");
}

export function entry(settled: Settled | undefined): { customType: string; content: string; details?: unknown } {
  expect(settled?.entries).toHaveLength(1);
  const found = (settled?.entries ?? [])[0];
  return found === undefined ? { customType: "", content: "" } : { ...found, details: entryReceipt({ ...found, type: found.type ?? "custom_message" }) ?? (found.type === "custom" ? found.data : found.details) };
}

/** Incoming refs and dates are real Git state, independent of the gate. */
export function prepareIncoming(root: string, action: string): void {
  if (action === "remote") {
    git(root, "update-ref", "refs/remotes/elsewhere/topic", "HEAD");
    git(root, "checkout", "admission");
    git(root, "branch", "-D", "upstream");
  } else if (action === "url") {
    // A URL pull need not create a remote-tracking ref. Give the incoming commit an old committer date.
    expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--amend", "--no-edit"],
      { cwd: root, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } }).status).toBe(0);
    const source = folder();
    git(root, "clone", "--bare", root, source);
    git(root, "checkout", "admission");
    git(root, "branch", "-D", "upstream");
    git(root, "config", "test.source", source);
  } else if (action === "fetch") {
    // A remote not called origin, tracked at admission; its newer commit, made before the request, arrives by fetch.
    git(root, "checkout", "admission");
    git(root, "branch", "-D", "upstream");
    const other = folder();
    git(root, "clone", "-q", root, other);
    git(root, "remote", "add", "hub", other);
    git(root, "fetch", "-q", "hub");
    write(other, { "test/imported.test.mjs": priceTest(1, 1, "imported"), "src/imported.ts": contract });
    git(other, "add", "-A");
    expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "older upstream"],
      { cwd: other, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } }).status).toBe(0);
  } else if (action === "push") {
    git(root, "checkout", "admission");
    const mirror = folder();
    git(mirror, "init", "-q", "--bare");
    git(root, "remote", "add", "mirror", mirror);
  } else if (action === "pruned") {
    // A tag at admission whose commit is gone by the end: the starting refs cannot be read.
    const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const scratch = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", "scratch"],
      { cwd: root, encoding: "utf8" }).stdout.trim();
    git(root, "tag", "scratch", scratch);
    git(root, "checkout", "admission");
  } else git(root, "checkout", "admission");
}

export function moveHistory(root: string, action: string): void {
  if (action === "mixed") { write(root, { "local.txt": "during request\n" }); commit(root, "own work"); }
  if (action === "merge" || action === "mixed" || action === "remote" || action === "merge-deleted") git(root, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-edit",
    action === "remote" ? "refs/remotes/elsewhere/topic" : "upstream");
  // A branch that existed at admission still marks its commits imported after it is deleted.
  if (action === "merge-deleted") git(root, "branch", "-D", "upstream");
  if (action === "fetch") { git(root, "fetch", "-q", "hub"); git(root, "merge", "-q", "--ff-only", "hub/admission"); }
  if (action === "subagent") mergeSubagent(root);
  if (action === "url") {
    const source = spawnSync("git", ["config", "test.source"], { cwd: root, encoding: "utf8" }).stdout.trim();
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "pull", "--no-rebase", source, "upstream");
  }
  if (action === "switch") git(root, "switch", "upstream");
  if (action === "rebase") git(root, "-c", "user.name=t", "-c", "user.email=t@t", "rebase", "upstream");
  if (["commit", "unchanged", "amend", "push", "pruned", "tag"].includes(action)) localWork(root, action);
}

/** A writing subagent's worktree branch, created during the request and merged back. */
function mergeSubagent(root: string): void {
  const child = folder();
  git(root, "worktree", "add", "-q", "-b", "child", child);
  write(child, { "test/imported.test.mjs": priceTest(1, 1, "imported"), "src/imported.ts": contract });
  commit(child, "subagent expectations");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-edit", "child");
}

/** The request's own edits in the checkout, committed, pushed or amended as `action` names. */
function localWork(root: string, action: string): void {
  write(root, { "test/imported.test.mjs": priceTest(1, 1, "imported"), "src/imported.ts": contract });
  if (action === "commit" || action === "push" || action === "pruned" || action === "tag") commit(root, "local expectations");
  if (action === "push") git(root, "push", "-q", "mirror", "admission");
  if (action === "tag") git(root, "tag", "published");
  if (action === "pruned") { git(root, "tag", "-d", "scratch"); git(root, "reflog", "expire", "--expire=now", "--all"); git(root, "gc", "-q", "--prune=now"); }
  // Rewriting the admission commit makes new, timely, unshared commits; only its broken ancestry withholds credit.
  if (action === "amend") { git(root, "add", "-A"); git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "--no-edit"); }
}

/** The request's own history: pushing it or merging a branch the request created keeps credit. */
export const credited: Set<string> = new Set(["commit", "unchanged", "push", "subagent", "tag"]);

/** A tested package in a folder that is in no Git repository. */
export function plainProject(): string {
  const root = folder();
  write(root, { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }), "bun.lock": "",
    "src/price.mjs": "export const total = (n) => n;\n", "test/price.test.mjs": priceTest(1, 1) + priceTest(2, 2, "two").split("\n").at(-2) });
  return root;
}

/** A base whose own test already fails, a change that fixes it and adds a test for a module the base lacks. */
export async function newTestOverFailingBase(test: string): Promise<Settled | undefined> {
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

/** A tested project whose base already fails its `legacy` test, and a gate on it after the agent wrote `files`. */
export async function changeOverFailingBase(test: string, files: Record<string, string>): Promise<{ run: ReturnType<typeof gate>; settled: Settled | undefined }> {
  const root = testedProject(test);
  write(root, { "test/legacy.test.mjs": priceTest(-1, 0, "legacy") });
  commit(root, "a failing test");
  const run = gate(root);
  await run.input();
  await run.tool("write");
  write(root, files);
  return { run, settled: await run.settle() };
}

export const junit = "node --test --test-reporter=junit --test-reporter-destination=report.xml";

/** A folder that is no repository, holding `api`, a tested package, and `rules`, a contract, each its own repository, and plain files. */
export function workspace(): string {
  const root = folder();
  testedProject("node --test", join(root, "api"));
  project(join(root, "rules"));
  write(root, { "AGENTS.md": "# Rules\n", "notes/todo.md": "- one\n", ".hidden/x.md": "x\n", "node_modules/dep/x.js": "x\n" });
  return root;
}

/** A model of `src/counter.ts`, with its configuration and one planted fault, as a header declares them. */
export const counterModel = (name = "Counter"): Record<string, string> => ({
  [`models/${name}.tla`]: `(* tesota-model\n   covers: src/counter.ts\n   invariant: Safe\n   atomic: each step\n   omits: crashes\n` +
    `   fault: models/Fault.cfg lock removed\n*)\n---- MODULE ${name} ----\n====\n`,
  [`models/${name}.cfg`]: "SPECIFICATION Spec\n", "models/Fault.cfg": "SPECIFICATION Spec\n" });

/** What the gate published of its operations, as the status line and the timeline read them. */
export const shape = (run: ReturnType<typeof gate>): (string | undefined)[][] =>
  run.progress.operations.operations().filter(({ method }) => method !== "source_exercise").map(({ method, target, state, result }) => [method, target, state, result]);

export const lemmaScriptMock = async (original: <T>() => Promise<T>): Promise<typeof import("../src/verification/lemmascript-verifier.js")> => ({
  ...await original<typeof import("../src/verification/lemmascript-verifier.js")>(),
  proveFile: (root: string, path: string): Promise<Evidence> => {
    const { outcome, output } = scripted.get(path) ?? { outcome: "passed", output: "1 verified, 0 errors" };
    if (output === "throws") return Promise.reject(new Error("the prover broke"));
    const files = [path, path.replace(/\.ts$/u, ".dfy")];
    if (state.regenerates) for (const proof of [files[1], `${files[1]}.gen`]) writeFileSync(join(root, proof ?? ""), `// generated from ${path}\n`);
    return Promise.resolve({ verifier: "lemmascript", claim: `claim of ${path}`, limits: "", outcome, output, durationMs: 1,
      files, contentHash: contentHash(files.map((path) => ({ path,
        content: existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined }))) });
  },
  // Every mutant ends as scripted, failing its proof unless a test says otherwise, so strength is measured without Dafny;
  // a survivor's equivalence proof (`equivalenceSource`) always fails, so it stays a survivor.
  proveSource: (_name: string, source: string) => Promise.resolve(/Mutant\d*\(/u.test(source) ? "failed" : state.mutantOutcome),
});

export const modelCheckMock = async (original: <T>() => Promise<T>): Promise<typeof import("../src/model-check.js")> => {
  const real = await original<typeof import("../src/model-check.js")>();
  return { ...real, checkModel: async (root: string, path: string, changed: readonly string[]): Promise<ModelCheck> => {
    const calls = (modelCalls.get(path) ?? 0) + 1;
    modelCalls.set(path, calls);
    const { outcome, run, faults, ...metadata } = scriptedModels.get(path)?.(calls)
      ?? { outcome: "passed", run: "passed", faults: [{ path: "models/Fault.cfg", description: "lock removed", verdict: "caught", output: "", durationMs: 1 }] };
    const header = { covers: [{ path: "src/counter.ts", names: [] }], invariants: ["Safe"], atomic: ["each step"], omits: ["crashes"],
      faults: [{ path: "models/Fault.cfg", description: "lock removed" }] };
    // Bound to the content as the real check binds it, so the gate can tell a check of the same content.
    const content = await real.modelContent(root, path, header);
    return { ...metadata, path, language: "tla", header, problems: [], evidence: { verifier: "tlc", claim: `claim of ${path}`, limits: "", outcome,
      output: "", durationMs: 1, files: content.map((file) => file.path), contentHash: contentHash(content) }, run, states: 9, faults,
    staleness: "possibly_stale", stale: ["src/counter.ts"], writtenWithCode: changed.includes(path) && changed.includes("src/counter.ts"),
    link: "no_replay" };
  } };
};

// Imported before each test, not at the top: the gate loads the mocked modules, whose factories import this file,
// which would still be loading and give them no mocks.
let registerGate: typeof import("../src/gate.js")["registerGate"];

export function useGateHarness(): void {
  beforeEach(async () => {
    registerGate = (await import("../src/gate.js")).registerGate;
    scripted.clear(); scriptedModels.clear(); modelCalls.clear(); state.mutantOutcome = "failed"; state.regenerates = false;
    state.verificationModels = {};
    provideHost({ ...host(), verificationModels: () => state.verificationModels });
  });
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
}
