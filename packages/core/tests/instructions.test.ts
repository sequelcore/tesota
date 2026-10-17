import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { contextFiles, instructionsText, skillCatalog, skills } from "../src/instructions.ts";
import { createSession } from "../src/session.ts";
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
