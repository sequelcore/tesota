import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { contextFiles, instructionsText, skillCatalog, skills, skillsIn, startedSkill, withArguments } from "../src/instructions.ts";
import { compactedHead, skillMessage } from "../src/loop.ts";
import { createSession, openSession } from "../src/session.ts";
import type { EngineTool } from "../src/tool.ts";
import { accepts, scriptedReply } from "./scripted.ts";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("context starts with Tesota's global file, then walks from the Git root down to cwd", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const home = join(temp, "home");
    const root = join(temp, "project");
    const middle = join(root, "packages");
    const cwd = join(middle, "core");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    put(join(temp, "AGENTS.md"), "above the root");
    put(join(home, "AGENTS.md"), "global");
    put(join(root, "AGENTS.md"), "root");
    put(join(root, "CLAUDE.md"), "ignored");
    put(join(middle, "CLAUDE.md"), "middle");
    put(join(cwd, "AGENTS.md"), "local");
    expect(contextFiles(cwd, home)).toEqual([
      { path: join(home, "AGENTS.md"), content: "global" },
      { path: join(root, "AGENTS.md"), content: "root" },
      { path: join(middle, "CLAUDE.md"), content: "middle" },
      { path: join(cwd, "AGENTS.md"), content: "local" },
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("outside Git only cwd contributes project instructions", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const cwd = join(temp, "nested");
    put(join(temp, "AGENTS.md"), "parent");
    put(join(cwd, "CLAUDE.md"), "local");
    expect(contextFiles(cwd, join(temp, "home"))).toEqual([
      { path: join(cwd, "CLAUDE.md"), content: "local" },
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a worktree's .git file stops discovery before its parent", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const root = join(temp, "worktree");
    const cwd = join(root, "nested");
    put(join(temp, "AGENTS.md"), "parent");
    put(join(root, ".git"), "gitdir: elsewhere");
    put(join(root, "AGENTS.md"), "root");
    put(join(cwd, "AGENTS.md"), "local");
    expect(contextFiles(cwd, join(temp, "home"))).toEqual([
      { path: join(root, "AGENTS.md"), content: "root" },
      { path: join(cwd, "AGENTS.md"), content: "local" },
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("empty and unreadable files are skipped without falling back from an existing AGENTS.md", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const home = join(temp, "home");
    const root = join(temp, "project");
    const middle = join(root, "nested");
    const cwd = join(middle, "leaf");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(middle, "AGENTS.md"), { recursive: true });
    put(join(home, "AGENTS.md"), " \n\t ");
    put(join(root, "AGENTS.md"), "");
    put(join(root, "CLAUDE.md"), "ignored for empty AGENTS");
    put(join(middle, "CLAUDE.md"), "ignored for unreadable AGENTS");
    put(join(cwd, "CLAUDE.md"), " \n local content \n ");
    expect(contextFiles(cwd, home)).toEqual([
      { path: join(cwd, "CLAUDE.md"), content: " \n local content \n " },
    ]);
    expect(contextFiles(join(temp, "missing"), home)).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("skills combine all locations with Tesota, project and nearest-folder precedence", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const homes = { user: join(temp, "user"), tesota: join(temp, "tesota") };
    const root = join(temp, "project");
    const middle = join(root, "nested");
    const cwd = join(middle, "leaf");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const user = join(homes.user, ".agents", "skills");
    const tesota = join(homes.tesota, "skills");
    const project = join(root, ".agents", "skills");
    const near = join(middle, ".agents", "skills");
    const local = join(cwd, ".agents", "skills");
    function skill(at: string, folder: string, name: string, description: string): string {
      const path = join(at, folder, "SKILL.md");
      put(path, ["---", "name: " + name, "description: " + description, "---", "body"].join("\n"));
      return path;
    }
    skill(join(temp, ".agents", "skills"), "above", "above", "outside root");
    const userPath = skill(user, "user-only", "z-user", "user");
    skill(user, "user-clash", "clash", "user");
    skill(user, "tesota-clash", "tesota-wins", "user");
    const tesotaPath = skill(tesota, "tesota-only", "t-tesota", "tesota");
    skill(tesota, "tesota-clash", "clash", "tesota");
    const winner = skill(tesota, "winner", "tesota-wins", "tesota wins");
    const rootPath = skill(project, "root-only", "r-root", "root");
    skill(project, "project-clash", "clash", "root");
    skill(near, "near-clash", "clash", "middle");
    const middlePath = skill(near, "middle-only", "m-middle", "middle");
    const localPath = skill(local, "local-clash", "clash", "nearest");
    expect(skills(cwd, homes)).toEqual([
      { name: "clash", description: "nearest", path: localPath },
      { name: "m-middle", description: "middle", path: middlePath },
      { name: "r-root", description: "root", path: rootPath },
      { name: "t-tesota", description: "tesota", path: tesotaPath },
      { name: "tesota-wins", description: "tesota wins", path: winner },
      { name: "z-user", description: "user", path: userPath },
    ]);
    rmSync(join(local, "local-clash"), { recursive: true });
    expect(skills(cwd, homes).find(({ name }) => name === "clash")?.description).toBe("middle");
    rmSync(join(near, "near-clash"), { recursive: true });
    expect(skills(cwd, homes).find(({ name }) => name === "clash")?.description).toBe("root");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("frontmatter accepts quoted and folded descriptions, defaults names, and requires a description", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const cwd = join(temp, "project");
    const homes = { user: join(temp, "user"), tesota: join(temp, "tesota") };
    const folder = join(cwd, ".agents", "skills");
    const quoted = join(folder, "quoted", "SKILL.md");
    const folded = join(folder, "folded", "SKILL.md");
    const continued = join(folder, "continued", "SKILL.md");
    const unnamed = join(folder, "folder-name", "SKILL.md");
    const literal = join(folder, "literal", "SKILL.md");
    put(quoted, "---\r\nname: 'a-quoted'\r\ndescription: \"A quoted: description\"\r\n---\r\nignored body");
    put(folded, "---\nname: b-folded\ndescription: >-\n  First line\n  second line.\nother: ignored\n---\nbody");
    put(continued, "---\nname: c-continued\ndescription:\n  First part\n\n  second part\n---\nbody");
    put(unnamed, "---\ndescription: No name supplied\n---\nname: body-is-not-metadata");
    put(literal, "---\nname: d-literal\ndescription: |\n  One\n  two\n---\nbody");
    put(join(folder, "no-description", "SKILL.md"), "---\nname: missing\n---\ndescription: only in body");
    put(join(folder, "empty-description", "SKILL.md"), "---\ndescription: ''\n---");
    put(join(folder, "empty-block", "SKILL.md"), "---\ndescription: >\n---");
    put(join(folder, "empty-name", "SKILL.md"), "---\nname: ''\ndescription: Empty name supplied\n---");
    put(join(folder, "no-frontmatter", "SKILL.md"), "name: missing\ndescription: not frontmatter");
    put(join(folder, "unclosed", "SKILL.md"), "---\nname: missing\ndescription: no closing delimiter");
    put(join(folder, "container", "nested", "SKILL.md"), "---\ndescription: too deep\n---");
    mkdirSync(join(folder, "unreadable", "SKILL.md"), { recursive: true });
    put(join(folder, "ordinary-file"), "not a skill folder");
    expect(skills(cwd, homes)).toEqual([
      { name: "a-quoted", description: "A quoted: description", path: quoted },
      { name: "b-folded", description: "First line second line.", path: folded },
      { name: "c-continued", description: "First part second part", path: continued },
      { name: "d-literal", description: "One two", path: literal },
      { name: "empty-name", description: "Empty name supplied", path: join(folder, "empty-name", "SKILL.md") },
      { name: "folder-name", description: "No name supplied", path: unnamed },
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("outside Git skills come only from cwd and the two user locations", () => {
  const temp = mkdtempSync(join(tmpdir(), "tesota-instructions-"));
  try {
    const homes = { user: join(temp, "user"), tesota: join(temp, "tesota") };
    const cwd = join(temp, "project");
    put(join(temp, ".agents", "skills", "above", "SKILL.md"), "---\ndescription: outside project\n---");
    const path = join(cwd, ".agents", "skills", "local", "SKILL.md");
    put(path, "---\ndescription: local only\n---");
    expect(skills(cwd, homes)).toEqual([{ name: "local", description: "local only", path }]);
    expect(skills(join(temp, "missing"), homes)).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a catalog tells the agent to read SKILL.md and retains full entries when they fit", () => {
  const list = [
    { name: "first", description: "a".repeat(300), path: "/skills/first/SKILL.md" },
    { name: "second", description: "Second skill", path: "/skills/second/SKILL.md" },
  ];
  const catalog = skillCatalog(list, 100_000);
  const [heading] = catalog.split("\n");
  expect(heading).toContain("Available skills");
  expect(heading).toContain("SKILL.md");
  expect(heading).toContain("read tool");
  expect(heading).toContain("before following");
  expect(catalog.split("\n").slice(1)).toEqual([
    "- first: " + "a".repeat(300) + " (/skills/first/SKILL.md)",
    "- second: Second skill (/skills/second/SKILL.md)",
  ]);
  expect(skillCatalog([], 100_000)).toBe("");
});

test("an oversized catalog shortens descriptions before dropping any skill", () => {
  const list = [
    { name: "first", description: "a".repeat(1000), path: "/a" },
    { name: "second", description: "b".repeat(1000), path: "/b" },
  ];
  const catalog = skillCatalog(list, 10_000);
  expect(catalog.length).toBeLessThanOrEqual(800);
  expect(catalog.split("\n").slice(1)).toEqual([
    "- first: " + "a".repeat(250) + " (/a)",
    "- second: " + "b".repeat(250) + " (/b)",
  ]);
  expect(list[0]?.description.length).toBe(1000);
});

test("catalogs drop skills from the end and count the omitted ones inside the budget", () => {
  const list = [
    { name: "first", description: "a".repeat(1000), path: "/a" },
    { name: "second", description: "b".repeat(1000), path: "/b" },
    { name: "third", description: "c".repeat(1000), path: "/c" },
  ];
  const catalog = skillCatalog(list, 5000);
  expect(catalog.length).toBeLessThanOrEqual(400);
  expect(catalog.split("\n").slice(1)).toEqual([
    "- first: " + "a".repeat(250) + " (/a)",
    "2 more skills available.",
  ]);
  const oversizedPath = skillCatalog([{ name: "large", description: "short", path: "/" + "p".repeat(1000) }], 5000);
  expect(oversizedPath.length).toBeLessThanOrEqual(400);
  expect(oversizedPath.split("\n").slice(1)).toEqual(["1 more skills available."]);
});

test("an undefined or zero context window gives the catalog an 8,000-character budget", () => {
  const list = Array.from({ length: 40 }, (_, index) => ({
    name: "skill-" + index, description: "d".repeat(1000), path: "/skills/" + index,
  }));
  for (const window of [undefined, 0]) {
    const catalog = skillCatalog(list, window);
    expect(catalog.length).toBeLessThanOrEqual(8000);
    expect(catalog.length).toBeGreaterThan(7500);
    expect(catalog).toContain("more skills available.");
    expect(catalog).not.toContain("d".repeat(251));
    expect(skillCatalog([{ name: "large", description: "d".repeat(7900), path: "/a" }], window)).toContain("d".repeat(7900));
  }
  expect(skillCatalog(list, undefined)).toBe(skillCatalog(list, 0));
});

test("the catalog keeps an exact-fit entry and respects fractional or very small budgets", () => {
  const list = [{ name: "one", description: "Description", path: "/a" }];
  const full = skillCatalog(list, undefined);
  const exactWindow = full.length * 12.5;
  expect(skillCatalog(list, exactWindow)).toBe(full);
  expect(skillCatalog(list, exactWindow - 1).length).toBeLessThanOrEqual(full.length - 1);
  expect(skillCatalog(list, 1).length).toBe(0);
});

test("instructionsText keeps file order and content, followed by the catalog", () => {
  const files = [{ path: "/global/AGENTS.md", content: "global\n" }, { path: "/project/CLAUDE.md", content: "local" }];
  expect(instructionsText(files, "catalog")).toBe("# /global/AGENTS.md\nglobal\n\n\n# /project/CLAUDE.md\nlocal\n\ncatalog");
  expect(instructionsText(files, "")).toBe("# /global/AGENTS.md\nglobal\n\n\n# /project/CLAUDE.md\nlocal");
  expect(instructionsText([], "catalog")).toBe("catalog");
  expect(instructionsText([], "")).toBe("");
});

test("a session sends the project's AGENTS.md and its skills to the model, after the engine's own prompt (#457)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-instructions-session-"));
  mkdirSync(join(cwd, ".git"));
  put(join(cwd, "AGENTS.md"), "Keep each change small.");
  put(join(cwd, ".agents", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release.\n---\nSteps.");
  const faux = fauxProvider();
  let prompt = "";
  faux.setResponses([scriptedReply({ seen: (context) => { prompt = context.systemPrompt ?? JSON.stringify(context.messages[0]); }, reply: "ok" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-core-instructions-sessions-")), models,
    model: faux.getModel(), verifier: accepts });
  try {
    await session.prompt("hello");
  } finally {
    await session.dispose();
  }
  expect(prompt).toContain("Keep each change small.");
  expect(prompt).toContain("release: Cut a release.");
  expect(prompt.indexOf("You are a coding agent")).toBeLessThan(prompt.indexOf("Keep each change small."));
});

test("a skill's frontmatter starts its file and ends at a --- from the first column, whatever its line endings (#457)", () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-core-instructions-frontmatter-"));
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-instructions-frontmatter-cwd-"));
  const skill = (name: string, content: string) => put(join(home, ".agents", "skills", name, "SKILL.md"), content);
  skill("block", "---\nname: block\ndescription: |\n  Before\n  ---\n  after\n---\nBody.");
  skill("windows", "﻿---\r\nname: windows\r\ndescription: Written on Windows.\r\n---\r\nBody.");
  skill("late", "Intro.\n---\nname: late\ndescription: Not frontmatter.\n---\n");
  const found = skills(cwd, { user: home, tesota: join(home, "none") });
  expect(found.map(({ name }) => name)).toEqual(["block", "windows"]);
  expect(found.find(({ name }) => name === "block")?.description).toBe("Before --- after");
  expect(found.find(({ name }) => name === "windows")?.description).toBe("Written on Windows.");
});

test("instruction files keep within 32 KiB together: a larger one is cut and the next left out, saying so (#457)", () => {
  const big = "a".repeat(40 * 1024);
  const text = instructionsText([{ path: "/repo/AGENTS.md", content: big }, { path: "/repo/sub/AGENTS.md", content: "later" }], "");
  expect(text).toContain(`[Tesota cut this file at ${32 * 1024} of its ${40 * 1024} characters.]`);
  expect(text).toContain("# /repo/sub/AGENTS.md\n[Tesota left this file out");
  expect(text).not.toContain("later");
});

test("a skill's frontmatter says who may start it: the model, the operator by name, or both (#540)", () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-core-instructions-invocation-"));
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-instructions-invocation-cwd-"));
  const skill = (name: string, fields: string) => put(join(home, ".agents", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n${fields}---\nBody.`);
  skill("both", "");
  skill("operator", "disable-model-invocation: true\n");
  skill("model", "user-invocable: false\n");
  skill("quoted", "disable-model-invocation: \"true\"\nuser-invocable: 'false'\n");
  skill("explicit", "disable-model-invocation: false\nuser-invocable: true\n");
  const found = skills(cwd, { user: home, tesota: join(home, "none") });
  const by = (name: string) => found.find((each) => each.name === name);
  expect(by("both")).toEqual({ name: "both", description: "both skill", path: join(home, ".agents", "skills", "both", "SKILL.md") });
  expect(by("explicit")).toEqual({ name: "explicit", description: "explicit skill", path: join(home, ".agents", "skills", "explicit", "SKILL.md") });
  expect(by("operator")?.disableModelInvocation).toBe(true);
  expect(by("model")?.userInvocable).toBe(false);
  expect(by("quoted")).toMatchObject({ disableModelInvocation: true, userInvocable: false });
  const catalog = skillCatalog(found, 100_000);
  expect(catalog).toContain("- both: both skill");
  expect(catalog).toContain("- model: model skill");
  expect(catalog).not.toContain("operator skill");
  expect(catalog).not.toContain("quoted skill");
  expect(skillCatalog(found.filter((each) => each.disableModelInvocation === true), 100_000)).toBe("");
});

test("the catalog counts only the skills the model may start when it drops some (#540)", () => {
  const list = [
    { name: "first", description: "a".repeat(1000), path: "/a" },
    { name: "hidden", description: "h".repeat(1000), path: "/h", disableModelInvocation: true as const },
    { name: "third", description: "c".repeat(1000), path: "/c" },
  ];
  expect(skillCatalog(list, 5000).split("\n").slice(1)).toEqual(["- first: " + "a".repeat(250) + " (/a)", "1 more skills available."]);
});

test("arguments take their places as Claude Code places them (#540)", () => {
  expect(withArguments("Fix $ARGUMENTS now.", "issue 12 fast")).toBe("Fix issue 12 fast now.");
  expect(withArguments("From $0 to $1, then $ARGUMENTS[0].", "\"hello world\" second")).toBe("From hello world to second, then hello world.");
  expect(withArguments("One: $0, missing: $2.", "only")).toBe("One: only, missing: $2.");
  expect(withArguments("Costs \\$1.00 for $0.", "you")).toBe("Costs $1.00 for you.");
  expect(withArguments("Kept \\\\$0.", "x")).toBe("Kept \\\\x.");
  expect(withArguments("Arguments are literal: $0.", "$1 $ARGUMENTS")).toBe("Arguments are literal: $1.");
  expect(withArguments("No placeholder.", "auth module")).toBe("No placeholder.\n\nARGUMENTS: auth module");
  expect(withArguments("Only $3 is named.", "a b")).toBe("Only $3 is named.\n\nARGUMENTS: a b");
  expect(withArguments("No placeholder.", "")).toBe("No placeholder.");
  expect(withArguments("Empty $ARGUMENTS.", "")).toBe("Empty .");
});

test("/name at the start of a request starts a skill the operator may start, on the rest of the line (#540)", () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-core-instructions-started-"));
  const folder = join(home, "skills");
  put(join(folder, "verify", "SKILL.md"), "---\nname: verify\ndescription: Verify.\ndisable-model-invocation: true\n---\n\n# Verify\n\nVerify $ARGUMENTS.\n");
  put(join(folder, "background", "SKILL.md"), "---\nname: background\ndescription: Background.\nuser-invocable: false\n---\nBody.");
  const list = skillsIn(folder);
  const path = join(folder, "verify", "SKILL.md");
  expect(startedSkill("/verify the parser", list)).toEqual({ name: "verify", path,
    instructions: `Base directory for this skill: ${join(folder, "verify")}\n\n# Verify\n\nVerify the parser.` });
  expect(startedSkill("  /verify\n  across lines  ", list)?.instructions).toEndWith("Verify across lines.");
  expect(startedSkill("/verify", list)?.instructions).toEndWith("Verify .");
  expect(startedSkill("/background now", list)).toBeUndefined();
  expect(startedSkill("/unknown now", list)).toBeUndefined();
  expect(startedSkill("please /verify the parser", list)).toBeUndefined();
  expect(startedSkill("/verifyx", list)).toBeUndefined();
  rmSync(path);
  expect(() => startedSkill("/verify it", list)).toThrow(`The skill verify could not be read from ${path}.`);
});

test("a started skill reaches the model after the request, never the ledger's request, and resumes and compacts with it (#540)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-instructions-run-"));
  mkdirSync(join(cwd, ".git"));
  const body = "# Formal verification\n\nVerify the area the operator named.";
  const folder = join(cwd, ".agents", "skills", "create-formal-verification-skill");
  put(join(folder, "SKILL.md"), "---\nname: create-formal-verification-skill\n"
    + `description: "Formally verify where a bug costs most."\ndisable-model-invocation: true\n---\n\n${body}\n`);
  const faux = fauxProvider();
  let prompt = "";
  let sent: unknown[] = [];
  faux.setResponses([scriptedReply({ seen: (context) => {
    prompt = context.systemPrompt ?? JSON.stringify(context.messages[0]);
    sent = context.messages.filter(({ role }) => role !== "system");
  }, reply: "done" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: (string | undefined)[] = [];
  const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-core-instructions-run-sessions-")), models,
    model: faux.getModel(),
    verifier: (pi, request) => { pi.on("agent_before_settle", () => { requests.push(request()?.text); return undefined; }); } });
  const typed = "/create-formal-verification-skill the session ledger";
  const instructions = `Base directory for this skill: ${folder}\n\n${body}\n\nARGUMENTS: the session ledger`;
  try {
    expect(session.skills().map(({ name }) => name)).toEqual(["create-formal-verification-skill"]);
    await session.prompt(typed);
  } finally {
    await session.dispose();
  }
  expect(prompt).not.toContain("create-formal-verification-skill");
  expect(sent).toEqual([
    expect.objectContaining({ role: "user", content: typed }),
    expect.objectContaining({ role: "user", content: instructions }),
  ]);
  expect(requests).toEqual([typed]);
  expect(session.ledger()).toMatchObject([{ run: 1, text: typed }]);
  expect(JSON.stringify(session.ledger())).not.toContain("Formal verification");
  expect(session.messages()).toEqual([
    { role: "user", text: typed },
    { role: "custom", customType: "tesota.skill", text: instructions },
    { role: "assistant", text: "done" },
  ]);
  const request = readFileSync(session.file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry["type"] === "request");
  expect(request).toMatchObject({ text: typed, skill: { name: "create-formal-verification-skill", path: join(folder, "SKILL.md"), instructions } });
  const resumed = openSession(session.file, { models, model: faux.getModel(), verifier: accepts });
  try {
    expect(resumed.messages().map(({ role, text }) => [role, text])).toEqual([["user", typed], ["custom", instructions], ["assistant", "done"]]);
  } finally {
    await resumed.dispose();
  }
  const asked = { role: "user" as const, content: typed, timestamp: 0 };
  const head = compactedHead([asked, skillMessage({ name: "s", path: "/s", instructions }, 0)], "summary", { read: [], changed: [] }, []);
  expect(head.content).toContain(`The operator's request, exactly as given:\n\n${typed}\n\nThe skill the operator started:\n\n${instructions}\n\n`);
});

test("a skill sent during a run waits as a follow-up, never steers, and its text stays out of the ledger (#540)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-instructions-queued-"));
  mkdirSync(join(cwd, ".git"));
  const folder = join(cwd, ".agents", "skills", "review");
  put(join(folder, "SKILL.md"), "---\nname: review\ndescription: Review.\ndisable-model-invocation: true\n---\nReview $ARGUMENTS closely.");
  const typed = "/review the parser";
  const instructions = `Base directory for this skill: ${folder}\n\nReview the parser closely.`;
  const faux = fauxProvider();
  const seen: string[][] = [];
  const look = (reply: string) => scriptedReply({ seen: (context) => {
    seen.push(context.messages.flatMap((message) => message.role === "user" && typeof message.content === "string" ? [message.content] : []));
  }, reply });
  faux.setResponses([scriptedReply({ tool: "probe", args: {} }), look("first"), look("reviewed")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const probe: EngineTool = { name: "probe", description: "Sends the operator's skill while the run goes.", parameters: Type.Object({}),
    execute: async () => { await session.prompt(typed, { streamingBehavior: "steer" }); return { text: "ok", isError: false }; } };
  const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-core-instructions-queued-sessions-")), models,
    model: faux.getModel(), verifier: accepts, tools: () => [probe] });
  try {
    await session.prompt("start");
  } finally {
    await session.dispose();
  }
  expect(seen).toEqual([["start"], ["start", typed, instructions]]);
  expect(session.ledger()).toMatchObject([{ text: "start", amendments: [{ behavior: "followUp", text: typed, delivered: true }] }]);
  expect(JSON.stringify(session.ledger())).not.toContain("closely");
  const resumed = openSession(session.file, { models, model: faux.getModel(), verifier: accepts });
  try {
    expect(resumed.messages().filter(({ role }) => role === "user" || role === "custom").map(({ text }) => text))
      .toEqual(["start", typed, instructions]);
  } finally {
    await resumed.dispose();
  }
});

test("a request that names no skill the operator may start, or comes from an extension, goes to the model as it is (#540)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tesota-core-instructions-plain-"));
  mkdirSync(join(cwd, ".git"));
  put(join(cwd, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review.\n---\nReview it.");
  put(join(cwd, ".agents", "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: Hidden.\nuser-invocable: false\n---\nHidden.");
  const faux = fauxProvider();
  const seen: number[] = [];
  faux.setResponses([1, 2, 3].map(() => scriptedReply({
    seen: (context) => { seen.push(context.messages.filter(({ role }) => role !== "system").length); }, reply: "ok" })));
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd, folder: mkdtempSync(join(tmpdir(), "tesota-core-instructions-plain-sessions-")), models,
    model: faux.getModel(), verifier: accepts });
  try {
    expect(session.skills().map(({ name }) => name)).toEqual(["review"]);
    await session.prompt("/hidden now");
    await session.prompt("/review", { source: "extension" });
    await session.prompt("/review");
  } finally {
    await session.dispose();
  }
  expect(seen).toEqual([1, 3, 6]);
  expect(session.messages().filter(({ role }) => role === "custom").map(({ text }) => text))
    .toEqual([`Base directory for this skill: ${join(cwd, ".agents", "skills", "review")}\n\nReview it.`]);
});
