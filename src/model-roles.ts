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
 * The kinds of route, how Tesota reaches a model: `codex` through Pi and the operator's ChatGPT
 * plan, `anthropic` through Pi and an Anthropic API key, `claude-code`
 * through the operator's own Claude Code, which signs in by itself, and
 * through Pi the gateways of decision 031: `openrouter` with an OpenRouter
 * key, and OpenCode's `opencode` (Zen, pay as you go) and `opencode-go` (a
 * subscription) with one OpenCode key.
 */
export const ROUTE_KINDS = ["codex", "anthropic", "claude-code", "openrouter", "opencode", "opencode-go"] as const;
export type RouteKind = typeof ROUTE_KINDS[number];

/**
 * A route is a kind of route and one account behind it (decision 050). Each
 * kind's own name is its default route; the operator adds routes of a kind
 * under names of their own, one account each, such as `codex-work` for a
 * second ChatGPT account. The kind decides the engine, the models, who pays
 * and each model's lab; the route decides only the account. Accounts can be
 * added for the kinds signed in to a plan, whose accounts people hold several
 * of.
 */
export const ACCOUNT_KINDS: readonly RouteKind[] = ["codex", "claude-code"];

export interface AddedRoute {
  readonly name: string;
  readonly kind: RouteKind;
}

export const DEFAULT_ROUTES_FILE: string = join(homedir(), ".tesota", "routes.json");
/** A route's own name: lower-case words joined by hyphens, never a kind's name, `typesafe` or `off`. */
const ROUTE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const addedRouteSchema = z.strictObject({ name: z.string().max(40).regex(ROUTE_NAME)
  .refine((name) => !(ROUTE_KINDS as readonly string[]).includes(name) && !["typesafe", "off"].includes(name), "a reserved name"),
kind: z.enum(ROUTE_KINDS).refine((kind) => ACCOUNT_KINDS.includes(kind), "a kind without accounts") });
const routesSchema = z.strictObject({ routes: z.array(addedRouteSchema).max(50) });

/** The routes the operator added; none when there is no file. */
export function readAddedRoutes(path: string = DEFAULT_ROUTES_FILE): AddedRoute[] {
  if (!existsSync(path)) return [];
  const parsed = routesSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid route file; fix or delete it`);
  return parsed.data.routes;
}

function writeAddedRoutes(routes: readonly AddedRoute[], path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(routesSchema.parse({ routes }), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Add a route of a kind under a new name; the file is replaced whole. */
export function addRoute(name: string, kind: RouteKind, path: string = DEFAULT_ROUTES_FILE): AddedRoute[] {
  const routes = readAddedRoutes(path);
  if (routes.some((route) => route.name === name)) throw new Error(`${name} is already a route`);
  const added = addedRouteSchema.safeParse({ name, kind });
  if (!added.success) {
    throw new Error(ACCOUNT_KINDS.includes(kind) ? `${name} cannot name a route: use lower-case words joined by hyphens, ` +
      "and not a route kind's name" : `${kind} has one account; other accounts are added for ${ACCOUNT_KINDS.join(" and ")}`);
  }
  writeAddedRoutes([...routes, added.data], path);
  return readAddedRoutes(path);
}

/** Remove an added route; the file is replaced whole. */
export function removeRoute(name: string, path: string = DEFAULT_ROUTES_FILE): AddedRoute[] {
  writeAddedRoutes(readAddedRoutes(path).filter((route) => route.name !== name), path);
  return readAddedRoutes(path);
}

/** A route's kind: a kind's own name is its default route; an added route has the kind it was added with. */
export function routeKindOf(name: string, added: readonly AddedRoute[]): RouteKind | undefined {
  if ((ROUTE_KINDS as readonly string[]).includes(name)) return name as RouteKind;
  return added.find((route) => route.name === name)?.kind;
}

/**
 * Who pays for a route's model calls, and whether they are billed per token.
 * A plan counts them against its limits instead; Claude Code is paid through
 * whatever it is signed in with, usually a Claude plan, which Tesota does not
 * see.
 */
export const ROUTE_BILLING: Readonly<Record<RouteKind, Readonly<{ payer: string; metered: boolean }>>> = {
  codex: { payer: "your ChatGPT plan's limits", metered: false },
  anthropic: { payer: "your Anthropic API key", metered: true },
  "claude-code": { payer: "your Claude Code sign-in", metered: false },
  openrouter: { payer: "your OpenRouter credits", metered: true },
  opencode: { payer: "your OpenCode Zen balance", metered: true },
  "opencode-go": { payer: "your OpenCode Go subscription's limits", metered: false },
};

/** The engine that runs a route's models: Pi, or Claude Code through the Claude Agent SDK. */
export type ModelEngine = "pi" | "claude-code";
export const ROUTE_ENGINE: Readonly<Record<RouteKind, ModelEngine>> = { codex: "pi", anthropic: "pi", "claude-code": "claude-code",
  openrouter: "pi", opencode: "pi", "opencode-go": "pi" };

/**
 * The kinds whose provider searches the web itself, exercised live for the
 * searcher (issue #295): Codex's Responses `web_search` and Claude Code's
 * `WebSearch`. The Anthropic API's search has not been exercised.
 */
export const HOSTED_SEARCH_KINDS: readonly RouteKind[] = ["codex", "claude-code"];

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
  /** The route's name, which decides the account. */
  readonly route: string;
  /** Its kind, which decides the engine, the models, who pays and the lab. */
  readonly kind: RouteKind;
  readonly model: string;
  readonly reasoning?: ReasoningLevel;
}

/**
 * A model id on each route. OpenRouter names a model `vendor/model`, with an
 * optional `:variant` such as `:free`, and a `~` for an alias that follows a
 * family's newest model; the other routes use plain ids.
 */
const plainModel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const openRouterModel = /^~?[A-Za-z0-9][A-Za-z0-9._-]{0,49}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?(?::[A-Za-z0-9][A-Za-z0-9._-]{0,29})?$/u;

/**
 * Read `route:model` or `route:model@level`, where the route is a kind's own
 * name or one the operator added; undefined for anything else, including `off`.
 */
export function parseModelChoice(value: string, added: readonly AddedRoute[] = readAddedRoutes()): ModelChoice | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const route = value.slice(0, separator);
  const [model = "", level, ...rest] = value.slice(separator + 1).split("@");
  const kind = routeKindOf(route, added);
  if (kind === undefined) return undefined;
  if (!(kind === "openrouter" ? openRouterModel : plainModel).test(model)) return undefined;
  if (rest.length > 0 || level !== undefined && !isReasoningLevel(level)) return undefined;
  return { route, kind, model, ...(level === undefined ? {} : { reasoning: level as ReasoningLevel }) };
}
/**
 * A typed decision model, which answers a fixed question with a probability
 * rather than holding a conversation (decision 035): only the answer check's
 * first pass may use one. `typesafe` is TypeSafe's API, reached with the
 * operator's own TypeSafe key; its models are pinned to the versions qualified
 * on the first pass's registered cases, since a newer one may decide
 * differently.
 */
export const DECISION_MODELS = ["typesafe:jev-1.13.0"] as const;
export type DecisionModel = typeof DECISION_MODELS[number];

export function isDecisionModel(value: string): value is DecisionModel {
  return (DECISION_MODELS as readonly string[]).includes(value);
}

/**
 * The route whose account a role's choice draws on: the route it names, the
 * OpenCode route for an OpenCode Go model, since one key serves both, and
 * TypeSafe for the triage role's decision model; undefined when the role is off.
 */
export function accountRoute(choice: string, added: readonly AddedRoute[] = readAddedRoutes()): string | undefined {
  if (isDecisionModel(choice)) return "typesafe";
  const route = parseModelChoice(choice, added)?.route;
  return route === "opencode-go" ? "opencode" : route;
}

export const MODEL_ROLES = ["agent", "explorer", "advisor", "reviewer", "refuter", "validator", "triage", "namer", "searcher"] as const;
export type ModelRole = typeof MODEL_ROLES[number];

export const ROLE_DESCRIPTIONS: Readonly<Record<ModelRole, string>> = {
  agent: "the working agent, which changes the workspace",
  explorer: "read-only explorers the agent starts",
  advisor: "a stronger model the agent consults at hard decisions",
  reviewer: "reviewers, focused lenses and ClaimCheck",
  refuter: "the refuter that tests every finding",
  validator: "the fix validator in correction rounds",
  triage: "the first pass that decides whether an answer needs the full check",
  namer: "writes a short title for each new session from its first request",
  searcher: "searches the web for the agent and explorers with its provider's own search",
};

/** The model every role uses until the operator chooses another: the cheapest on the Codex route. */
export const DEFAULT_MODEL: string = "codex:gpt-6-luna";
/** Naming a session needs little reasoning, so its default reasons at low, as Codex's own titles do. */
export const DEFAULT_NAMER: string = `${DEFAULT_MODEL}@low`;
/**
 * Roles that can be off. The helpers the agent may call, explorers (decision
 * 019) and the advisor (decision 027), are off until the operator chooses a
 * model for them; each is turned on by default only after an evaluation shows
 * it helps. The answer check's first pass (decision 034) is on by default;
 * off, every turn that changes no files gets the full check. The namer
 * (decision 036) is on by default; off, a session keeps its first request,
 * shortened, as its name. The searcher (issue #295) is on by default; off,
 * only a SearXNG named in `~/.tesota/web.json` searches.
 */
export const ROLE_OFF = "off";
export const OPTIONAL_ROLES: readonly ModelRole[] = ["explorer", "advisor", "triage", "namer", "searcher"];
const defaults: Readonly<Record<ModelRole, string>> = { agent: DEFAULT_MODEL, explorer: ROLE_OFF, advisor: ROLE_OFF,
  reviewer: DEFAULT_MODEL, refuter: DEFAULT_MODEL, validator: DEFAULT_MODEL, triage: DEFAULT_MODEL, namer: DEFAULT_NAMER,
  searcher: DEFAULT_MODEL };
export const DEFAULT_MODELS_FILE: string = join(homedir(), ".tesota", "models.json");

export type ModelChoices = Readonly<Record<ModelRole, string>>;

const modelId = z.string().max(120).refine((value) => value === ROLE_OFF || parseModelChoice(value) !== undefined);
const triageId = z.string().max(120).refine((value) => value === ROLE_OFF || isDecisionModel(value) || parseModelChoice(value) !== undefined);
const choicesSchema = z.strictObject({ agent: modelId.optional(), explorer: modelId.optional(), advisor: modelId.optional(),
  reviewer: modelId.optional(), refuter: modelId.optional(), validator: modelId.optional(), triage: triageId.optional(),
  namer: modelId.optional(), searcher: modelId.optional() });
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
  const kind = parseModelChoice(model)?.kind;
  if (role === "searcher" && kind !== undefined && !HOSTED_SEARCH_KINDS.includes(kind)) {
    throw new Error(`The searcher uses its provider's own search, which ${HOSTED_SEARCH_KINDS.join(" and ")} routes have`);
  }
  if (model === "default") delete choices[role];
  else if (available.includes(model) && (!isDecisionModel(model) || role === "triage") ||
    OPTIONAL_ROLES.includes(role) && model === ROLE_OFF) choices[role] = model;
  else if (isDecisionModel(model)) throw new Error(`${model} answers only the answer check's first pass; choose it for triage`);
  else throw new Error(`${model} is not offered; tesota models lists the models and the reasoning levels each supports`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(choicesSchema.parse(choices), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return readModelChoices(path);
}
