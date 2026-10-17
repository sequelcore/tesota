import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hooks, hooksHash, readHooks, runHooks, trustedHooks, trustHooks } from "../src/hooks.ts";
import type { SessionEvent } from "../src/loop.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import { accepts, scriptedReply } from "./scripted.ts";

/** Command hooks as Claude Code configures them (#457): reading, matching, running, deciding, trusting, and in a session. */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** A hook: a script, in a folder whose name has a space, run by Bun through the system's shell as an operator's hook is. */
function hook(body: string): string {
  const at = join(folder("tesota-core-hooks-"), "a hook");
  mkdirSync(at);
  const script = join(at, "hook.mjs");
  writeFileSync(script, `let input = "";
process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => { const payload = JSON.parse(input); ${body} });
`);
  return `"${process.execPath}" "${script}"`;
}

/**
 * The operator's real guard on Windows, where it is installed: the tests run
 * with a home of their own (HOME, USERPROFILE), so the account's profile
 * comes from HOMEDRIVE and HOMEPATH, which they leave alone.
 */
const operatorGuard = process.platform === "win32"
  ? join(`${process.env["HOMEDRIVE"] ?? ""}${process.env["HOMEPATH"] ?? ""}`, ".agents", "hooks", "guard.py") : "";

const input = { session_id: "s", cwd: tmpdir(), hook_event_name: "PreToolUse" as const, tool_name: "write", tool_input: { path: "a.md" } };
const pre = (...commands: string[]): Hooks => ({ PreToolUse: [{ hooks: commands.map((command) => ({ type: "command" as const, command })) }] });

describe("reading hooks", () => {
  test("from a settings file's hooks, none without the file or the key, and an error naming the file for a shape it cannot read", () => {
    const at = folder("tesota-core-hooks-settings-");
    const path = join(at, "settings.json");
    expect(readHooks(path)).toEqual({});
    writeFileSync(path, JSON.stringify({ permissionMode: "ask" }));
    expect(readHooks(path)).toEqual({});
    const hooks = { PreToolUse: [{ matcher: "bash|powershell", hooks: [{ type: "command", command: "guard", timeout: 5 }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "format" }] }] } as const;
    writeFileSync(path, JSON.stringify({ hooks }));
    expect(readHooks(path)).toEqual(hooks);
    for (const [wrong, said] of [[{ hooks: [] }, "hooks must be an object"], [{ hooks: { PreToolUse: {} } }, "must be a list of groups"],
      [{ hooks: { PreToolUse: [{ hooks: [{ command: "x" }] }] } }, "must be a command hook"],
      [{ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x", timeout: -1 }] }] } }, "timeout must be seconds"]] as const) {
      writeFileSync(path, JSON.stringify(wrong));
      expect(() => readHooks(path)).toThrow(`${path}: hooks`);
      expect(() => readHooks(path)).toThrow(said);
    }
  });
});

describe("running hooks", () => {
  test("a hook is given the call as JSON, and runs only for the tools its matcher takes", async () => {
    const seen = join(folder("tesota-core-hooks-seen-"), "seen.json");
    const writes = hook(`require("node:fs").writeFileSync(${JSON.stringify(seen)}, input);`);
    const matching = (matcher: string | undefined): Hooks => ({ PreToolUse: [{ ...matcher === undefined ? {} : { matcher },
      hooks: [{ type: "command", command: writes }] }] });
    for (const matcher of [undefined, "", "*", "write", "edit|write", "wr.*"]) {
      await runHooks(matching(matcher), input);
      expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual(input);
      writeFileSync(seen, "{}");
    }
    for (const matcher of ["edit", "Write", "bash|powershell", "writ"]) {
      await runHooks(matching(matcher), input);
      expect(readFileSync(seen, "utf8")).toBe("{}");
    }
  });

  test("exit 2 blocks with its error output; JSON blocks with decision or a deny; a system message is a note", async () => {
    expect(await runHooks(pre(hook(`process.stderr.write("no writes to " + payload.tool_input.path); process.exit(2);`)), input))
      .toEqual({ blocked: "no writes to a.md", notes: [] });
    expect(await runHooks(pre(hook(`console.log(JSON.stringify({ decision: "block", reason: "frozen" }));`)), input))
      .toEqual({ blocked: "frozen", notes: [] });
    expect(await runHooks(pre(hook(`console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny",
      permissionDecisionReason: "denied" } }));`)), input)).toEqual({ blocked: "denied", notes: [] });
    expect(await runHooks(pre(hook(`console.log(JSON.stringify({ systemMessage: "formatted" }));`)), input))
      .toEqual({ notes: ["formatted"] });
    expect(await runHooks(pre(hook(`console.log("plain words");`)), input)).toEqual({ notes: [] });
  });

  test("a hook that fails, writes broken JSON, runs past its time or cannot start lets the call through, with a note", async () => {
    const failed = await runHooks(pre(hook(`process.stderr.write("oops"); process.exit(1);`)), input);
    expect(failed.blocked).toBeUndefined();
    expect(failed.notes[0]).toContain("failed (exit 1): oops; the call went on");
    const broken = await runHooks(pre(hook(`console.log("{ not json");`)), input);
    expect(broken).toMatchObject({ notes: [expect.stringContaining("not JSON")] });
    const slow: Hooks = { PreToolUse: [{ hooks: [{ type: "command", command: hook("setTimeout(() => process.exit(2), 10_000);"), timeout: 1 }] }] };
    const late = await runHooks(slow, input);
    expect(late.blocked).toBeUndefined();
    expect(late.notes[0]).toContain("ran past 1 s and was stopped");
    const missing = await runHooks(pre(`"${join(tmpdir(), "no-such-hook.exe")}"`), input);
    expect(missing.blocked).toBeUndefined();
    expect(missing.notes).toHaveLength(1);
  });

  test("hooks run together, and any one that blocks blocks the call whatever the others say", async () => {
    const outcome = await runHooks(pre(hook(`console.log(JSON.stringify({ systemMessage: "checked" }));`),
      hook(`process.stderr.write("refused"); process.exit(2);`), hook("process.exit(0);")), input);
    expect(outcome).toEqual({ blocked: "refused", notes: ["checked"] });
  });

  test.if(existsSync(operatorGuard))("the operator's own guard refuses a force push and lets git status through", async () => {
    const guard: Hooks = { PreToolUse: [{ matcher: "bash|powershell", hooks: [{ type: "command",
      command: `py -3 "${operatorGuard}"` }] }] };
    const shell = { ...input, tool_name: "powershell" };
    expect((await runHooks(guard, { ...shell, tool_input: { command: "git push --force origin main" } })).blocked).toContain("force push");
    expect(await runHooks(guard, { ...shell, tool_input: { command: "git status" } })).toEqual({ notes: [] });
  });
});

describe("trusting a project's hooks", () => {
  test("is kept by the project with a hash of its hooks, and asked again once they change", () => {
    const home = folder("tesota-core-hooks-home-");
    const root = folder("tesota-core-hooks-project-");
    const hash = hooksHash(pre("guard"));
    expect(trustedHooks(root, hash, home)).toBe(false);
    trustHooks(root, hash, home);
    expect(trustedHooks(root, hash, home)).toBe(true);
    expect(trustedHooks(root, hooksHash(pre("guard --strict")), home)).toBe(false);
    expect(trustedHooks(folder("tesota-core-hooks-other-"), hash, home)).toBe(false);
  });
});

describe("hooks in a session", () => {
  const open: EngineSession[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

  function session(hooks: Hooks) {
    const faux = fauxProvider();
    faux.setResponses([{ tool: "write", args: { path: "a.md", content: "x" } }, "done"].map(scriptedReply));
    const models = createModels();
    models.setProvider(faux.provider);
    const cwd = folder("tesota-core-hooks-cwd-");
    const created = createSession({ cwd, folder: folder("tesota-core-hooks-sessions-"), models, model: faux.getModel(), verifier: accepts,
      hooks: () => hooks });
    open.push(created);
    const notes: string[] = [];
    created.subscribe((event: SessionEvent) => { if (event.type === "note") notes.push(event.text); });
    return { created, cwd, notes };
  }
  const entries = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").slice(1).map((line) => JSON.parse(line) as
    { type: string; by?: string; reason?: string });

  test("a hook that refuses a call keeps it from running, and the session records the hook's decision", async () => {
    const { created, cwd } = session(pre(hook(`process.stderr.write("frozen"); process.exit(2);`)));
    await created.prompt("write it");
    expect(existsSync(join(cwd, "a.md"))).toBe(false);
    // The permission check allowed it first; the hook's refusal comes after, and is the call's last word.
    expect(entries(created.file).findLast(({ type }) => type === "permission")).toMatchObject({ by: "hook", reason: "A hook refused it: frozen" });
    expect(created.messages().find((message) => message.role === "toolResult")).toMatchObject({ isError: true,
      text: "Not run: A hook refused it: frozen" });
  });

  test("an after-call hook's message is a note, and one that blocks tells the model why", async () => {
    const after: Hooks = { PostToolUse: [{ matcher: "write", hooks: [
      { type: "command", command: hook(`console.log(JSON.stringify({ systemMessage: "formatted " + payload.tool_input.path }));`) },
      { type: "command", command: hook(`if (!payload.tool_response.isError) { process.stderr.write("lint failed"); process.exit(2); }`) },
    ] }] };
    const { created, cwd, notes } = session(after);
    await created.prompt("write it");
    expect(existsSync(join(cwd, "a.md"))).toBe(true);
    expect(notes).toEqual(["formatted a.md"]);
    expect(created.messages().find((message) => message.role === "toolResult")?.text).toContain("A hook says: lint failed");
  });
});
