import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../../src/evidence.ts";
import type { ProofOutcome } from "../../../src/verification/proof-outcome-rule.ts";
import type { ExtensionFactory } from "../../../src/contract.ts";
import { provideHost } from "../../../src/host.ts";
import { createSession, type EngineSession, type SessionOptions } from "../src/session.ts";
import { shellHost } from "../src/shell/surface.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply } from "./scripted.ts";

/** The proofs the gate runs, scripted per file in order: the gate's decisions on the engine are under test, not LemmaScript. */
const proofs = new Map<string, ProofOutcome[]>();
const lemmascript = { ...await import("../../../src/verification/lemmascript-verifier.ts") };
mock.module("../../../src/verification/lemmascript-verifier.ts", () => ({
  ...lemmascript,
  proveFile: (_root: string, path: string): Promise<Evidence> => {
    const outcome = proofs.get(path)?.shift() ?? "passed";
    return Promise.resolve({ verifier: "lemmascript", claim: `claim of ${path}`, limits: "", outcome,
      output: outcome === "passed" ? "1 verified, 0 errors" : "1 verified, 1 error: postcondition", durationMs: 1,
      files: [path, path.replace(/\.ts$/u, ".dfy")], contentHash: `hash of ${path}` });
  },
  // Every mutant fails its proof, so contracts measure strong without Dafny.
  proveSource: () => Promise.resolve("failed" satisfies ProofOutcome),
}));
const { registerGate } = await import("../../../src/gate.ts");
// The gate runs here as the engine's shell runs it, with the shell's editor, key names, version and shell (#446).
provideHost(shellHost());
const { entryReceipt, isReceipt } = await import("../../../src/receipt.ts");
type Receipt = import("../../../src/receipt.ts").Receipt;

/**
 * Tesota's gate on `@tesota/core` (#439): the session's verifier, reading
 * the request from the ledger. What the gate decides is tested through Pi's
 * fake host in the root tests; these check that the engine carries those
 * decisions: send-backs, receipts in both forms, runs that end early, and
 * an extension that tries to silence it.
 */
const open: EngineSession[] = [];
beforeEach(() => { proofs.clear(); });
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const contract = "//@ ensures \\result >= 0\nexport function f(): number { return 0; }\n";

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

/** A repository with a committed contract file, `src/rule.ts`. */
function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-gate-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "rule.ts"), contract);
  git(cwd, "init", "-q");
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return cwd;
}

/** A session in `cwd` whose verifier is the gate, with the model asked by name turned off. */
function gated(cwd: string, script: readonly ScriptStep[], options: Partial<SessionOptions> & { slow?: boolean } = {}): EngineSession {
  const faux = fauxProvider(options.slow === true ? { tokensPerSecond: 20 } : {});
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-core-sessions-")), models, model: faux.getModel(),
    // The gate is typed against Pi's API until slice 5 runs Tesota's extension unchanged; it uses only what the engine hosts.
    flags: { "open-cases-model": "off" }, verifier: (pi, request) => { registerGate(pi as never, request); }, ...options });
  open.push(session);
  return session;
}

const entriesOf = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").slice(1)
  .map((line) => JSON.parse(line) as { type: string; customType?: string; details?: unknown; data?: unknown });

/** The receipt the run settled with, from the session's file. */
function receiptOf(session: EngineSession): Receipt | undefined {
  const found = entriesOf(session.file).map(entryReceipt).findLast((receipt) => receipt !== undefined);
  return isReceipt(found) ? found as Receipt : undefined;
}

const edit = (content: string): ScriptStep => ({ tool: "write", args: { path: "src/rule.ts", content } });
const changed = `${contract}// changed\n`;

describe("the gate on @tesota/core", () => {
  test("a failing proof goes back to the agent, which fixes it, and the run completes with the receipt", async () => {
    proofs.set("src/rule.ts", ["failed", "passed"]);
    const session = gated(repository(), [edit(changed), "done", edit(`${changed}// fixed\n`), "fixed", "no restatement"]);
    await session.prompt("change f");
    expect(session.messages().map((message) => message.customType ?? message.role)).toEqual(
      ["user", "assistant", "toolResult", "assistant", "tesota-gate", "assistant", "toolResult", "assistant"]);
    expect(session.outcome()).toBe("completed");
    expect(receiptOf(session)?.proofs).toMatchObject([{ path: "src/rule.ts", verdict: "proved" }]);
  });

  test("a failure the agent repeats is reported, not sent back again, and the run completes with it in the receipt", async () => {
    proofs.set("src/rule.ts", ["failed", "failed"]);
    const session = gated(repository(), [edit(changed), "done", "still done"]);
    await session.prompt("change f");
    expect(session.messages().filter((message) => message.customType === "tesota-gate")).toHaveLength(1);
    expect(session.outcome()).toBe("completed");
    expect(receiptOf(session)?.proofs).toMatchObject([{ path: "src/rule.ts", verdict: "no_progress" }]);
  });

  test("with no shell the receipt stays outside the conversation, and in the shell's mode it is a message in it", async () => {
    const write: ScriptStep = { tool: "write", args: { path: "notes.md", content: "# Notes\n" } };
    const headless = gated(repository(), [write, "done"]);
    await headless.prompt("add notes");
    expect(headless.messages().some((message) => message.customType === "tesota-receipt")).toBe(false);
    expect(entriesOf(headless.file)).toContainEqual(expect.objectContaining({ type: "custom", customType: "tesota-receipt" }));
    expect(headless.lastAssistantText()).toBe("done");
    expect(headless.outcome()).toBe("completed");
    const shown = gated(repository(), [write, "done"], { mode: "tui" });
    await shown.prompt("add notes");
    expect(shown.messages().at(-1)?.customType).toBe("tesota-receipt");
  });

  test("an extension that ends settlement and drops every entry cannot silence it", async () => {
    proofs.set("src/rule.ts", ["failed", "passed"]);
    const silencer: ExtensionFactory = (pi) => { pi.on("agent_before_settle", () => ({ entries: [], continue: false })); };
    const session = gated(repository(), [edit(changed), "done", edit(`${changed}// fixed\n`), "fixed", "no restatement"],
      { extensions: [silencer] });
    await session.prompt("change f");
    expect(session.messages().some((message) => message.customType === "tesota-gate")).toBe(true);
    expect(receiptOf(session)?.proofs).toMatchObject([{ verdict: "proved" }]);
  });

  test("it measures from the base the ledger recorded before any tool ran", async () => {
    const cwd = repository();
    const session = gated(cwd, [{ tool: "write", args: { path: "notes.md", content: "# Notes\n" } }, "done"]);
    await session.prompt("add notes");
    const [request] = session.ledger();
    expect(receiptOf(session)).toMatchObject({ base: git(cwd, "rev-parse", "HEAD"), startedAt: request?.at });
    expect(request?.base.units).toEqual([{ folder: "", kind: "commit", commit: git(cwd, "rev-parse", "HEAD") }]);
  });
});

describe("a run that ends before the gate verifies it", () => {
  test("a provider error after a write settles with a receipt that says nothing was verified, and why", async () => {
    const session = gated(repository(), [edit(changed), { error: "quota exhausted" }]);
    await session.prompt("change f");
    expect(session.outcome()).toBe("error");
    expect(receiptOf(session)).toMatchObject({ stopped: "quota exhausted", proofs: [] });
  });

  test("the operator's stop after a write does the same", async () => {
    const session = gated(repository(), [edit(changed), "a long answer that streams slowly enough to be stopped part of the way"],
      { slow: true });
    const run = session.prompt("change f");
    while (!session.messages().some((message) => message.role === "toolResult")) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.abort();
    await run;
    expect(session.outcome()).toBe("aborted");
    expect(receiptOf(session)).toMatchObject({ stopped: "the operator stopped the run" });
  });

  test("a run that changed nothing settles with no receipt", async () => {
    const session = gated(repository(), [{ error: "quota exhausted" }]);
    await session.prompt("change f");
    expect(session.outcome()).toBe("error");
    expect(receiptOf(session)).toBeUndefined();
  });
});
