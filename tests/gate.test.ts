import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Evidence } from "../src/evidence.js";
import { changedFiles, registerGate } from "../src/gate.js";
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
function gate(root: string): { input: (source?: string) => void; agentStart: () => void; settle: (outcome?: string) => Promise<Settled | undefined> } {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  registerGate({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); } } as never);
  const ctx = { cwd: root, signal: undefined };
  return {
    input: (source = "interactive") => { handlers.get("input")?.({ type: "input", text: "fix it", source }, ctx); },
    agentStart: () => { handlers.get("agent_start")?.({ type: "agent_start" }, ctx); },
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
  expect(gateVerdict("passed", false)).toBe("proved");
  expect(gateVerdict("failed", false)).toBe("send_back");
  expect(gateVerdict("vacuous", false)).toBe("send_back");
  expect(gateVerdict("failed", true)).toBe("no_progress");
  expect(gateVerdict("not_started", false)).toBe("operator");
  expect(gateVerdict("timed_out", false)).toBe("operator");
  expect(keepsWorking(["proved", "operator", "no_progress"])).toBe(false);
  expect(keepsWorking(["proved", "send_back"])).toBe(true);
});

it("lists changed and untracked files, relative to the project, and nothing outside Git", async () => {
  const root = project();
  expect(await changedFiles(root)).toEqual([]);
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  writeFileSync(join(root, "src", "new.ts"), "export const a = 1;\n");
  rmSync(join(root, "notes.md"));
  expect(await changedFiles(root)).toEqual(["src/new.ts", "src/rule.ts"]);
  expect(await changedFiles(join(root, "src"))).toEqual(["new.ts", "rule.ts"]);
  const outside = mkdtempSync(join(tmpdir(), "tesota-gate-"));
  roots.push(outside);
  expect(await changedFiles(outside)).toBeUndefined();
});

it("keeps the agent working while a changed contract fails, and settles with a receipt once it proves", async () => {
  const root = project();
  const run = gate(root);
  run.input();
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

it("stops on a failure repeated after a correction, and forgets failures on the operator's input, not on agent_start", async () => {
  const root = project();
  const run = gate(root);
  run.input();
  writeFileSync(join(root, "src", "rule.ts"), `${contract}// changed\n`);
  scripted.set("src/rule.ts", { outcome: "failed", output: "1 verified, 1 error" });
  expect((await run.settle())?.continue).toBe(true);
  run.agentStart();
  const stuck = await run.settle();
  expect(stuck?.continue).toBeUndefined();
  expect(entry(stuck).content).toContain("NOT proved    src/rule.ts: an obligation fails, the same after a correction");
  expect((entry(stuck).details as Receipt).proofs.map(({ verdict }) => verdict)).toEqual(["no_progress"]);
  run.input("extension");
  expect((await run.settle())?.continue).toBeUndefined();
  run.input();
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

it("proves a contract file whose .dfy alone changed, and leaves runs that did not complete alone", async () => {
  const root = project();
  const run = gate(root);
  writeFileSync(join(root, "src", "rule.dfy"), "// hand-written proof line\n");
  scripted.set("src/rule.ts", { outcome: "failed", output: "assume false" });
  expect(await run.settle("aborted")).toBeUndefined();
  expect(entry(await run.settle()).content).toContain("Tesota: src/rule.ts does not prove yet.");
});
