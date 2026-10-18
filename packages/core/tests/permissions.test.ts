import { createModels, fauxProvider, type JsonObject, type ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { type Decision, decide, type RuleVerdict, strongest } from "../src/permission-rule.ts";
import { type Access, judge, loadRules, type Mode } from "../src/permissions.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import type { ScriptStep } from "./engine.ts";
import { accepts, scriptedReply } from "./scripted.ts";

/** Permissions (#449): the proved rule, the floor and the rules, and the boundary every call passes in a session. */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const call = (name: string, args: JsonObject): ToolCall => ({ type: "toolCall", id: "c", name, arguments: args });
const shell = process.platform === "win32" ? "powershell" : "bash";

describe("the rule", () => {
  test("the strongest matching rule: deny over ask over allow", () => {
    const cases: [RuleVerdict[], RuleVerdict][] = [[[], "unmatched"], [["allow"], "allow"], [["allow", "ask"], "ask"],
      [["ask", "deny", "allow"], "deny"], [["unmatched", "allow"], "allow"]];
    for (const [matched, expected] of cases) expect(strongest(matched)).toBe(expected);
  });

  test("the floor, then read only, then rules, then the mode; no one present never asks", () => {
    const cases: [boolean, Mode, Access, RuleVerdict, boolean, Decision][] = [
      [true, "full", "read", "allow", true, "deny"],
      [false, "read", "write", "allow", true, "deny"],
      [false, "read", "read", "unmatched", true, "allow"],
      [false, "full", "run", "deny", true, "deny"],
      [false, "ask", "write", "allow", true, "allow"],
      [false, "full", "write", "ask", true, "ask"],
      [false, "full", "write", "ask", false, "deny"],
      [false, "ask", "write", "unmatched", true, "ask"],
      [false, "ask", "run", "unmatched", false, "deny"],
      [false, "ask", "read", "unmatched", false, "allow"],
      [false, "full", "run", "unmatched", false, "allow"],
    ];
    for (const [floor, mode, access, rule, present, expected] of cases) expect(decide(floor, mode, access, rule, present)).toBe(expected);
  });
});

describe("the floor, which no mode crosses", () => {
  const cwd = folder("tesota-core-permissions-");
  const floor = (name: string, args: JsonObject, access: Access) => judge(call(name, args), access, cwd, "full", [], true);

  test("writing or editing outside the session's folder, however the path is spelled", () => {
    const outside = [join(cwd, "..", "elsewhere.txt"), "../elsewhere.txt", join(parse(cwd).root, "elsewhere.txt")];
    if (process.platform === "win32") outside.push("\\\\server\\share\\file.txt", "D:\\elsewhere.txt");
    for (const path of outside) expect(floor("write", { path }, "write")).toMatchObject({ decision: "deny", by: "floor" });
    expect(floor("edit", { path: "../x.ts" }, "write")).toMatchObject({ decision: "deny", by: "floor" });
    expect(floor("write", { path: "src/inside.ts" }, "write").decision).toBe("allow");
    expect(floor("read", { path: "../elsewhere.txt" }, "read").decision).toBe("allow");
  });

  test.if(process.platform === "win32")("on Windows, the folder in another case, with forward slashes or by its short name is inside", () => {
    const spellings = [cwd.toUpperCase(), cwd.split("\\").join("/")];
    const short = realpathSync(tmpdir()).includes("~") ? undefined : process.env["TEMP"];
    if (short !== undefined && short !== tmpdir()) spellings.push(join(short, cwd.slice(tmpdir().length)));
    for (const spelling of spellings) expect(floor("write", { path: join(spelling, "a.txt") }, "write").decision).toBe("allow");
  });

  test("secrets: .env files, SSH's keys and Tesota's credentials, even to read", () => {
    for (const path of [".env", "config/.env.production", join(homedir(), ".ssh", "id_ed25519"), join(homedir(), ".tesota", "auth.json"),
      join(homedir(), ".tesota", "mcp-auth.json"), join(homedir(), ".tesota", "mcp-auth.json.new")]) {
      expect(floor("read", { path }, "read")).toMatchObject({ decision: "deny", by: "floor" });
    }
    expect(floor("read", { path: "src/env.ts" }, "read").decision).toBe("allow");
  });

  test("commands that destroy a disk, the root or a home folder, or name a secret", () => {
    for (const command of ["rm -rf /", "rm -rf ~", "sudo rm -fr /*", "Remove-Item -Recurse -Force C:\\", "format C:", "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda", ":(){ :|:& };:", "cat .env", "type C:\\Users\\me\\.ssh\\id_rsa", "Get-Content ~/.tesota/auth.json", "cat ~/.tesota/mcp-auth.json"]) {
      expect(floor(shell, { command }, "run")).toMatchObject({ decision: "deny", by: "floor" });
    }
    for (const command of ["rm -rf build", "Remove-Item -Recurse dist", "node -e \"console.log(process.env.HOME)\"", "git status"]) {
      expect(floor(shell, { command }, "run").decision).toBe("allow");
    }
  });

  test("a root with a forward slash, a secret in capitals, and a shell call that also says a harmless path", () => {
    for (const command of ["Remove-Item -Recurse -Force C:/", "Get-Content .ENV", "type CONFIG\\.Env.local"]) {
      expect(floor(shell, { command }, "run")).toMatchObject({ decision: "deny", by: "floor" });
    }
    // The shell runs `command`; a `path` beside it is not what the floor judges.
    expect(floor(shell, { command: "Get-Content .env", path: "README.md" }, "run")).toMatchObject({ decision: "deny", by: "floor" });
  });

  test.if(process.platform !== "win32")("a link named .env is a secret, whatever it points to", () => {
    mkdirSync(join(cwd, "config"), { recursive: true });
    writeFileSync(join(cwd, "config", "runtime"), "KEY=1\n");
    symlinkSync(join(cwd, "config", "runtime"), join(cwd, ".env"));
    expect(floor("read", { path: ".env" }, "read")).toMatchObject({ decision: "deny", by: "floor" });
  });
});

describe("rules", () => {
  test("a rules file that begins with a byte-order mark reads as any other (#470)", () => {
    const home = folder("tesota-core-permissions-home-");
    writeFileSync(join(home, "permissions.json"), `\uFEFF${JSON.stringify({ deny: ["shell(git push*)"] })}`);
    expect(loadRules(folder("tesota-core-permissions-project-"), home)).toHaveLength(1);
  });

  test("an operator's rule allows, asks or denies by tool and pattern; a project's can only tighten", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ allow: ["write(src/**)", "shell(git status*)"], deny: ["shell(git push*)"] }));
    mkdirSync(join(cwd, ".tesota"));
    writeFileSync(join(cwd, ".tesota", "permissions.json"), JSON.stringify({ allow: ["write(**)"], ask: ["write(src/secret/**)"] }));
    const rules = loadRules(cwd, home);
    const decision = (name: string, args: JsonObject, access: Access, mode: Mode = "ask") =>
      judge(call(name, args), access, cwd, mode, rules, true).decision;
    expect(decision("write", { path: "src/a.ts" }, "write")).toBe("allow");
    expect(decision("write", { path: process.platform === "win32" ? "SRC\\b.ts" : "src/b.ts" }, "write")).toBe("allow");
    expect(decision("write", { path: "src/secret/key.ts" }, "write")).toBe("ask");
    expect(decision("write", { path: "README.md" }, "write")).toBe("ask");
    expect(decision(shell, { command: "git status --short" }, "run")).toBe("allow");
    expect(decision(shell, { command: "git push origin main" }, "run", "full")).toBe("deny");
  });

  test("a deny names a command's part on any line; an allow allows only when every part is allowed", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ allow: ["shell(git status*)", "shell(git diff*)"], deny: ["shell(git push*)"] }));
    const rules = loadRules(cwd, home);
    const decision = (command: string, mode: Mode = "ask") => judge(call(shell, { command }), "run", cwd, mode, rules, true).decision;
    expect(decision("git status\ngit push origin dev", "full")).toBe("deny");
    expect(decision("git status; git push origin dev", "full")).toBe("deny");
    if (process.platform === "win32") expect(decision("Git Push origin dev", "full")).toBe("deny");
    expect(decision("git status && git diff")).toBe("allow");
    expect(decision("git status && Remove-Item -Recurse build")).toBe("ask");
    expect(decision("git status | tee out.txt")).toBe("ask");
  });

  test("when in doubt, deny and ask rules match more and allow rules less", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    writeFileSync(join(home, "permissions.json"), JSON.stringify({
      allow: ["shell(Write-Output*)", "shell(git status*)", "shell(git branch -d *)", "shell(echo*)"],
      deny: ["shell(git push*--force*)", "shell(rm*)"],
    }));
    const rules = loadRules(cwd, home);
    const decision = (command: string, mode: Mode = "ask") => judge(call(shell, { command }), "run", cwd, mode, rules, true).decision;
    // A lone carriage return ends a command too.
    expect(decision("Write-Output OK\rWrite-Host HIDDEN")).toBe("ask");
    // Flags keep their case for allow rules: -D is not -d.
    expect(decision("git branch -D topic")).toBe("ask");
    expect(decision("git branch -d topic")).toBe("allow");
    // A deny still reads the whole command where a split would cut it.
    expect(decision("git push origin \"feature;tag\" --force", "full")).toBe("deny");
    // A command run inside another, or in the background, is not what the allow rule names.
    for (const command of ["git status $(whoami)", "git status `whoami`", "git status & whoami", "echo <(whoami)"]) {
      expect(decision(command)).toBe("ask");
    }
    expect(decision("echo $(rm -rf x)", "full")).toBe("deny");
  });

  test("an empty command answers to a rule for the whole tool", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ deny: ["shell"] }));
    for (const command of ["", "   "]) {
      expect(judge(call(shell, { command }), "run", cwd, "full", loadRules(cwd, home), true).decision).toBe("deny");
    }
  });

  test("a folder glob keeps its folders: src/**/safe.ts names safe.ts in src and below, not unsafe.ts", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ allow: ["write(src/**/safe.ts)"] }));
    const rules = loadRules(cwd, home);
    const decision = (path: string) => judge(call("write", { path }), "write", cwd, "ask", rules, true).decision;
    expect(decision("src/safe.ts")).toBe("allow");
    expect(decision("src/a/b/safe.ts")).toBe("allow");
    expect(decision("src/unsafe.ts")).toBe("ask");
    expect(decision("src/a/unsafe.ts")).toBe("ask");
  });

  test("a rules file that cannot be read stops the session and says where, since a rule left out could be a deny", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    const file = join(home, "permissions.json");
    for (const [text, said] of [["{\"ask\":\"write(*)\"}", "ask must be a list of rules"], ["{\"deny\":[17]}", "deny must be a list of rules"],
      ["{\"deny\":[\"write(\"]}", "is not a rule"], ["{", "is not JSON"], ["[]", "does not hold permission rules"]] as const) {
      writeFileSync(file, text);
      expect(() => loadRules(cwd, home)).toThrow(said);
    }
  });

  test("in read only, a write an allow rule names is refused by the mode, and recorded so", () => {
    const home = folder("tesota-core-permissions-home-");
    const cwd = folder("tesota-core-permissions-project-");
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ allow: ["write"] }));
    expect(judge(call("write", { path: "a.txt" }), "write", cwd, "read", loadRules(cwd, home), true))
      .toEqual({ decision: "deny", by: "mode", reason: "The session is read only." });
  });
});

describe("the boundary every call passes", () => {
  const open: EngineSession[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((session) => session.dispose())); });

  function session(script: readonly ScriptStep[], mode: Mode, ask?: (name: string) => "once" | "session" | "deny") {
    const faux = fauxProvider();
    faux.setResponses(script.map(scriptedReply));
    const models = createModels();
    models.setProvider(faux.provider);
    const asked: string[] = [];
    const cwd = folder("tesota-core-permissions-cwd-");
    const created = createSession({ cwd, folder: folder("tesota-core-sessions-"), models, model: faux.getModel(), verifier: accepts,
      permissions: { mode: () => mode, rules: [],
        ...ask === undefined ? {} : { ask: (asking: ToolCall) => { asked.push(asking.name); return Promise.resolve(ask(asking.name)); } } } });
    open.push(created);
    return { created, asked, cwd };
  }
  const entries = (file: string) => readFileSync(file, "utf8").trimEnd().split("\n").slice(1).map((line) => JSON.parse(line) as
    { type: string; decision?: string; by?: string });
  const write = (path: string): ScriptStep => ({ tool: "write", args: { path, content: "x" } });

  test("in ask mode a write asks: allowed once it runs, and each decision is in the session", async () => {
    const { created, asked, cwd } = session([write("a.txt"), "done"], "ask", () => "once");
    await created.prompt("go");
    expect(asked).toEqual(["write"]);
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    expect(entries(created.file).filter(({ type }) => type === "permission")).toMatchObject([{ decision: "allow", by: "operator" }]);
  });

  test("allowed for the session, the same call does not ask again; refused, it does not run and the model is told", async () => {
    const remembered = session([write("a.txt"), write("a.txt"), "done"], "ask", () => "session");
    await remembered.created.prompt("go");
    expect(remembered.asked).toEqual(["write"]);
    expect(entries(remembered.created.file).filter(({ type }) => type === "permission").map(({ by }) => by)).toEqual(["operator", "session"]);
    const refused = session([write("b.txt"), "done"], "ask", () => "deny");
    await refused.created.prompt("go");
    expect(existsSync(join(refused.cwd, "b.txt"))).toBe(false);
    expect(refused.created.messages().find((message) => message.role === "toolResult")).toMatchObject({ isError: true,
      text: "Not run: The operator refused it." });
  });

  test("stopped while the operator is asked, the call does not run whatever they answer, and no intent is recorded", async () => {
    const faux = fauxProvider();
    faux.setResponses([write("a.txt"), "done"].map(scriptedReply));
    const models = createModels();
    models.setProvider(faux.provider);
    const cwd = folder("tesota-core-permissions-cwd-");
    const created = createSession({ cwd, folder: folder("tesota-core-sessions-"), models, model: faux.getModel(), verifier: accepts,
      // The operator stops the run while the dialog is open, then answers yes; stopping waits for the run, so it is not awaited here.
      permissions: { mode: () => "ask", rules: [], ask: () => { void created.abort(); return Promise.resolve("once"); } } });
    open.push(created);
    await created.prompt("go");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(entries(created.file).some(({ type }) => type === "call_intent")).toBe(false);
  });

  test("stopped while the operator has not answered, the run ends without waiting for the answer, and the call does not run", async () => {
    const faux = fauxProvider();
    faux.setResponses([write("a.txt"), "done"].map(scriptedReply));
    const models = createModels();
    models.setProvider(faux.provider);
    const cwd = folder("tesota-core-permissions-cwd-");
    let asked: () => void = () => undefined;
    const asking = new Promise<void>((resolve) => { asked = resolve; });
    // The question is never answered, as when no one is there to see it.
    const created = createSession({ cwd, folder: folder("tesota-core-sessions-"), models, model: faux.getModel(), verifier: accepts,
      permissions: { mode: () => "ask", rules: [], ask: () => { asked(); return new Promise(() => undefined); } } });
    open.push(created);
    const run = created.prompt("go");
    await asking;
    await created.abort();
    await run;
    expect(created.outcome()).toBe("aborted");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(entries(created.file)).toContainEqual(expect.objectContaining({ type: "permission", decision: "deny",
      reason: "The run was stopped before the operator answered." }));
  });

  test("with no one to ask, a call that would ask is refused; read only refuses writes; the floor holds in full access", async () => {
    const alone = session([write("a.txt"), "done"], "ask");
    await alone.created.prompt("go");
    expect(existsSync(join(alone.cwd, "a.txt"))).toBe(false);
    const reading = session([write("a.txt"), "done"], "read", () => "once");
    await reading.created.prompt("go");
    expect(reading.asked).toEqual([]);
    expect(existsSync(join(reading.cwd, "a.txt"))).toBe(false);
    const full = session([write("../escaped.txt"), write("inside.txt"), "done"], "full", () => "once");
    await full.created.prompt("go");
    expect(existsSync(join(full.cwd, "..", "escaped.txt"))).toBe(false);
    expect(existsSync(join(full.cwd, "inside.txt"))).toBe(true);
    expect(full.asked).toEqual([]);
  });
});
