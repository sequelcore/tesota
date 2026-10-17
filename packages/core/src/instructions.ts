import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { catalogBudget } from "./catalog-rule.ts";

/** An instruction file included in the session's system prompt (#457). */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
}

function projectFolders(cwd: string): string[] {
  const folder = resolve(cwd);
  const folders: string[] = [];
  for (let at = folder; ; at = dirname(at)) {
    folders.push(at);
    if (existsSync(join(at, ".git"))) return folders;
    if (dirname(at) === at) return [folder];
  }
}

function readText(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    return content.trim() === "" ? undefined : content;
  } catch {
    return undefined;
  }
}

/** Global instructions first, then each project's instructions from its Git root to cwd. */
export function contextFiles(cwd: string, home: string = tesotaHome()): ContextFile[] {
  const paths = [join(resolve(home), "AGENTS.md")];
  for (const folder of projectFolders(cwd).reverse()) {
    const agents = join(folder, "AGENTS.md");
    paths.push(existsSync(agents) ? agents : join(folder, "CLAUDE.md"));
  }
  const files: ContextFile[] = [];
  for (const path of paths) {
    const content = readText(path);
    if (content !== undefined) files.push({ path, content });
  }
  return files;
}

/** A skill's catalog entry; its instructions stay in SKILL.md until the agent reads it. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function skillMetadata(content: string): { readonly name: string; readonly description: string } | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "---");
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.trim() === "---");
  if (end < 0) return undefined;
  let name = "";
  let description = "";
  let inDescription = false;
  for (const line of lines.slice(start + 1, end)) {
    if (inDescription && /^\s+\S/.test(line)) {
      description += " " + line.trim();
      continue;
    }
    if (line.trim() === "") continue;
    inDescription = false;
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (field === null) continue;
    const value = (field[2] ?? "").trim();
    if (field[1] === "name") name = unquote(value);
    else {
      description = /^[>|][+-]?$/.test(value) ? "" : value;
      inDescription = true;
    }
  }
  description = unquote(description);
  return description === "" ? undefined : { name, description };
}

function skillsIn(folder: string): Skill[] {
  const found: Skill[] = [];
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(folder, entry.name, "SKILL.md");
    const content = readText(path);
    const metadata = content === undefined ? undefined : skillMetadata(content);
    if (metadata !== undefined) found.push({ name: metadata.name || entry.name, description: metadata.description, path });
  }
  return found;
}

/** User and project skills, with Tesota and then nearer project folders taking precedence by name. */
export function skills(cwd: string, homes: { readonly user: string; readonly tesota: string } = {
  user: homedir(), tesota: tesotaHome(),
}): Skill[] {
  const folders = [join(resolve(homes.user), ".agents", "skills"), join(resolve(homes.tesota), "skills"),
    ...projectFolders(cwd).reverse().map((folder) => join(folder, ".agents", "skills"))];
  const byName = new Map<string, Skill>();
  for (const folder of folders) {
    for (const skill of skillsIn(folder)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const catalogHeading = "Available skills: read each skill's SKILL.md with the read tool before following it.";

/** The available skills, with instructions to read each one before using it, within the context budget. */
export function skillCatalog(list: readonly Skill[], contextWindow: number | undefined): string {
  if (list.length === 0) return "";
  const budget = catalogBudget(Math.max(0, Math.floor(contextWindow ?? 0)));
  const render = (limit: number): string[] => list.map((skill) => "- " + skill.name + ": "
    + skill.description.slice(0, limit) + " (" + skill.path + ")");
  let lines = render(Infinity);
  let catalog = [catalogHeading, ...lines].join("\n");
  if (catalog.length <= budget) return catalog;
  lines = render(250);
  catalog = [catalogHeading, ...lines].join("\n");
  if (catalog.length <= budget) return catalog;
  while (lines.length > 0) {
    lines.pop();
    const more = list.length - lines.length;
    catalog = [catalogHeading, ...lines, more + " more skills available."].join("\n");
    if (catalog.length <= budget) return catalog;
  }
  return "";
}

/** Instruction files in their supplied order, each named by path, followed by the skill catalog. */
export function instructionsText(files: readonly ContextFile[], catalog: string): string {
  const sections = files.map((file) => "# " + file.path + "\n" + file.content);
  if (catalog !== "") sections.push(catalog);
  return sections.join("\n\n");
}
