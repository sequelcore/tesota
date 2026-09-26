import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod";

/**
 * Which model each of Tesota's roles uses (decision 020), and through which
 * route (decision 021). The operator chooses; a role without a choice uses the
 * default. Model choice is operator configuration, kept in Tesota's own
 * directory, never in a repository.
 */

/**
 * How Tesota reaches a model: `codex` through Pi and the operator's ChatGPT
 * plan, `anthropic` through Pi and an Anthropic API key, and `claude-code`
 * through the operator's own Claude Code, which signs in by itself.
 */
export const MODEL_ROUTES = ["codex", "anthropic", "claude-code"] as const;
export type ModelRoute = typeof MODEL_ROUTES[number];

/** A role's model as `route:model`. */
export interface ModelChoice {
  readonly route: ModelRoute;
  readonly model: string;
}

/** Read `route:model`; undefined for anything else, including `off`. */
export function parseModelChoice(value: string): ModelChoice | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const route = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!(MODEL_ROUTES as readonly string[]).includes(route) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(model)) return undefined;
  return { route: route as ModelRoute, model };
}
export const MODEL_ROLES = ["agent", "explorer", "reviewer", "refuter", "validator"] as const;
export type ModelRole = typeof MODEL_ROLES[number];

export const ROLE_DESCRIPTIONS: Readonly<Record<ModelRole, string>> = {
  agent: "the working agent, which changes the workspace",
  explorer: "read-only explorers the agent starts",
  reviewer: "reviewers, focused lenses and ClaimCheck",
  refuter: "the refuter that tests every finding",
  validator: "the fix validator in correction rounds",
};

/** The model every role uses until the operator chooses another: the cheapest on the Codex route. */
export const DEFAULT_MODEL: string = "codex:gpt-6-luna";
/**
 * Explorers are off until the operator chooses a model for them: decision 019
 * turns them on by default only after its evaluation shows they help.
 */
export const EXPLORERS_OFF = "off";
const defaults: Readonly<Record<ModelRole, string>> = { agent: DEFAULT_MODEL, explorer: EXPLORERS_OFF,
  reviewer: DEFAULT_MODEL, refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL };
export const DEFAULT_MODELS_FILE: string = join(homedir(), ".tesota", "models.json");

export type ModelChoices = Readonly<Record<ModelRole, string>>;

const modelId = z.string().max(120).refine((value) => value === EXPLORERS_OFF || parseModelChoice(value) !== undefined);
const choicesSchema = z.strictObject({ agent: modelId.optional(), explorer: modelId.optional(),
  reviewer: modelId.optional(), refuter: modelId.optional(), validator: modelId.optional() });
type StoredChoices = z.infer<typeof choicesSchema>;

export function isModelRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

function stored(path: string): StoredChoices {
  if (!existsSync(path)) return {};
  const parsed = choicesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid model choice file; fix or delete it`);
  return parsed.data;
}

/** Each role's model: the operator's choice, or the default. */
export function readModelChoices(path: string = DEFAULT_MODELS_FILE): ModelChoices {
  const choices = stored(path);
  return Object.fromEntries(MODEL_ROLES.map((role) => [role, choices[role] ?? defaults[role]])) as Record<ModelRole, string>;
}

/**
 * Choose a role's model, as `route:model`, from the models the routes offer,
 * `default` to clear the choice, or `off` for explorers. The file is replaced
 * whole, so a failed write leaves the previous choices.
 */
export function chooseModel(role: ModelRole, model: string, available: readonly string[],
  path: string = DEFAULT_MODELS_FILE): ModelChoices {
  const choices: Record<string, string | undefined> = { ...stored(path) };
  if (model === "default") delete choices[role];
  else if (available.includes(model) || role === "explorer" && model === EXPLORERS_OFF) choices[role] = model;
  else throw new Error(`${model} is not offered; choose one of ${available.join(", ")}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(choicesSchema.parse(choices), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return readModelChoices(path);
}
