import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { catalogBudget, kept } from "./catalog-rule.ts";
import { mayStart } from "./invocation-rule.ts";

/** The characters every instruction file may take together, as Codex allows its project files (#457). */
const instructionsBudget = 32 * 1024;

/** An instruction file included in the session's system prompt (#457). */
export interface ContextFile {
  readonly path: string;
  readonly content: string;
}

/** The folders from `cwd` up to its Git root, nearest first; `cwd` alone outside Git. */
export function projectFolders(cwd: string): string[] {
  const folder = resolve(cwd);
  const folders: string[] = [];
  for (let at = folder; ; at = dirname(at)) {
    folders.push(at);
    if (existsSync(join(at, ".git"))) return folders;
    if (dirname(at) === at) return [folder];
  }
}

export function readText(path: string): string | undefined {
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

/** A skill's catalog entry; its instructions stay in SKILL.md until the agent reads it or the operator starts it. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  /** `disable-model-invocation: true`: only the operator starts it, by name, so the model's catalog leaves it out (#540). */
  readonly disableModelInvocation?: true;
  /** `user-invocable: false`: only the model starts it, so the `/` menu and `/name` leave it out (#540). */
  readonly userInvocable?: false;
}

type SkillMetadata = Pick<Skill, "name" | "description" | "disableModelInvocation" | "userInvocable">;

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

/** A line that opens or closes frontmatter: `---` from the first column; indented, it belongs to a value (#457). */
const delimiter = (line: string): boolean => line.trimEnd() === "---";

/** The lines of a SKILL.md and where its frontmatter closes; none when it has no frontmatter. */
function frontmatter(content: string): { readonly lines: string[]; readonly end: number } | undefined {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/);
  if (!delimiter(lines[0] ?? "")) return undefined;
  const end = lines.findIndex((line, index) => index > 0 && delimiter(line));
  return end < 0 ? undefined : { lines, end };
}

/**
 * A Markdown file's frontmatter fields among `names`, unquoted, and its body
 * after it; none when it has no frontmatter. A description may go on over
 * indented lines, folded or not, as Agent Skills write it (#457).
 */
export function frontmatterFields(content: string, names: readonly string[]):
  { readonly fields: ReadonlyMap<string, string>; readonly body: string } | undefined {
  const found = frontmatter(content);
  if (found === undefined) return undefined;
  const fields = new Map<string, string>();
  let description = "";
  let inDescription = false;
  for (const line of found.lines.slice(1, found.end)) {
    if (inDescription && /^\s+\S/.test(line)) {
      description += " " + line.trim();
      continue;
    }
    if (line.trim() === "") continue;
    inDescription = false;
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    const name = field?.[1] ?? "";
    if (field === null || !names.includes(name)) continue;
    const value = (field[2] ?? "").trim();
    if (name !== "description") fields.set(name, unquote(value));
    else {
      description = /^[>|][+-]?$/.test(value) ? "" : value;
      inDescription = true;
    }
  }
  if (names.includes("description")) fields.set("description", unquote(description));
  return { fields, body: found.lines.slice(found.end + 1).join("\n").trim() };
}

function skillMetadata(content: string): SkillMetadata | undefined {
  const fields = frontmatterFields(content, ["name", "description", "disable-model-invocation", "user-invocable"])?.fields;
  const description = fields?.get("description") ?? "";
  if (fields === undefined || description === "") return undefined;
  return { name: fields.get("name") ?? "", description,
    ...fields.get("disable-model-invocation") === "true" ? { disableModelInvocation: true } : {},
    ...fields.get("user-invocable") === "false" ? { userInvocable: false } : {} };
}

/** The skills in `folder`: each subfolder with a SKILL.md that has a description. */
export function skillsIn(folder: string): Skill[] {
  const found: Skill[] = [];
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(folder, entry.name, "SKILL.md");
    const content = readText(path);
    const metadata = content === undefined ? undefined : skillMetadata(content);
    if (metadata !== undefined) found.push({ ...metadata, name: metadata.name || entry.name, path });
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

/** Whether `by` may start `skill` (#540), as the proved rule decides from its frontmatter. */
export const startable = (skill: Skill, by: "model" | "operator"): boolean =>
  mayStart(by === "model", skill.disableModelInvocation === true, skill.userInvocable !== false);

/** A skill the operator started by name (#540): only the model reads its instructions; the request is the line the operator typed. */
export interface StartedSkill {
  readonly name: string;
  readonly path: string;
  /** Its SKILL.md after the frontmatter, with the operator's arguments in place. */
  readonly instructions: string;
}

/** The operator's arguments, split as a shell splits them: quotes keep words together. */
function splitArguments(typed: string): string[] {
  return [...typed.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * A skill's instructions with the operator's arguments in place, as Claude
 * Code places them: `$ARGUMENTS` is all of them as typed, `$ARGUMENTS[N]`
 * and `$N` the Nth from 0, and one not given stays as written. A
 * backslash keeps a dollar sign literal; arguments no placeholder took are
 * appended as `ARGUMENTS:`.
 */
export function withArguments(body: string, typed: string): string {
  const parts = splitArguments(typed);
  let took = false;
  const placed = body.replace(/(\\*)\$(?:ARGUMENTS\[(\d+)\]|ARGUMENTS|(\d+))/gu,
    (match: string, slashes: string, indexed: string | undefined, short: string | undefined) => {
      if (slashes.length % 2 === 1) return match.slice(1);
      const index = indexed ?? short;
      const value = index === undefined ? typed : parts[Number(index)];
      if (value === undefined) return match;
      took = true;
      return slashes + value;
    });
  return took || typed === "" ? placed : `${placed}\n\nARGUMENTS: ${typed}`;
}

/**
 * The skill `text` starts when it begins with `/name` of one the operator
 * may start, on the rest of the line as its arguments (#540); none when it
 * names no such skill. A skill whose file can no longer be read is an error.
 */
export function startedSkill(text: string, list: readonly Skill[]): StartedSkill | undefined {
  const typed = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  const skill = typed === null ? undefined : list.find((each) => each.name === typed[1] && startable(each, "operator"));
  if (typed === null || skill === undefined) return undefined;
  const content = readText(skill.path);
  const body = content === undefined ? undefined : frontmatterFields(content, [])?.body;
  if (body === undefined) throw new Error(`The skill ${skill.name} could not be read from ${skill.path}.`);
  return { name: skill.name, path: skill.path,
    instructions: `Base directory for this skill: ${dirname(skill.path)}\n\n${withArguments(body, (typed[2] ?? "").trim())}` };
}

const catalogHeading = "Available skills: read each skill's SKILL.md with the read tool before following it.";

/**
 * The skills the model may start, with instructions to read each one before
 * using it, within the context budget; one only the operator starts is left
 * out (#540).
 */
export function skillCatalog(skills: readonly Skill[], contextWindow: number | undefined): string {
  return catalog(catalogHeading, skills.filter((skill) => startable(skill, "model"))
    .map(({ name, description, path }) => ({ name, description, after: ` (${path})` })), "skills", contextWindow);
}

/**
 * A catalog of `entries` under `heading` within the context budget, as the
 * skill catalog (#457) and the agent types (#525) are listed: whole, then
 * each description cut to 250 characters, then the last entries left out
 * and counted as more `kind` available; empty when there are none.
 */
export function catalog(heading: string, entries: readonly { readonly name: string; readonly description: string; readonly after: string }[],
  kind: string, contextWindow: number | undefined): string {
  if (entries.length === 0) return "";
  const budget = catalogBudget(Math.max(0, Math.floor(contextWindow ?? 0)));
  const render = (limit: number): string[] => entries.map((entry) => "- " + entry.name + ": "
    + entry.description.slice(0, limit) + entry.after);
  let lines = render(Infinity);
  let text = [heading, ...lines].join("\n");
  if (text.length <= budget) return text;
  lines = render(250);
  text = [heading, ...lines].join("\n");
  if (text.length <= budget) return text;
  while (lines.length > 0) {
    lines.pop();
    const more = entries.length - lines.length;
    text = [heading, ...lines, more + " more " + kind + " available."].join("\n");
    if (text.length <= budget) return text;
  }
  return "";
}

/**
 * Instruction files in their supplied order, each named by path, followed by
 * the skill catalog. The files keep within 32 KiB together, as Codex keeps
 * its own (`kept`): one that would pass it is cut, and the prompt says so,
 * since a file larger than the model's window would fail every request.
 */
export function instructionsText(files: readonly ContextFile[], catalog: string): string {
  let used = 0;
  const sections = files.flatMap((file) => {
    const keep = kept(used, file.content.length, instructionsBudget);
    used += keep;
    if (keep === 0) return [`# ${file.path}\n[Tesota left this file out: the instruction files already fill their ${instructionsBudget} characters.]`];
    if (keep === file.content.length) return [`# ${file.path}\n${file.content}`];
    return [`# ${file.path}\n${file.content.slice(0, keep)}\n[Tesota cut this file at ${keep} of its ${file.content.length} characters.]`];
  });
  if (catalog !== "") sections.push(catalog);
  return sections.join("\n\n");
}
