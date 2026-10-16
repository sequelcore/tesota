import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { Session } from "../../../src/contract.ts";
import { createSession, type EngineSession, openSession, type SessionOptions } from "../src/session.ts";
import { readSessionFile, SessionFileError } from "../src/session-file.ts";
import { SessionLockedError } from "../src/session-lock.ts";
import type { EngineTool } from "../src/tool.ts";
import { piEngine } from "./adapters/pi.ts";
import { tesotaEngine } from "./adapters/tesota.ts";
import type { ScriptStep } from "./engine.ts";
import { accepts, scriptedReply } from "./scripted.ts";

/**
 * Sessions and the request ledger (#437): resuming, on both engines; then
 * what only `@tesota/core` promises: the ledger written before any tool
 * runs, recovery after the process was killed, one writer, and a file that
 * opens whole or not at all.
 */
const open: Session[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

const folder = (prefix = "tesota-core-session-"): string => mkdtempSync(join(tmpdir(), prefix));

for (const engine of [piEngine, tesotaEngine]) {
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
    expect(lines.map((line) => line["type"])).toEqual(["session", "request", "assistant", "call_intent"]);
    expect(lines[1]).toMatchObject({ text: "the exact request", origin: "rpc", run: 1 });
    expect(created.ledger()).toMatchObject([{ run: 1, text: "the exact request", origin: "rpc", amendments: [] }]);
  });

  test("a repository's base is its commit then, a new repository's is none, and a folder in none is snapshotted", async () => {
    const repository = folder();
    git(repository, "init", "-q");
    const unborn = session(["done"], { cwd: repository });
    await unborn.prompt("go");
    expect(unborn.ledger()[0]?.base.units).toEqual([{ folder: "", kind: "commit", commit: null }]);
    writeFileSync(join(repository, "a.txt"), "a");
    git(repository, "add", "a.txt");
    git(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const head = git(repository, "rev-parse", "HEAD");
    const committed = session(["done"], { cwd: repository });
    await committed.prompt("go");
    expect(committed.ledger()[0]?.base.units).toEqual([{ folder: "", kind: "commit", commit: head }]);
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

describe("recovery after the process was killed", () => {
  test("a call that may have run is marked outcome unknown, the next never started, and recovering twice adds nothing", async () => {
    const cwd = folder();
    const sessions = folder("tesota-core-sessions-");
    const running = await child(["tool", cwd, sessions], "waiting");
    running.kill("SIGKILL");
    await running.exited;
    const file = readFileSync(join(sessions, "file.txt"), "utf8");
    const resumed = openSession(file, scriptless());
    open.push(resumed);
    expect(resumed.outcome()).toBe("interrupted");
    const results = resumed.messages().filter((message) => message.role === "toolResult");
    expect(results.map((result) => [result.toolName, result.isError])).toEqual([["wait", true], ["write", true]]);
    expect(results[0]?.text).toContain("Outcome unknown");
    expect(results[1]?.text).toContain("Not run");
    expect(existsSync(join(cwd, "never.txt"))).toBe(false);
    expect(resumed.ledger()).toMatchObject([{ run: 1, text: "go" }]);
    const once = entriesOf(file);
    expect(once.slice(-3).map((entry) => entry.type)).toEqual(["reconciliation", "reconciliation", "run_end"]);
    await resumed.dispose();
    const again = openSession(file, scriptless());
    open.push(again);
    expect(entriesOf(file)).toEqual(once);
  });

  test("a reply cut off mid-stream leaves the request in the ledger and the run interrupted", async () => {
    const cwd = folder();
    const sessions = folder("tesota-core-sessions-");
    const running = Bun.spawn(["bun", join(import.meta.dir, "session-child.ts"), "stream", cwd, sessions], { stdout: "ignore", stderr: "inherit" });
    const pathFile = join(sessions, "file.txt");
    while (!existsSync(pathFile) || !readFileSync(readFileSync(pathFile, "utf8"), "utf8").includes("\"type\":\"request\"")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    running.kill("SIGKILL");
    await running.exited;
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
    appendFileSync(file, `${JSON.stringify({ type: "call_intent", run: 7, callId: "x" })}\n`);
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
  });

  // Version 1 promised no verification behind "completed" (#439), so it is refused, not reinterpreted.
  for (const version of [1, 3]) {
    test(`a session of version ${version} refuses to open, naming it`, async () => {
      const file = await finished();
      const lines = readFileSync(file, "utf8").split("\n");
      lines[0] = (lines[0] ?? "").replace("\"version\":2", `"version":${version}`);
      writeFileSync(file, lines.join("\n"));
      expect(() => openSession(file, scriptless())).toThrow(`version ${version}`);
    });
  }

  test("version 2 as committed still reads, with the verifier's message in the conversation and its data outside it", () => {
    const fixture = join(import.meta.dir, "fixtures", "session-v2.jsonl");
    const copy = join(folder(), "session-v2.jsonl");
    writeFileSync(copy, readFileSync(fixture));
    const resumed = openSession(copy, scriptless());
    open.push(resumed);
    expect(resumed.messages().map((message) => message.customType ?? message.role))
      .toEqual(["user", "assistant", "toolResult", "assistant", "gate", "assistant"]);
    expect(resumed.outcome()).toBe("completed");
    expect(resumed.ledger()).toMatchObject([{ run: 1, text: "write a", origin: "interactive", amendments: [] }]);
  });

  test("a run that ends completed without its verifier's settlement refuses to open", async () => {
    const file = await finished();
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${lines.filter((line) => !line.includes("\"phase\":\"verifier\"")).join("\n")}\n`);
    expect(() => openSession(file, scriptless())).toThrow(SessionFileError);
  });
});
