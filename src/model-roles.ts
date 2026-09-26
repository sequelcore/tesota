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

/**
 * Who pays for a route's model calls, and whether they are billed per token.
 * A plan counts them against its limits instead; Claude Code is paid through
 * whatever it is signed in with, usually a Claude plan, which Tesota does not
 * see.
 */
export const ROUTE_BILLING: Readonly<Record<ModelRoute, Readonly<{ payer: string; metered: boolean }>>> = {
  codex: { payer: "your ChatGPT plan's limits", metered: false },
  anthropic: { payer: "your Anthropic API key", metered: true },
  "claude-code": { payer: "your Claude Code sign-in", metered: false },
};

/** The engine that runs a route's models: Pi, or Claude Code through the Claude Agent SDK. */
export type ModelEngine = "pi" | "claude-code";
export const ROUTE_ENGINE: Readonly<Record<ModelRoute, ModelEngine>> = { codex: "pi", anthropic: "pi", "claude-code": "claude-code" };

/**
 * How much a model reasons (decision 029): the effort levels both engines
 * share. Pi calls it the thinking level, Claude Code the effort.
 */
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/** A role's model as `route:model`, with an optional `@level`; without one, the engine's default applies. */
export interface ModelChoice {
  readonly route: ModelRoute;
  readonly model: string;
  readonly reasoning?: ReasoningLevel;
}

/** Read `route:model` or `route:model@level`; undefined for anything else, including `off`. */
export function parseModelChoice(value: string): ModelChoice | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const route = value.slice(0, separator);
  const [model = "", level, ...rest] = value.slice(separator + 1).split("@");
  if (!(MODEL_ROUTES as readonly string[]).includes(route) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(model)) return undefined;
  if (rest.length > 0 || level !== undefined && !isReasoningLevel(level)) return undefined;
  return { route: route as ModelRoute, model, ...(level === undefined ? {} : { reasoning: level as ReasoningLevel }) };
}
export const MODEL_ROLES = ["agent", "explorer", "advisor", "reviewer", "refuter", "validator"] as const;
export type ModelRole = typeof MODEL_ROLES[number];

export const ROLE_DESCRIPTIONS: Readonly<Record<ModelRole, string>> = {
  agent: "the working agent, which changes the workspace",
  explorer: "read-only explorers the agent starts",
  advisor: "a stronger model the agent consults at hard decisions",
  reviewer: "reviewers, focused lenses and ClaimCheck",
  refuter: "the refuter that tests every finding",
  validator: "the fix validator in correction rounds",
};

/** The model every role uses until the operator chooses another: the cheapest on the Codex route. */
export const DEFAULT_MODEL: string = "codex:gpt-6-luna";
/**
 * The helpers the agent may call, explorers (decision 019) and the advisor
 * (decision 027), are off until the operator chooses a model for them; each
 * is turned on by default only after an evaluation shows it helps.
 */
export const ROLE_OFF = "off";
export const OPTIONAL_ROLES: readonly ModelRole[] = ["explorer", "advisor"];
const defaults: Readonly<Record<ModelRole, string>> = { agent: DEFAULT_MODEL, explorer: ROLE_OFF, advisor: ROLE_OFF,
  reviewer: DEFAULT_MODEL, refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL };
export const DEFAULT_MODELS_FILE: string = join(homedir(), ".tesota", "models.json");

export type ModelChoices = Readonly<Record<ModelRole, string>>;

const modelId = z.string().max(120).refine((value) => value === ROLE_OFF || parseModelChoice(value) !== undefined);
const choicesSchema = z.strictObject({ agent: modelId.optional(), explorer: modelId.optional(), advisor: modelId.optional(),
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
 * `default` to clear the choice, or `off` for explorers and the advisor. The file is replaced
 * whole, so a failed write leaves the previous choices.
 */
export function chooseModel(role: ModelRole, model: string, available: readonly string[],
  path: string = DEFAULT_MODELS_FILE): ModelChoices {
  const choices: Record<string, string | undefined> = { ...stored(path) };
  if (model === "default") delete choices[role];
  else if (available.includes(model) || OPTIONAL_ROLES.includes(role) && model === ROLE_OFF) choices[role] = model;
  else throw new Error(`${model} is not offered; tesota models lists the models and the reasoning levels each supports`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(choicesSchema.parse(choices), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return readModelChoices(path);
}
