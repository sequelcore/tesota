import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../../src/evidence.ts";
import type { ProofOutcome } from "../../../src/verification/proof-outcome-rule.ts";
import type { ExtensionFactory } from "../../../src/contract.ts";
import { provideHost } from "../../../src/host.ts";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";
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

/** What opening a session needs when nothing will run in it. */
function scriptless() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), verifier: () => undefined };
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

  test("two sessions in one checkout work in their own trees at once, and each receipt shows only its own change (#453)", async () => {
    const cwd = repository();
    const first = gated(cwd, [{ tool: "write", args: { path: "first.md", content: "# First\n" } }, "done"], { slow: true });
    const second = gated(cwd, [{ tool: "write", args: { path: "second.md", content: "# Second\n" } }, "done"], { slow: true });
    // The first holds the checkout; the second works in a worktree of it on its own branch.
    // Sessions name folders by their real names; a Windows runner's temporary folder may come by its short one.
    const real = realpathSync.native(cwd);
    expect(first.workspace).toEqual({ cwd: real, checkout: real });
    expect(second.workspace.branch).toStartWith("tesota/");
    expect(second.workspace.cwd).not.toBe(cwd);
    await Promise.all([first.prompt("add the first note"), second.prompt("add the second note")]);
    expect(receiptOf(first)?.changed).toMatchObject([{ path: "first.md" }]);
    expect(receiptOf(second)?.changed).toMatchObject([{ path: "second.md" }]);
    expect(existsSync(join(cwd, "second.md"))).toBe(false);
    // Its work stays when it closes, and Tesota says where; the checkout's own is untouched.
    const worktree = second.workspace.worktree;
    open.splice(open.indexOf(second), 1);
    await second.dispose();
    expect(second.kept()).toBe(`The session's work is in ${worktree}, on branch ${second.workspace.branch}.`);
    expect(existsSync(join(worktree ?? "", "second.md"))).toBe(true);
  });

  test("a session in a worktree that changed nothing leaves no worktree or branch behind (#453)", async () => {
    const cwd = repository();
    gated(cwd, []);
    const idle = gated(cwd, []);
    const { worktree, branch } = idle.workspace;
    open.splice(open.indexOf(idle), 1);
    await idle.dispose();
    expect(idle.kept()).toBeUndefined();
    expect(existsSync(worktree ?? "")).toBe(false);
    expect(git(cwd, "branch", "--list", branch ?? "")).toBe("");
  });

  test("a resumed session works in its own workspace again, its worktree made again when it was removed (#453)", async () => {
    const cwd = repository();
    const holder = gated(cwd, []);
    const idle = gated(cwd, []);
    const { worktree, branch, cwd: inside } = idle.workspace;
    open.splice(open.indexOf(idle), 1);
    await idle.dispose();
    expect(existsSync(worktree ?? "")).toBe(false);
    const resumed = openSession(idle.file, scriptless());
    open.push(resumed);
    expect(resumed.workspace).toMatchObject({ cwd: inside, branch });
    expect(existsSync(worktree ?? "")).toBe(true);
    // The checkout is held, so the session that worked in it waits for it.
    const file = holder.file;
    open.splice(open.indexOf(holder), 1);
    await holder.dispose();
    const taker = gated(cwd, []);
    expect(taker.workspace.cwd).toBe(realpathSync.native(cwd));
    expect(() => openSession(file, scriptless())).toThrow("Another session is working in");
  });

  /** A second session in `cwd` while a first holds it, disposed by the test itself. */
  const worktreeSession = (cwd: string, at: string = cwd): EngineSession => {
    const session = gated(at, []);
    open.splice(open.indexOf(session), 1);
    return session;
  };

  test("a worktree whose branch holds a commit, or a file Git is told not to list, is kept (#453)", async () => {
    const cwd = repository();
    gated(cwd, []);
    const committed = worktreeSession(cwd);
    const { worktree = "", branch = "" } = committed.workspace;
    const base = git(worktree, "rev-parse", "HEAD");
    writeFileSync(join(worktree, "work.md"), "# Work\n");
    git(worktree, "add", "-A");
    git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "work");
    // HEAD back at the start, the branch still ahead: the commit is the session's work.
    git(worktree, "checkout", "-q", "--detach", base);
    await committed.dispose();
    expect(committed.kept()).toContain(branch);
    expect(git(cwd, "branch", "--list", branch)).toContain(branch);
    git(cwd, "config", "status.showUntrackedFiles", "no");
    const untracked = worktreeSession(cwd);
    writeFileSync(join(untracked.workspace.worktree ?? "", "draft.md"), "# Draft\n");
    await untracked.dispose();
    expect(untracked.kept()).toBeDefined();
    expect(existsSync(join(untracked.workspace.worktree ?? "", "draft.md"))).toBe(true);
  });

  test("another name for the checkout, or a session's worktree, is not a free checkout (#453)", async () => {
    const cwd = repository();
    const alias = join(mkdtempSync(join(tmpdir(), "tesota-core-alias-")), "same");
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    gated(cwd, []);
    const throughAlias = worktreeSession(cwd, alias);
    expect(throughAlias.workspace.worktree).toBeDefined();
    // A session opened inside that worktree gets its own, not a share of it.
    const inside = worktreeSession(throughAlias.workspace.worktree ?? "");
    expect(inside.workspace.worktree).toBeDefined();
    expect(inside.workspace.worktree).not.toBe(throughAlias.workspace.worktree);
    await inside.dispose();
    await throughAlias.dispose();
  });

  test.if(process.platform === "win32")("a checkout reached by its Windows short name is the same checkout (#453)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tesota-core-short-"));
    const cwd = join(parent, "a-folder-name-longer-than-eight");
    mkdirSync(cwd);
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "a.md"), "a\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    // From `cmd`, as `lemmascript-verifier.test.ts` takes it: PowerShell's COM call gave no name now and then (#493).
    const named = spawnSync("cmd", ["/d", "/c", `for %I in ("${cwd}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true });
    const short = named.stdout.trim();
    if (short === "") throw new Error(`cmd gave no short name (status ${named.status}): ${named.stderr}`);
    expect(short).not.toBe(cwd);
    expect(existsSync(short)).toBe(true);
    gated(cwd, []);
    const second = gated(short, [{ tool: "write", args: { path: "b.md", content: "b\n" } }, "done"]);
    // The same checkout by another name: the second session gets a worktree, and works at its top, not beside it.
    expect(second.workspace.worktree).toBeDefined();
    expect(second.workspace.cwd).toBe(second.workspace.worktree ?? "");
    await second.prompt("add b");
    expect(receiptOf(second)?.changed).toMatchObject([{ path: "b.md" }]);
  });

  test("a session opened in a folder not yet committed works in that folder of its worktree (#453)", async () => {
    const cwd = repository();
    mkdirSync(join(cwd, "fresh"));
    gated(cwd, []);
    const session = worktreeSession(cwd, join(cwd, "fresh"));
    expect(existsSync(session.workspace.cwd)).toBe(true);
    expect(session.workspace.cwd).toBe(join(session.workspace.worktree ?? "", "fresh"));
    await session.dispose();
  });

  test("a hook that fails as the worktree is made leaves no worktree or branch behind (#453)", () => {
    const cwd = repository();
    writeFileSync(join(cwd, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    gated(cwd, []);
    expect(() => gated(cwd, [])).toThrow("Could not make a worktree for the session");
    expect(git(cwd, "branch", "--list", "tesota/*")).toBe("");
    expect(git(cwd, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a worktree deleted by hand is made again when its session resumes (#453)", async () => {
    const cwd = repository();
    gated(cwd, []);
    const kept = worktreeSession(cwd);
    const { worktree = "" } = kept.workspace;
    writeFileSync(join(worktree, "work.md"), "# Work\n");
    await kept.dispose();
    rmSync(worktree, { recursive: true, force: true });
    const resumed = openSession(kept.file, scriptless());
    open.push(resumed);
    expect(existsSync(worktree)).toBe(true);
  });

  test("outside Git a second session at once is refused, saying why (#453)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tesota-core-plain-"));
    gated(cwd, []);
    expect(() => gated(cwd, [])).toThrow("is not a Git repository with a commit");
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

  test("the operator's stop while a check runs ends the check and what it started, and the receipt verified nothing (#408)", async () => {
    const cwd = repository();
    const ready = join(cwd, "ready.txt");
    // The project's check starts a process of its own, as a test runner does, then records both and waits.
    writeFileSync(join(cwd, "long.cjs"), "const child = require(\"node:child_process\").spawn(process.execPath, " +
      "[\"-e\", \"setTimeout(() => {}, 60000)\"], { stdio: \"ignore\" });\n" +
      `require("node:fs").writeFileSync(${JSON.stringify(ready)}, process.pid + " " + child.pid);\nsetTimeout(() => {}, 60000);\n`);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "long-check", scripts: { test: "node long.cjs" } }));
    writeFileSync(join(cwd, ".gitignore"), "ready.txt\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a long check");
    const session = gated(cwd, [{ tool: "write", args: { path: "notes.md", content: "# Notes\n" } }, "done"]);
    const run = session.prompt("add notes");
    while (!existsSync(ready) || !readFileSync(ready, "utf8").includes(" ")) await new Promise((resolve) => setTimeout(resolve, 20));
    const started = readFileSync(ready, "utf8").split(" ").map(Number);
    await session.abort();
    await run;
    expect(session.outcome()).toBe("aborted");
    expect(receiptOf(session)).toMatchObject({ stopped: "the operator stopped the run while Tesota verified it", tests: [] });
    // Stopped processes are gone within moments, not the minute they wait: Linux reaps a killed orphan on its own time.
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let waited = 0; waited < 10_000 && started.some(alive); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started.filter(alive)).toEqual([]);
  }, 60_000);

  test("a run that changed nothing settles with no receipt", async () => {
    const session = gated(repository(), [{ error: "quota exhausted" }]);
    await session.prompt("change f");
    expect(session.outcome()).toBe("error");
    expect(receiptOf(session)).toBeUndefined();
  });
});
