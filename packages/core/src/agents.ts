import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { catalog, frontmatter, frontmatterFields, projectFolders, readText } from "./instructions.ts";

/**
 * An agent type (#525): a Markdown file in an agents folder, in Claude
 * Code's format. Its body joins the instructions of a child started with it.
 */
export interface AgentType {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  /** The model it runs on, as `provider/id`; a Claude Code alias such as `sonnet` or `inherit` leaves it to the call or the parent. */
  readonly model?: string;
  /** A model it names that Tesota does not run (#568): its `model` when not `provider/id`, or other tools' keys such as `claude.model`. */
  readonly unusedModel?: string;
  /** `writes: true`: it changes files, in a worktree of its own. */
  readonly writes?: true;
  /** `background: false`: the call waits for it; Claude Code's `background` and pstack's `is_background` both say so. */
  readonly background?: false;
  readonly instructions: string;
}

/** The agent types in `folder`: each Markdown file in it with a description, named by its `name` or its file. */
export function agentTypesIn(folder: string): AgentType[] {
  let names: string[];
  try { names = readdirSync(folder).filter((name) => name.endsWith(".md")); } catch { return []; }
  return names.flatMap((name) => {
    const path = join(folder, name);
    const content = readText(path);
    const read = content === undefined ? undefined
      : frontmatterFields(content, ["name", "description", "model", "writes", "background", "is_background"]);
    const description = read?.fields.get("description") ?? "";
    if (read === undefined || description === "") return [];
    const { fields } = read;
    const model = fields.get("model") ?? "";
    const found = frontmatter(content ?? "");
    const others = (found?.lines.slice(1, found.end) ?? []).flatMap((line) => /^([\w-]+\.model):\s*\S/u.exec(line)?.[1] ?? []);
    const unusedModel = model.includes("/") || model === "inherit" ? undefined
      : model !== "" ? `model: ${model}` : others.length > 0 ? others.join(", ") : undefined;
    const background = fields.get("background") ?? fields.get("is_background");
    return [{ name: fields.get("name") || basename(name, ".md"), description, path, instructions: read.body,
      ...model.includes("/") ? { model } : {}, ...unusedModel === undefined ? {} : { unusedModel },
      ...fields.get("writes") === "true" ? { writes: true } : {},
      ...background === "false" ? { background: false } : {} }];
  });
}

/** The operator's and the project's agent types, Tesota's then nearer project folders taking precedence by name, as skills do. */
export function agentTypes(cwd: string, homes: { readonly user: string; readonly tesota: string } = {
  user: homedir(), tesota: tesotaHome(),
}): AgentType[] {
  const folders = [join(resolve(homes.user), ".agents", "agents"), join(resolve(homes.tesota), "agents"),
    ...projectFolders(cwd).reverse().map((folder) => join(folder, ".agents", "agents"))];
  const byName = new Map<string, AgentType>();
  for (const folder of folders) {
    for (const type of agentTypesIn(folder)) byName.set(type.name, type);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The agent types the model may start, listed like the skill catalog and within the same budget. */
export function agentCatalog(types: readonly AgentType[], contextWindow: number | undefined): string {
  return catalog("Agent types, by name for `type`:", types.map(({ name, description, writes }) =>
    ({ name, description, after: writes === true ? " (writes)" : "" })), "agent types", contextWindow);
}

/**
 * What the operator is told once of the types whose model Tesota does not
 * run (#568): they run on `model`, the session's, unless the call names one;
 * none when every type's model is usable.
 */
export function unusedModels(types: readonly AgentType[], model: string): string | undefined {
  const named = types.flatMap(({ name, unusedModel }) => unusedModel === undefined ? [] : [`${name} (${unusedModel})`]);
  if (named.length === 0) return undefined;
  return `Agent type${named.length === 1 ? "" : "s"} ${named.join(", ")} run${named.length === 1 ? "s" : ""} on the session's model, ${model}, `
    + "unless the call names one: Tesota takes a type's model only as provider/id.";
}
