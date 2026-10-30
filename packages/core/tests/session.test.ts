import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { Session } from "../../../src/contract.ts";
import { createSession, type EngineSession, openSession, recovery, type SessionOptions } from "../src/session.ts";
import { entryReceipt } from "../../../src/receipt.ts";
import { toolMayChangeFiles } from "../../../src/verification/gate-rule.ts";
import { captureBase } from "../src/base.ts";
import { readSessionFile, SessionFileError, type SessionEntry } from "../src/session-file.ts";
import { SessionLockedError } from "../src/session-lock.ts";
import type { EngineTool } from "../src/tool.ts";
import { tesotaEngine } from "./adapters/tesota.ts";
import type { ScriptStep } from "./engine.ts";
import { accepts, scriptedReply } from "./scripted.ts";
import { outputPrefix, platformShell } from "../src/tools/shell.ts";
import { maxBytes } from "../src/truncate.ts";

/**
 * Sessions and the request ledger (#437): resuming, on both engines; then
 * what only `@tesota/core` promises: the ledger written before any tool
 * runs, recovery after the process was killed, one writer, and a file that
 * opens whole or not at all.
 */
const open: Session[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const folder = (prefix = "tesota-core-session-"): string => mkdtempSync(join(tmpdir(), prefix));

/**
 * Polls until the child has written `file.txt` in `sessions` and the session file it names holds `text`, and returns that file's path.
 * Either file may be missing or partly written meanwhile (a race on Windows, #659), so a failed read polls again; only `limitMs` fails it.
 */
async function sessionFileWith(sessions: string, text: string, limitMs = 15_000): Promise<string> {
  const pathFile = join(sessions, "file.txt");
  const deadline = Date.now() + limitMs;
  for (;;) {
    try {
      const path = readFileSync(pathFile, "utf8");
      // Only whole lines count: a line still being written may hold `text` and be discarded by recovery.
      if (readFileSync(path, "utf8").split("\n").slice(0, -1).some((line) => line.includes(text))) return path;
    } catch { /* not there yet, or partly written */ }
    if (Date.now() > deadline) throw new Error(`Waited ${limitMs} ms for ${pathFile} to name a session file containing ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const engine of [tesotaEngine]) {
  describe(engine.name, () => {
    test("a resumed session has its conversation and usage, and goes on from them", async () => {
      const cwd = folder();
      const first = await engine.createSession({ cwd, extensions: [], script: [{ tool: "write", args: { path: "a.txt", content: "a" } }, "written"] });
      await first.prompt("write a");
      const usage = first.stats().tokens.total;
      const resumed = await engine.resume(first, { cwd, extensions: [], script: ["again"] });
      open.push(resumed);
      expect(resumed.messages().map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
      expect(resumed.lastAssistantText()).toBe("written");
      expect(resumed.stats().tokens.total).toBe(usage);
      await resumed.prompt("once more");
      expect(resumed.messages().map((message) => message.text).slice(-2)).toEqual(["once more", "again"]);
    });
  });
}

/** Pi's scripted model playing `script`. */
function scripted(script: readonly ScriptStep[], slow = false): Pick<SessionOptions, "models" | "model" | "verifier"> {
  const faux = fauxProvider(slow ? { tokensPerSecond: 20 } : {});
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), verifier: accepts };
}

/** A session of the engine, in a new folder unless `cwd` is given, with its file in a folder of its own outside it. */
function session(script: readonly ScriptStep[], options: Partial<SessionOptions> & { slow?: boolean } = {}): EngineSession {
  const cwd = options.cwd ?? folder();
  const created = createSession({ cwd, folder: folder("tesota-core-sessions-"), ...scripted(script, options.slow), ...options });
  open.push(created);
  return created;
}

const entriesOf = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").slice(1).map((line) => JSON.parse(line) as { type: string });

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
};

describe("the request ledger", () => {
  test("the request, its origin and its base are on disk before the first tool runs", async () => {
    let seen = "";
    const probe: EngineTool = {
      name: "probe", description: "Reads the session file.", parameters: Type.Object({}),
      execute: () => { seen = readFileSync(created.file, "utf8"); return Promise.resolve({ text: "ok", isError: false }); },
    };
    const created = session([{ tool: "probe", args: {} }, "done"], { tools: () => [probe] });
    await created.prompt("the exact request", { source: "rpc" });
    const lines = seen.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line["type"])).toEqual(["session", "request", "system", "assistant", "permission", "call_intent"]);
    expect(lines[1]).toMatchObject({ text: "the exact request", origin: "rpc", run: 1 });
    expect(lines.at(-1)).toMatchObject({ type: "call_intent", access: "run",
      tool: { name: "probe", nativeQuestion: false, readOnly: false } });
    expect(created.ledger()).toMatchObject([{ run: 1, text: "the exact request", origin: "rpc", amendments: [] }]);
  });

  test("a repository's base is its commit then, a new repository's is none, and a folder in none is snapshotted", async () => {
    const repository = folder();
    git(repository, "init", "-q");
    const unborn = session(["done"], { cwd: repository });
    await unborn.prompt("go");
    expect(unborn.ledger()[0]?.base.units).toEqual([{ folder: "", kind: "commit", commit: null, refs: [] }]);
    writeFileSync(join(repository, "a.txt"), "a");
    git(repository, "add", "a.txt");
    git(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const head = git(repository, "rev-parse", "HEAD");
    // Each ref's tip at admission that the base does not reach, whatever the remote is called (#599):
    // a tag and a remote-tracking ref on the base's parent are left out, a branch and a remote-tracking ref beside it are kept.
    git(repository, "tag", "older", "HEAD");
    git(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b", "--allow-empty");
    git(repository, "update-ref", "refs/remotes/somewhere/main", head);
    const next = git(repository, "rev-parse", "HEAD");
    const side = git(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "HEAD^{tree}", "-p", head, "-m", "side");
    git(repository, "branch", "side", side);
    git(repository, "update-ref", "refs/remotes/somewhere/side", side);
    const committed = session(["done"], { cwd: repository });
    await committed.prompt("go");
    expect(committed.ledger()[0]?.base.units).toEqual([{ folder: "", kind: "commit", commit: next, refs: [side] }]);
    const plain = session(["done"]);
    await plain.prompt("go");
    expect(plain.ledger()[0]?.base.units[0]).toMatchObject({ folder: "", kind: "snapshot", tooLarge: [] });
  });

  test("a home folder's base says why there is none", async () => {
    const home = session(["done"], { cwd: homedir() });
    await home.prompt("go");
    expect(home.ledger()[0]?.base.units).toEqual([{ folder: "", kind: "refused", reason: "Tesota does not snapshot a home folder or a drive's root" }]);
  });

  test("a steer and a follow-up during a run are amendments with their origin, and enter the conversation in turn", async () => {
    const created = session([{ tool: "write", args: { path: "a.txt", content: "a" } }, "first answer", "second answer"], { slow: true });
    const run = created.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await created.prompt("also b", { streamingBehavior: "steer" });
    await created.prompt("then c", { streamingBehavior: "followUp", source: "extension" });
    await run;
    expect(created.ledger()[0]?.amendments).toMatchObject([
      { id: 1, behavior: "steer", origin: "interactive", text: "also b", delivered: true },
      { id: 2, behavior: "followUp", origin: "extension", text: "then c", delivered: true },
    ]);
    expect(created.ledger()).toHaveLength(1);
    const users = created.messages().filter((message) => message.role === "user").map((message) => message.text);
    expect(users).toEqual(["start", "also b", "then c"]);
  });

  test("a write that cannot be synced stops the run before the tool runs", async () => {
    const cwd = folder();
    let syncs = 0;
    const created = session([{ tool: "write", args: { path: "a.txt", content: "a" } }, "done"], {
      cwd, writer: (writer) => ({ ...writer, sync: () => { if (++syncs === 2) throw new Error("disk full"); writer.sync(); } }),
    });
    await expect(created.prompt("go")).rejects.toThrow("disk full");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(created.outcome()).toBe("error");
  });

  test("a request whose base could not be captured is not a run: input for it is refused and the next request is run 1", async () => {
    let fail: (error: Error) => void = () => undefined;
    let attempts = 0;
    const created = session(["done"], { captureBase: (cwd, signal) => ++attempts === 1
      ? new Promise((_resolve, reject) => { fail = reject; }) : captureBase(cwd, signal) });
    const failure = (promise: Promise<void>): Promise<string> => promise.then(() => "resolved", (error: Error) => error.message);
    const first = failure(created.prompt("first"));
    const steer = failure(created.prompt("also this", { streamingBehavior: "steer" }));
    await Bun.sleep(20);
    fail(new Error("snapshot store locked"));
    expect(await first).toBe("snapshot store locked");
    expect(await steer).toContain("send it as a new prompt");
    expect(created.outcome()).toBeUndefined();
    await created.prompt("second");
    expect(created.outcome()).toBe("completed");
    const saved = readSessionFile(created.file).entries;
    expect(saved.filter((entry) => entry.type === "request")).toMatchObject([{ run: 1, text: "second" }]);
    expect(saved.some((entry) => entry.type === "amendment")).toBe(false);
  });
});

/** Runs `session-child.ts` and resolves with its process once it prints `line`. */
async function child(args: readonly string[], line: string): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
  const spawned = Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), ...args], { stdout: "pipe", stderr: "inherit" });
  let printed = "";
  const decoder = new TextDecoder();
  for await (const chunk of spawned.stdout) {
    printed += decoder.decode(chunk);
    if (printed.includes(line)) return spawned;
  }
  throw new Error(`The child ended without printing ${line}: ${printed}`);
}

const scriptless = () => scripted([]);

test("long shell output stays beside the session after close and resume", async () => {
  const shell = platformShell();
  const command = shell.tool === "powershell" ? "1..20000 | ForEach-Object { 'row-{0:D5}-padding-padding' -f $_ }"
    : "for i in $(seq 1 20000); do printf 'row-%05d-padding-padding\\n' $i; done";
  const created = session([{ calls: [{ tool: shell.tool, args: { command }, id: "call|with:unsafe/id" }] }, "done"]);
  await created.prompt("go");
  const result = created.messages().find((message) => message.role === "toolResult");
  const path = /Full output: (.+)\]/u.exec(result?.text ?? "")?.[1] ?? "";
  expect(path.startsWith(created.file.replace(/\.jsonl$/u, ".output"))).toBe(true);
  await created.dispose();
  const newline = shell.tool === "powershell" ? "\r\n" : "\n";
  expect(readFileSync(path, "utf8")).toBe(Array.from({ length: 20000 }, (_, index) => `row-${String(index + 1).padStart(5, "0")}-padding-padding${newline}`).join(""));
  const resumed = openSession(created.file, scriptless());
  open.push(resumed);
  expect(resumed.messages().find((message) => message.role === "toolResult")?.text).toContain(path);
});

for (const [name, printed, expected] of [
  ["a partial first line", `${"x".repeat(4 * maxBytes)}\r\nkept\r\n`, "kept"],
  ["a single line without a newline", `${"x".repeat(3 * maxBytes)}end`, `${"x".repeat(maxBytes - 3)}end`],
  ["the line limit", `${"row\n".repeat(3000)}last\n`, `${"row\n".repeat(1999)}last`],
  ["the byte limit without splitting UTF-8", `${"ñ".repeat(3 * maxBytes / 4)}\n`, "ñ".repeat(maxBytes / 2)],
  ["empty output", "", ""],
]) {
  test(`recovered shell output handles ${name}`, async () => {
    const shell = platformShell();
    const command = shell.tool === "powershell" ? "Write-Output 'small'" : "echo small";
    const created = session([{ calls: [{ tool: shell.tool, args: { command }, id: "saved|call" }] }, "done"]);
    await created.prompt("go");
    await created.dispose();
    const lines = readFileSync(created.file, "utf8").trimEnd().split("\n");
    const intent = lines.findIndex((line) => line.includes('"type":"call_intent"'));
    writeFileSync(created.file, `${lines.slice(0, intent + 1).join("\n")}\n`);
    const output = created.file.replace(/\.jsonl$/u, ".output");
    const older = join(output, `${outputPrefix("saved|call")}ffffffff.txt`);
    writeFileSync(older, "stale output from an earlier call");
    utimesSync(older, 1, 1);
    const path = join(output, `${outputPrefix("saved|call")}12345678.txt`);
    writeFileSync(path, printed ?? "");
    utimesSync(path, 2, 2);
    writeFileSync(join(output, `${outputPrefix("saved|call").slice(0, -1)}.txt`), "not a matching prefix");
    const resumed = openSession(created.file, scriptless());
    open.push(resumed);
    const repair = readSessionFile(created.file).entries.find((entry) => entry.type === "reconciliation");
    if (printed === "") {
      expect(repair).not.toHaveProperty("output");
      expect(repair).not.toHaveProperty("path");
    } else expect(repair).toMatchObject({ output: expected, path });
    expect(Buffer.byteLength(repair?.type === "reconciliation" ? repair.output ?? "" : "", "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(resumed.messages().find((message) => message.role === "toolResult")?.text).toContain(expected ?? "");
  });
}

test("an empty interrupted call does not recover an earlier long output with the same ID", async () => {
  const shell = platformShell();
  const command = shell.tool === "powershell" ? `[Console]::Write(('x' * ${3 * maxBytes}) + 'end')`
    : `printf '%${3 * maxBytes}s' '' | tr ' ' x; printf end`;
  const created = session([
    { calls: [{ tool: shell.tool, args: { command }, id: "repeated|call" }] },
    { calls: [{ tool: shell.tool, args: { command: "" }, id: "repeated|call" }] }, "done",
  ]);
  await created.prompt("go");
  const result = created.messages().find((message) => message.role === "toolResult");
  const first = /Full output: (.+)\]/u.exec(result?.text ?? "")?.[1] ?? "";
  expect(readFileSync(first, "utf8")).toBe(`${"x".repeat(3 * maxBytes)}end`);
  await created.dispose();
  const lines = readFileSync(created.file, "utf8").trimEnd().split("\n");
  const intent = lines.findLastIndex((line) => line.includes('"type":"call_intent"'));
  writeFileSync(created.file, `${lines.slice(0, intent + 1).join("\n")}\n`);
  utimesSync(first, 1, 1);
  const latest = join(created.file.replace(/\.jsonl$/u, ".output"), `${outputPrefix("repeated|call")}00000000.txt`);
  writeFileSync(latest, "");
  utimesSync(latest, 2, 2);
  const resumed = openSession(created.file, scriptless());
  open.push(resumed);
  const repairs = readSessionFile(created.file).entries.filter((entry) => entry.type === "reconciliation");
  expect(repairs).toHaveLength(1);
  expect(repairs[0]).toMatchObject({ reply: 1, callId: "repeated|call", repair: "outcome_unknown" });
  expect(repairs[0]).not.toHaveProperty("output");
  expect(repairs[0]).not.toHaveProperty("path");
  expect(resumed.messages().filter((message) => message.role === "toolResult")[1]?.text).toContain("Outcome unknown");
  expect(readFileSync(first, "utf8")).toBe(`${"x".repeat(3 * maxBytes)}end`);
});

describe("recovery after the process was killed", () => {
  test("a shell repair keeps what it printed and its file, and recovering twice adds nothing", async () => {
    const cwd = folder();
    const sessions = folder("tesota-core-sessions-");
    const running = await child(["shell", cwd, sessions], "printed");
    try {
      running.kill("SIGKILL");
      await running.exited;
      const file = readFileSync(join(sessions, "file.txt"), "utf8");
      const resumed = openSession(file, scriptless());
      open.push(resumed);
      const repair = readSessionFile(file).entries.find((entry) => entry.type === "reconciliation");
      expect(repair).toMatchObject({ repair: "outcome_unknown", output: "printed before interruption" });
      if (repair?.type !== "reconciliation") throw new Error("No repair was recorded");
      expect(existsSync(repair.path ?? "")).toBe(true);
      const results = resumed.messages().filter((message) => message.role === "toolResult");
      expect(results[0]?.text).toContain("Outcome unknown");
      expect(results[0]?.text).toContain("printed before interruption");
      expect(results[0]?.text).toContain(`the last 1 lines; full output: ${repair.path}`);
      expect(results[1]?.text).toContain("Not run");
      const once = readFileSync(file, "utf8");
      await resumed.dispose();
      const again = openSession(file, scriptless());
      open.push(again);
      expect(readFileSync(file, "utf8")).toBe(once);
      expect(again.messages()).toEqual(resumed.messages());
      expect(existsSync(repair.path ?? "")).toBe(true);
    } finally {
      running.kill("SIGKILL");
      writeFileSync(join(cwd, "release.txt"), "");
    }
  });

  for (const mode of ["tool", "read"]) {
    test(`an interrupted ${mode} call is repaired, the next never started, and recovering twice adds nothing`, async () => {
      const cwd = folder();
      const sessions = folder("tesota-core-sessions-");
      const running = await child([mode, cwd, sessions], "waiting");
      running.kill("SIGKILL");
      await running.exited;
      const file = readFileSync(join(sessions, "file.txt"), "utf8");
      const resumed = openSession(file, scriptless());
      open.push(resumed);
      expect(resumed.outcome()).toBe("interrupted");
      const results = resumed.messages().filter((message) => message.role === "toolResult");
      expect(results.map((result) => [result.toolName, result.isError])).toEqual([["wait", true], ["write", true]]);
      expect(results[0]?.text).toContain(mode === "read" ? "Interrupted" : "Outcome unknown");
      if (mode === "read") expect(results[0]?.text).toContain("It only reads, so it changed nothing");
      expect(results[1]?.text).toContain("Not run");
      expect(existsSync(join(cwd, "never.txt"))).toBe(false);
      expect(resumed.ledger()).toMatchObject([{ run: 1, text: "go" }]);
      const once = entriesOf(file);
      // `wait` may change files as the gate decides it, whatever access it declares, so the run gets a receipt that verified nothing (#599).
      const tail = ["reconciliation", "reconciliation", "custom_message", "run_end"];
      expect(once.slice(-tail.length).map((entry) => entry.type)).toEqual(tail);
      await resumed.dispose();
      const again = openSession(file, scriptless());
      open.push(again);
      expect(entriesOf(file)).toEqual(once);
    });
  }

  // One rule decides, on both sides, whether a started call may have changed files (#599): the gate's `toolMayChangeFiles`.
  test.each([
    ["a read", "read", "read", { name: "read", nativeQuestion: false, readOnly: false }],
    ["a question", "ask_user", "read", { name: "ask_user", nativeQuestion: true, readOnly: false }],
    ["a subagent in a read-only session", "agent", "read", { name: "agent", nativeQuestion: false, readOnly: true }],
    ["a subagent", "agent", "read", { name: "agent", nativeQuestion: false, readOnly: false }],
    ["a write", "write", "write", { name: "write", nativeQuestion: false, readOnly: false }],
    ["a read an older file recorded", "read", "read", undefined],
  ] as const)("a dead run whose only started call is %s gets the receipt the gate's rule gives it", (_name, name, access, tool) => {
    const call = { type: "toolCall", id: "c1", name, arguments: {} };
    const entries = [
      { type: "request", run: 1, text: "go", origin: "interactive", at: new Date(0).toISOString(),
        base: { units: [{ folder: "", kind: "commit", commit: "0".repeat(40) }] } },
      { type: "assistant", run: 1, message: { role: "assistant", content: [call] } },
      { type: "call_intent", run: 1, callId: "c1", access, ...tool === undefined ? {} : { tool } },
    ] as unknown as SessionEntry[];
    const receipts = recovery(entries, () => undefined).flatMap((entry) => entryReceipt(entry) ?? []);
    // An entry without the call's tool can't be judged, so it counts as one that may have changed files.
    const mayChange = tool === undefined || toolMayChangeFiles(tool.name, tool.nativeQuestion, tool.readOnly);
    expect(receipts).toHaveLength(mayChange ? 1 : 0);
    if (mayChange) expect(receipts[0]).toMatchObject({ changed: "unreadable", proofs: [], tests: [], stopped: expect.stringContaining("no check ran") });
  });

  test("a reply cut off mid-stream leaves the request in the ledger and the run interrupted", async () => {
    const cwd = folder();
    const sessions = folder("tesota-core-sessions-");
    const running = Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), "stream", cwd, sessions], { stdout: "ignore", stderr: "inherit" });
    const pathFile = join(sessions, "file.txt");
    try {
      await sessionFileWith(sessions, "\"type\":\"request\"");
    } finally {
      running.kill("SIGKILL");
      await running.exited;
    }
    const resumed = openSession(readFileSync(pathFile, "utf8"), scriptless());
    open.push(resumed);
    expect(resumed.messages().map((message) => message.role)).toEqual(["user"]);
    expect(resumed.outcome()).toBe("interrupted");
    expect(resumed.ledger()).toMatchObject([{ run: 1, text: "go" }]);
  });
});

describe("recovery after the process was killed while settling (#439)", () => {
  test("killed during verification, the run is interrupted, nothing is invented, and recovering twice adds nothing", async () => {
    const sessions = folder("tesota-core-sessions-");
    const running = await child(["verify", folder(), sessions], "verifying");
    running.kill("SIGKILL");
    await running.exited;
    const file = readFileSync(join(sessions, "file.txt"), "utf8");
    const resumed = openSession(file, scriptless());
    open.push(resumed);
    expect(resumed.outcome()).toBe("interrupted");
    const once = entriesOf(file);
    expect(once.slice(-2).map((entry) => entry.type)).toEqual(["settle", "run_end"]);
    await resumed.dispose();
    open.push(openSession(file, scriptless()));
    expect(entriesOf(file)).toEqual(once);
  });

  test("killed after the receipt was recorded but before the run's end, the receipt stays and the run is interrupted", async () => {
    const sessions = folder("tesota-core-sessions-");
    const running = Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), "receipt", folder(), sessions], { stdout: "ignore", stderr: "inherit" });
    await running.exited;
    const file = readFileSync(join(sessions, "file.txt"), "utf8");
    const resumed = openSession(file, scriptless());
    open.push(resumed);
    expect(resumed.outcome()).toBe("interrupted");
    const once = entriesOf(file);
    expect(once.slice(-3)).toMatchObject([{ type: "custom", customType: "receipt" }, { type: "settled", phase: "verifier" },
      { type: "run_end", outcome: "interrupted" }]);
    await resumed.dispose();
    open.push(openSession(file, scriptless()));
    expect(entriesOf(file)).toEqual(once);
  });
});

describe("one writer", () => {
  test("a session open in this process cannot be opened again", async () => {
    const created = session(["done"]);
    expect(() => openSession(created.file, scriptless())).toThrow(SessionLockedError);
    await created.dispose();
    open.push(openSession(created.file, scriptless()));
  });

  test("a session open in another process is refused, and free again once that process is killed", async () => {
    const created = session(["done"]);
    await created.prompt("go");
    await created.dispose();
    const holder = await child(["hold", created.file], "opened");
    expect(() => openSession(created.file, scriptless())).toThrow(SessionLockedError);
    holder.kill("SIGKILL");
    await holder.exited;
    open.push(openSession(created.file, scriptless()));
  });

  test("of two processes opening the same session at once, exactly one gets it", async () => {
    const created = session(["done"]);
    await created.dispose();
    const racers = [0, 1].map(() => Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), "hold", created.file],
      { stdout: "pipe", stderr: "inherit" }));
    const said = await Promise.all(racers.map(async (racer) => {
      const decoder = new TextDecoder();
      for await (const chunk of racer.stdout) {
        const text = decoder.decode(chunk);
        if (text.includes("opened") || text.includes("locked")) return text.trim();
      }
      return "";
    }));
    for (const racer of racers) racer.kill("SIGKILL");
    expect(said.sort()).toEqual(["locked", "opened"]);
  });
});

describe("the session file", () => {
  /** A session with one finished run, closed, and its file. */
  async function finished(): Promise<string> {
    const created = session(["done"]);
    await created.prompt("go");
    await created.dispose();
    return created.file;
  }

  test("an incomplete last line is cut off, and a whole last entry without its newline is kept", async () => {
    const file = await finished();
    const whole = readFileSync(file, "utf8");
    appendFileSync(file, "{\"type\":\"assist");
    expect(readSessionFile(file).tail).toBe("torn");
    expect(readFileSync(file, "utf8")).toBe(whole);
    appendFileSync(file, JSON.stringify({ type: "run_end", run: 1, outcome: "aborted" }));
    expect(readSessionFile(file).tail).toBe("unterminated");
    expect(readFileSync(file, "utf8").endsWith("\"aborted\"}\n")).toBe(true);
  });

  test("a broken line before the end refuses to open, naming the line", async () => {
    const file = await finished();
    const lines = readFileSync(file, "utf8").split("\n");
    lines[2] = "{not json";
    writeFileSync(file, lines.join("\n"));
    expect(() => openSession(file, scriptless())).toThrow("broken entry on line 3");
  });

  test("an entry out of place refuses to open", async () => {
    const file = await finished();
    appendFileSync(file, `${JSON.stringify({ type: "call_intent", run: 7, callId: "x", access: "run" })}\n`);
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
  });

  /** A system message as a session records one (#779). */
  const systemEntry = { type: "system", message: { role: "system", content: "", timestamp: 0 } };

  test("the system prompt belongs to the session: before any request, between runs and at the end, never to a run (#779)", async () => {
    const file = await finished();
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const tools = JSON.stringify(systemEntry);
    writeFileSync(file, `${[lines[0], tools, ...lines.slice(1), tools].join("\n")}\n`);
    const resumed = openSession(file, scriptless());
    open.push(resumed);
    expect(resumed.outcome()).toBe("completed");
    await resumed.dispose();
    appendFileSync(file, `${JSON.stringify({ ...systemEntry, run: 1 })}\n`);
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
  });

  test("a system message recorded mid-run stays where it is when recovery ends the run", async () => {
    const file = await finished();
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const ended = lines.findLastIndex((line) => line.includes("\"type\":\"settle\""));
    writeFileSync(file, `${[...lines.slice(0, ended), JSON.stringify(systemEntry)].join("\n")}\n`);
    const resumed = openSession(file, scriptless());
    open.push(resumed);
    expect(resumed.outcome()).toBe("interrupted");
    expect(entriesOf(file).slice(-2).map((entry) => entry.type)).toEqual(["system", "run_end"]);
  });

  // Older formats are refused, not reinterpreted or migrated.
  for (const version of [1, 2, 3, 4, 5, 6]) {
    test(`a session of version ${version} refuses to open, naming it`, async () => {
      const file = await finished();
      const lines = readFileSync(file, "utf8").split("\n");
      lines[0] = (lines[0] ?? "").replace("\"version\":7", `"version":${version}`);
      const before = lines.join("\n");
      writeFileSync(file, before);
      expect(() => openSession(file, scriptless())).toThrow(`version ${version}`);
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  }

  test("version 7 reads, with the verifier's message in the conversation and its data outside it", () => {
    const fixture = join(import.meta.dir, "fixtures", "session-v7.jsonl");
    const copy = join(folder(), "session-v7.jsonl");
    writeFileSync(copy, readFileSync(fixture));
    const resumed = openSession(copy, scriptless());
    open.push(resumed);
    expect(resumed.messages().map((message) => message.customType ?? message.role))
      .toEqual(["user", "assistant", "toolResult", "assistant", "gate", "assistant"]);
    expect(resumed.outcome()).toBe("completed");
    expect(resumed.ledger()).toMatchObject([{ run: 1, text: "write a", origin: "interactive", amendments: [] }]);
  });

  test("a withdrawal must name pending input of the same run and cannot withdraw it twice", async () => {
    for (const amendment of [99, 1, 2]) {
      const file = await finished();
      appendFileSync(file, `${JSON.stringify({ type: "amendment", run: 1, id: 1, text: "delivered", behavior: "steer", origin: "interactive", at: new Date(0).toISOString() })}\n`
        + `${JSON.stringify({ type: "delivered", run: 1, amendment: 1 })}\n`
        + `${JSON.stringify({ type: "amendment", run: 1, id: 2, text: "pending", behavior: "followUp", origin: "interactive", at: new Date(0).toISOString() })}\n`
        + `${JSON.stringify({ type: "withdrawn", run: 1, amendment: 2 })}\n`
        + `${JSON.stringify({ type: "withdrawn", run: 1, amendment })}\n`);
      const before = readFileSync(file, "utf8");
      expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
      expect(readFileSync(file, "utf8")).toBe(before);
    }
  });

  test("a call intent without declared access is refused without changing the file", async () => {
    const file = await finished();
    appendFileSync(file, `${JSON.stringify({ type: "call_intent", run: 1, callId: "x" })}\n`);
    const before = readFileSync(file, "utf8");
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a call intent whose tool is recorded in part is refused without changing the file", async () => {
    const file = await finished();
    appendFileSync(file, `${JSON.stringify({ type: "call_intent", run: 1, callId: "x", access: "read", tool: { name: "agent" } })}\n`);
    const before = readFileSync(file, "utf8");
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  for (const field of ["output", "path"]) {
    test(`a reconciliation with invalid ${field} is refused`, async () => {
      const file = await finished();
      appendFileSync(file, `${JSON.stringify({ type: "reconciliation", run: 1, reply: 0, callId: "x", toolName: "bash",
        repair: "outcome_unknown", [field]: 7 })}\n`);
      expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
    });
  }

  test("a run that ends completed without its verifier's settlement refuses to open", async () => {
    const file = await finished();
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${lines.filter((line) => !line.includes("\"phase\":\"verifier\"")).join("\n")}\n`);
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
  });
});
