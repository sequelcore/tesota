import { type AssistantMessage, type Context, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject,
  type ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { writable } from "../src/permission-rule.ts";
import { type Access, judge } from "../src/permissions.ts";
import { createSession, type EngineSession, openSession } from "../src/session.ts";
import { accepts } from "./scripted.ts";

/** Each session's scratch folder (#653): where its file tools may write beside its folder, never part of its change. */
const folder = (prefix: string): string => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
const call = (name: string, args: JsonObject): ToolCall => ({ type: "toolCall", id: "c", name, arguments: args });
/** The system prompt as Pi's scripted model is given it, among the messages. */
const promptOf = (context: Context): string => (context.messages as unknown as { role: string; content?: string }[])
  .filter((message) => message.role === "system").map(({ content }) => content ?? "").join("\n");
const insideOf = (path: string, parent: string): boolean => {
  const from = relative(parent, path);
  return from === "" || (!from.startsWith("..") && !/^[a-z]:|^[\\/]/iu.test(from));
};

describe("the proved rule: a write is allowed only inside the session's folder or its scratch folder", () => {
  test("by whole names from the root, so a folder that only begins the same is not inside", () => {
    const cwd = ["home", "me", "project"];
    const scratch = ["home", "me", ".tesota", "sessions", "s1.scratch"];
    expect(writable(["home", "me", "project", "a.ts"], cwd, scratch)).toBe(true);
    expect(writable(["home", "me", "project"], cwd, scratch)).toBe(true);
    expect(writable(["home", "me", ".tesota", "sessions", "s1.scratch", "commit.txt"], cwd, scratch)).toBe(true);
    expect(writable(["home", "me", ".tesota", "sessions", "s1.scratch2", "x"], cwd, scratch)).toBe(false);
    expect(writable(["home", "me", ".tesota", "sessions", "s1.jsonl"], cwd, scratch)).toBe(false);
    expect(writable(["home", "me", "project-other", "a.ts"], cwd, scratch)).toBe(false);
    expect(writable(["tmp", "x"], cwd, scratch)).toBe(false);
    expect(writable(["home", "me"], cwd, scratch)).toBe(false);
  });
});

describe("the floor with a scratch folder", () => {
  const cwd = folder("tesota-scratch-cwd-");
  const scratch = join(folder("tesota-scratch-sessions-"), "s1.scratch");
  mkdirSync(scratch);
  const floor = (name: string, args: JsonObject, access: Access, given: { scratch?: string } = { scratch }) =>
    judge(call(name, args), access, cwd, "full", [], true, given.scratch);

  test("a write or an edit into the scratch folder is allowed, and in the session's folder as before", () => {
    expect(floor("write", { path: join(scratch, "commit.txt") }, "write").decision).toBe("allow");
    expect(floor("write", { path: join(scratch, "deep", "probe.ts") }, "write").decision).toBe("allow");
    expect(floor("edit", { path: join(scratch, "commit.txt") }, "write").decision).toBe("allow");
    expect(floor("write", { path: "src/a.ts" }, "write").decision).toBe("allow");
  });

  test("a write to the system's temporary folder is refused, and the refusal names the scratch folder", () => {
    const verdict = floor("write", { path: join(tmpdir(), "commit.txt") }, "write");
    expect(verdict).toMatchObject({ decision: "deny", by: "floor" });
    expect(verdict.reason).toContain("it is outside the session's folder");
    expect(verdict.reason).toContain(scratch);
  });

  test("a path that leaves the scratch folder with .. is refused", () => {
    for (const path of [join(scratch, "..", "escaped.txt"), `${scratch}/../escaped.txt`, join(scratch, "a", "..", "..", "s1.jsonl")]) {
      expect(floor("write", { path }, "write")).toMatchObject({ decision: "deny", by: "floor" });
    }
  });

  test("a link in the scratch folder to a folder outside is refused", () => {
    const outside = folder("tesota-scratch-outside-");
    // A junction needs no privilege on Windows; elsewhere a symbolic link.
    symlinkSync(outside, join(scratch, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(floor("write", { path: join(scratch, "link", "x.txt") }, "write")).toMatchObject({ decision: "deny", by: "floor" });
  });

  test("a scratch folder replaced by a link to a folder outside, before its first write, is refused", () => {
    const replaced = join(folder("tesota-scratch-sessions-"), "s2.scratch");
    const outside = folder("tesota-scratch-outside-");
    symlinkSync(outside, replaced, process.platform === "win32" ? "junction" : "dir");
    const given = { scratch: replaced };
    expect(floor("write", { path: join(replaced, "x.txt") }, "write", given)).toMatchObject({ decision: "deny", by: "floor" });
    expect(floor("write", { path: join(outside, "x.txt") }, "write", given)).toMatchObject({ decision: "deny", by: "floor" });
  });

  test("without a scratch folder, the same write is refused: the floor is as it was", () => {
    expect(floor("write", { path: join(scratch, "commit.txt") }, "write", {})).toMatchObject({ decision: "deny", by: "floor" });
  });

  test.if(process.platform === "win32")("on Windows, the scratch folder in another case or with forward slashes is inside", () => {
    for (const spelling of [scratch.toUpperCase(), scratch.split("\\").join("/")]) {
      expect(floor("write", { path: join(spelling, "a.txt") }, "write").decision).toBe("allow");
    }
    expect(floor("write", { path: `${scratch.split("\\").join("/")}/../escaped.txt` }, "write").decision).toBe("deny");
  });

  test.if(process.platform !== "win32")("on POSIX, a backslash is part of a name, not a separator", () => {
    // `a\..\..\x` is one file's name inside the scratch folder, so it stays there.
    expect(floor("write", { path: join(scratch, "a\\..\\..\\x") }, "write").decision).toBe("allow");
    expect(floor("write", { path: `${scratch}\\..\\x` }, "write").decision).toBe("deny");
  });
});

describe("a session's scratch folder", () => {
  const open: EngineSession[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

  type Reply = (context: Context) => AssistantMessage;
  const calls = (...steps: { tool: string; args: JsonObject }[]): AssistantMessage =>
    fauxAssistantMessage(steps.map(({ tool, args }) => fauxToolCall(tool, args)), { stopReason: "toolUse" });

  function session(cwd: string, replies: Reply[], options: { folder?: string } = {}): EngineSession {
    const faux = fauxProvider();
    faux.setResponses(replies);
    const models = createModels();
    models.setProvider(faux.provider);
    const created = createSession({ cwd, models, model: faux.getModel(), verifier: accepts, ...options,
      permissions: { mode: () => "full", rules: [] } });
    open.push(created);
    return created;
  }
  const results = (created: EngineSession): string[] =>
    created.messages().flatMap((message) => message.role === "toolResult" ? [message.text ?? ""] : []);

  test("is made with the session outside its folder and the system's temporary folder, and named in its instructions", async () => {
    const cwd = folder("tesota-scratch-project-");
    let prompt = "";
    const created = session(cwd, [(context) => { prompt = promptOf(context); return fauxAssistantMessage("done"); }]);
    const scratch = created.scratch;
    expect(scratch).toBeDefined();
    if (scratch === undefined) return;
    expect(existsSync(scratch)).toBe(true);
    expect(insideOf(scratch, cwd)).toBe(false);
    expect(insideOf(scratch, realpathSync.native(tmpdir()))).toBe(false);
    await created.prompt("go");
    expect(prompt).toContain(scratch);
  });

  test("the agent writes a temporary file there without a refusal; a write to the system's temporary folder is refused and names it", async () => {
    const cwd = folder("tesota-scratch-project-");
    const temporary = join(tmpdir(), "tesota-653-commit.txt");
    let created: EngineSession | undefined;
    const scratch = (): string => created?.scratch ?? "";
    created = session(cwd, [
      () => calls({ tool: "write", args: { path: join(scratch(), "commit.txt"), content: "fix: x\n" } }),
      () => calls({ tool: "write", args: { path: temporary, content: "fix: x\n" } }),
      () => fauxAssistantMessage("done"),
    ]);
    await created.prompt("go");
    const [written, refused] = results(created);
    expect(written).not.toContain("Not run");
    expect(readFileSync(join(scratch(), "commit.txt"), "utf8")).toBe("fix: x\n");
    expect(refused).toContain("Not run: Tesota never allows this: it is outside the session's folder");
    expect(refused).toContain(scratch());
    expect(existsSync(temporary)).toBe(false);
  });

  test("is removed with the session, and made again when it is resumed", async () => {
    const cwd = folder("tesota-scratch-project-");
    const created = session(cwd, [() => fauxAssistantMessage("done")]);
    const scratch = created.scratch ?? "";
    writeFileSync(join(scratch, "probe.ts"), "1\n");
    await created.dispose();
    expect(existsSync(scratch)).toBe(false);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const resumed = openSession(created.file, { models, model: faux.getModel(), verifier: accepts });
    open.push(resumed);
    expect(resumed.scratch).toBe(scratch);
    expect(existsSync(scratch)).toBe(true);
    await resumed.dispose();
    expect(existsSync(scratch)).toBe(false);
  });

  const git = (cwd: string, ...args: string[]): string => {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };

  test("a place inside the repository's tree is used only when Git ignores it", () => {
    const cwd = folder("tesota-scratch-repo-");
    git(cwd, "init", "-q");
    const sessions = join(cwd, "sessions");
    mkdirSync(sessions);
    const unignored = session(cwd, [], { folder: sessions });
    expect(unignored.scratch).toBeUndefined();
    expect(git(cwd, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.includes(".scratch"))).toEqual([]);
    // A folder whose name only begins with `..` is still inside the repository.
    const dotted = folder("tesota-scratch-repo-");
    git(dotted, "init", "-q");
    mkdirSync(join(dotted, "..sessions"));
    expect(session(dotted, [], { folder: join(dotted, "..sessions") }).scratch).toBeUndefined();
    const ignoredCwd = folder("tesota-scratch-repo-");
    git(ignoredCwd, "init", "-q");
    writeFileSync(join(ignoredCwd, ".gitignore"), "/sessions/\n");
    mkdirSync(join(ignoredCwd, "sessions"));
    const ignored = session(ignoredCwd, [], { folder: join(ignoredCwd, "sessions") });
    expect(ignored.scratch).toBeDefined();
    expect(existsSync(ignored.scratch ?? "")).toBe(true);
  });
});
