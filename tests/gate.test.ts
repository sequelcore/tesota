import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Evidence } from "../src/evidence.js";
import { changedFiles, headCommit, registerGate } from "../src/gate.js";
import type { Receipt } from "../src/receipt.js";
import { gateVerdict, keepsWorking } from "../src/verification/gate-rule.js";
import type { ProofOutcome } from "../src/verification/proof-outcome-rule.js";

/** The proofs the gate runs, scripted per file: the gate's decisions, not LemmaScript, are under test here. */
const scripted = new Map<string, { outcome: ProofOutcome; output: string }>();
vi.mock("../src/verification/lemmascript-verifier.js", async (original) => ({
  ...await original<typeof import("../src/verification/lemmascript-verifier.js")>(),
  proveFile: (_root: string, path: string): Promise<Evidence> => {
    const { outcome, output } = scripted.get(path) ?? { outcome: "passed", output: "1 verified, 0 errors" };
    return Promise.resolve({ verifier: "lemmascript", claim: `claim of ${path}`, limits: "", outcome, output, durationMs: 1,
      files: [path, path.replace(/\.ts$/u, ".dfy")], contentHash: `hash of ${path}` });
  },
}));

const roots: string[] = [];
beforeEach(() => { scripted.clear(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): void {
  expect(spawnSync("git", args, { cwd: root, encoding: "utf8" }).status).toBe(0);
}

const contract = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

/** A repository with one committed contract file, `src/rule.ts`, and a committed plain file. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "rule.ts"), contract);
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return root;
}

interface Settled { entries?: { customType: string; content: string; details?: unknown }[]; continue?: boolean }

/** The gate's handlers on a fake Pi, run as Pi runs them in `root`. */
function gate(root: string, active = ["read", "edit", "prove"]): {
  input: (source?: string, streamingBehavior?: string) => Promise<void>; agentStart: () => void; tool: (name: string) => void;
  settle: (outcome?: string) => Promise<Settled | undefined>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  registerGate({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    getActiveTools: () => active } as never);
  const ctx = { cwd: root, signal: undefined };
  return {
    input: async (source = "interactive", streamingBehavior) => {
      await handlers.get("input")?.({ type: "input", text: "fix it", source, streamingBehavior }, ctx);
    },
    agentStart: () => { handlers.get("agent_start")?.({ type: "agent_start" }, ctx); },
    tool: (toolName) => { handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolName }, ctx); },
    settle: async (outcome = "completed") =>
      await handlers.get("agent_before_settle")?.({ type: "agent_before_settle", outcome }, ctx) as Settled | undefined,
  };
}

/** The one entry a settle appended. */
function entry(settled: Settled | undefined): { customType: string; content: string; details?: unknown } {
  expect(settled?.entries).toHaveLength(1);
  return (settled?.entries ?? [])[0] ?? { customType: "", content: "" };
}

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
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  writeFileSync(join(root, "src", "rule.dfy.gen"), "// regenerated\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = await run.settle();
  expect(failed?.continue).toBe(true);
  expect(entry(failed).customType).toBe("tesota-gate");
  expect(entry(failed).content).toContain("Tesota: src/rule.ts does not prove yet.");
  expect(entry(failed).content).toContain("This is not finished yet.");
  expect(entry(failed).content).toContain("and run prove again.");
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect((await run.settle())?.continue).toBe(true);
  scripted.delete("src/rule.ts");
  const proved = await run.settle();
  expect(proved?.continue).toBeUndefined();
  expect(entry(proved).customType).toBe("tesota-receipt");
  expect(entry(proved).content).toBe(["Tesota receipt", "  proved        src/rule.ts",
    "                content sha256 hash of src/rule.ts", "  not verified  notes.md: no verifier covers it"].join("\n"));
  const receipt = entry(proved).details as Receipt;
  expect(receipt.proofs.map(({ path, verdict, evidence }) => [path, verdict, evidence.contentHash]))
    .toEqual([["src/rule.ts", "proved", "hash of src/rule.ts"]]);
});

it("stops on any failure already sent back, alternating ones included, and forgets them on the operator's input only", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
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
    "NOT proved    src/rule.ts: an obligation fails, repeating a failure already sent back");
  expect((entry(stuck).details as Receipt).proofs.map(({ verdict }) => verdict)).toEqual(["no_progress"]);
  await run.input("extension");
  expect((await run.settle())?.continue).toBeUndefined();
  await run.input();
  expect((await run.settle())?.continue).toBe(true);
});

it("reports a proof that could not run to the operator instead of sending it back", async () => {
  const root = project();
  const run = gate(root);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "not_started", output: "Dafny is not installed, so nothing was proved." });
  const settled = await run.settle();
  expect(settled?.continue).toBeUndefined();
  expect(entry(settled).content).toContain(
    "NOT proved    src/rule.ts: the proof could not run: Dafny is not installed, so nothing was proved.");
});

it("tells the agent to finish its turn instead of running prove when prove is not active", async () => {
  const root = project();
  const run = gate(root, ["read", "edit"]);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  const failed = entry(await run.settle()).content;
  expect(failed).toContain("and finish your turn, and Tesota will prove the file again.");
  expect(failed).not.toContain("prove again");
  scripted.set("src/rule.ts", { outcome: "vacuous", output: "0 verified, 0 errors" });
  expect(entry(await run.settle()).content).toContain("Fix that and finish your turn, and Tesota will prove the file again.");
});

it("tells the operator outside Git that changes could not be verified, once a tool may have changed files", async () => {
  const outside = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(outside);
  const run = gate(outside);
  await run.input();
  run.tool("read");
  expect(await run.settle()).toBeUndefined();
  run.tool("edit");
  const settled = entry(await run.settle());
  expect(settled.customType).toBe("tesota-receipt");
  expect(settled.content).toBe("Tesota receipt\n  not verified  this request's changes: the project has no Git " +
    "repository, so Tesota cannot tell which files changed");
  expect((settled.details as Receipt).repository).toBe(false);
  await run.input();
  expect(await run.settle()).toBeUndefined();
});

it("proves a contract file whose .dfy alone changed, and leaves runs that did not complete alone", async () => {
  const root = project();
  const run = gate(root);
  writeFileSync(join(root, "src", "rule.dfy"), "// hand-written proof line\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  expect(await run.settle("aborted")).toBeUndefined();
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
}

it("measures from the commit the request started at, so an agent's commit hides nothing", async () => {
  const root = project();
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "notes.md"), "# Notes, changed\n");
  commit(root, "agent");
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  await run.input("interactive", "steer");
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
  scripted.delete("src/rule.ts");
  const receipt = entry(await run.settle()).details as Receipt;
  expect(receipt.proofs.map(({ path }) => path)).toEqual(["src/rule.ts"]);
  expect(receipt.unverified).toEqual(["notes.md"]);
  await run.input();
  expect(await run.settle()).toBeUndefined();
});

it("lists every file in a repository whose first commit the agent made", async () => {
  const root = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(root);
  git(root, "init", "-q");
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  commit(root, "agent");
  expect((entry(await run.settle()).details as Receipt).unverified).toEqual(["notes.md"]);
});

it("puts each change that may weaken the evidence in the receipt, committed or not", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  const rule = ["//@ requires x >= 0", "//@ ensures \\result >= 0", "//@ ensures \\result >= x",
    "export function f(x: number): number { return x; }", ""];
  writeFileSync(join(root, "src", "rule.ts"), rule.join("\n"));
  writeFileSync(join(root, "tests", "rule.test.ts"), "it('f', () => {});\n");
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  writeFileSync(join(root, "src", "rule.ts"), ["//@ requires x >= 1", "//@ ensures   \\result >= x", "//@ assume x < 10",
    "export function f(x: number): number { return x; }", ""].join("\n"));
  rmSync(join(root, "tests", "old.test.ts"));
  commit(root, "agent");
  writeFileSync(join(root, "tests", "rule.test.ts"), "it.skip('f', () => {});\n");
  writeFileSync(join(root, "src", "new.ts"), "//@ assume false\nexport const a = 1;\n");
  writeFileSync(join(root, "tests", "new.test.ts"), "it('new', () => {});\n");
  const settled = entry(await run.settle());
  expect(settled.content.split("\n").filter((line) => line.startsWith("  may weaken"))).toEqual([
    "  may weaken    src/new.ts: adds //@ assume false",
    "  may weaken    src/rule.ts: removes or changes //@ requires x >= 0",
    "  may weaken    src/rule.ts: removes or changes //@ ensures \\result >= 0",
    "  may weaken    src/rule.ts: adds //@ assume x < 10",
    "  may weaken    tests/old.test.ts: deletes a test file",
    "  may weaken    tests/rule.test.ts: edits a test file",
  ]);
  expect((settled.details as Receipt).weakened).toContainEqual(
    { path: "tests/old.test.ts", kind: "deleted_test" });
});

it("settles with a receipt when the only change deletes a test", async () => {
  const root = project();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "old.test.ts"), "it('old', () => {});\n");
  commit(root, "tests");
  const run = gate(root);
  await run.input();
  rmSync(join(root, "tests", "old.test.ts"));
  expect(entry(await run.settle()).content).toBe("Tesota receipt\n  may weaken    tests/old.test.ts: deletes a test file");
});
