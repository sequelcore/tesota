import { type Api, createModels, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { describeJudgeWarnings, judgeWarnings } from "./judge-warnings.js";
import { planServes } from "./verification/codex-plan-rule.js";
import { type RouteAccount, sharedRoleGroups, sharedRoleNote } from "./route-accounts.js";
import type { ModelPickerData } from "./tesota-shell-model-picker.js";
import { accountRoute, HOSTED_SEARCH_KINDS, type ModelChoices, chooseModel, DECISION_MODELS, isDecisionModel, isReasoningLevel, OPTIONAL_ROLES, type ReasoningLevel, ROLE_OFF, DEFAULT_MODELS_FILE, isModelRole, MODEL_ROLES,
  type AddedRoute, ROUTE_KINDS, type ModelRole, type RouteKind, parseModelChoice, readAddedRoutes, readModelChoices, ROLE_DESCRIPTIONS,
  ROUTE_BILLING } from "./model-roles.js";

/**
 * A model a route offers, as `route:model`, with the catalogue's list price
 * in dollars per million tokens when the catalogue has one. Who pays is the
 * route's (`ROUTE_BILLING`): a list price is what an API key is billed, and
 * on a plan only a way to compare models.
 */
export interface OfferedModel {
  readonly id: string;
  /** The route's name: a kind's own, or one the operator added for another account (decision 050). */
  readonly route: string;
  readonly kind: RouteKind;
  readonly name: string;
  readonly listPrice?: { readonly input: number; readonly output: number };
  /** The reasoning levels the model accepts on its route (decision 029); empty when it takes none. */
  readonly reasoning: readonly ReasoningLevel[];
  /** Free to use on its gateway (decision 031), usually because its provider may keep what it is sent. */
  readonly free?: true;
}

/**
 * OpenRouter's own routers choose a model for each request and bill that
 * model; `openrouter/free` chooses among the free ones.
 */
function isOpenRouterRouter(model: string): boolean {
  return model === "auto" || model.startsWith("openrouter/") && model !== "openrouter/free";
}

/**
 * Whether a gateway model's provider may keep what Tesota sends it, the
 * repository's code included, and use it for training (decision 031):
 * OpenRouter's free models, whose providers may log and train, and Meta's
 * "contributor" Muse Spark models on Zen and Go, which train on it by their
 * terms. Paid models on these gateways do not, by their stated policies.
 */
export function dataNotice(choice: string): string | undefined {
  const parsed = parseModelChoice(choice);
  if (parsed === undefined) return undefined;
  const { kind, model } = parsed;
  const free = kind === "openrouter" && (model.endsWith(":free") || model === "openrouter/free");
  const contributor = (kind === "opencode" || kind === "opencode-go") && model.includes("-contributor");
  if (!free && !contributor) return undefined;
  return "its provider may keep your prompts and code, and use them to train models";
}

/**
 * Every choice the routes offer: each model, and each model at each reasoning
 * level it accepts; the answer check's first pass may also use a typed
 * decision model (decision 035).
 */
export function offeredChoices(offered: readonly OfferedModel[], role?: ModelRole): string[] {
  return [...offered.flatMap((model) => [model.id, ...model.reasoning.map((level) => `${model.id}@${level}`)]),
    ...role === "triage" ? DECISION_MODELS : []];
}

/** What a typed decision model costs, and what it is sent. */
export const DECISION_COST = "your TypeSafe key, about 340 tokens a decision; TypeSafe receives the requests and the reply";

function levels(model: Model<Api>): ReasoningLevel[] {
  return getSupportedThinkingLevels(model).filter(isReasoningLevel);
}

/**
 * Claude Code's effort reaches only models Pi maps to effort levels; older
 * models, such as Haiku 4.5, take a thinking budget instead, which Tesota
 * does not set.
 */
function effortLevels(model: Model<Api>): ReasoningLevel[] {
  return model.thinkingLevelMap === undefined ? [] : levels(model);
}

/** The version numbers in a model id, without a trailing date, for finding a family's newest model. */
function version(id: string): number[] {
  return [...id.matchAll(/\d+/gu)].map((match) => Number(match[0])).filter((part) => part < 10_000_000);
}

function newer(first: readonly number[], second: readonly number[]): boolean {
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const [a = 0, b = 0] = [first[index], second[index]];
    if (a !== b) return a > b;
  }
  return false;
}

/** The newest catalogue model of a Claude family, which Claude Code's alias follows. */
function newestOf(family: string, models: readonly Model<Api>[]): Model<Api> | undefined {
  return models.filter((model) => model.id.startsWith(`claude-${family}-`))
    .reduce<Model<Api> | undefined>((best, model) => best === undefined || newer(version(model.id), version(best.id)) ? model : best, undefined);
}

/** Claude Code's own aliases, which follow the newest model of each family. */
const claudeCodeAliases = ["opus", "sonnet", "fable", "haiku"] as const;

/** A gateway model at no price: free, unless it is a router whose price is the model it picks. */
function gatewayModel(route: RouteKind, model: Model<Api>): OfferedModel {
  const offered: OfferedModel = { id: `${route}:${model.id}`, route, kind: route, name: model.name, reasoning: levels(model) };
  if (route === "openrouter" && isOpenRouterRouter(model.id)) return offered;
  const listPrice = { input: model.cost.input, output: model.cost.output };
  return listPrice.input === 0 && listPrice.output === 0 ? { ...offered, listPrice, free: true } : { ...offered, listPrice };
}

/**
 * Every route's models, from Pi's catalogues and Claude Code's aliases; no
 * login is needed to list them. An added route offers its kind's models
 * under its own name.
 */
export function offeredModels(added: readonly AddedRoute[] = readAddedRoutes()): OfferedModel[] {
  const models = createModels();
  for (const provider of [openaiCodexProvider(), anthropicProvider(), openrouterProvider(), opencodeProvider(), opencodeGoProvider()]) {
    models.setProvider(provider);
  }
  const priced = (route: RouteKind, provider: string, accepted: (model: Model<Api>) => ReasoningLevel[]): OfferedModel[] =>
    models.getModels(provider).map((model) => ({ id: `${route}:${model.id}`, route, kind: route, name: model.name,
      listPrice: { input: model.cost.input, output: model.cost.output }, reasoning: accepted(model) }));
  // OpenRouter's `:batch` variants answer within a day through its Batch API, too late for any role. Zen's free
  // models answer only OpenCode's own client: any other gets 403 "OpenCode's free tier can only be used from within
  // OpenCode" (observed 2026-09-26; not in Zen's documentation).
  const gateway = (route: RouteKind, provider: string): OfferedModel[] => models.getModels(provider)
    .filter((model) => !model.id.endsWith(":batch")).map((model) => gatewayModel(route, model))
    .filter((model) => !(route === "opencode" && model.free === true));
  const claude = models.getModels("anthropic");
  const aliases = claudeCodeAliases.map((alias): OfferedModel => {
    const newest = newestOf(alias, claude);
    return { id: `claude-code:${alias}`, route: "claude-code", kind: "claude-code", name: `Claude Code's ${alias}`,
      reasoning: newest === undefined ? [] : effortLevels(newest) };
  });
  const kinds = [...priced("codex", "openai-codex", levels), ...priced("anthropic", "anthropic", levels), ...aliases,
    ...priced("claude-code", "anthropic", effortLevels), ...gateway("openrouter", "openrouter"), ...gateway("opencode", "opencode"),
    ...gateway("opencode-go", "opencode-go")];
  const accounts = added.flatMap((route) => kinds.filter((model) => model.route === route.kind)
    .map((model) => ({ ...model, id: `${route.name}:${model.id.slice(route.kind.length + 1)}`, route: route.name })));
  return [...kinds, ...accounts];
}

/**
 * Codex's models a free ChatGPT plan does not serve: each request fails at
 * once with "The '<model>' model is not supported when using Codex with a
 * ChatGPT account", observed on 2026-10-02 on free accounts while a Plus
 * account served the same models (#296).
 */
export const CODEX_FREE_REFUSED: readonly string[] = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"];

/** Why a choice's route does not serve its model on the route's plan, or undefined when it does or the plan is unknown. */
export function planRefusal(choice: string, accounts: RouteAccounts, added: readonly AddedRoute[] = readAddedRoutes()): string | undefined {
  const parsed = parseModelChoice(choice, added);
  if (parsed?.kind !== "codex") return undefined;
  const plan = accounts.find((entry) => entry.route === parsed.route)?.account?.plan;
  if (planServes(plan === "free", CODEX_FREE_REFUSED.includes(parsed.model))) return undefined;
  return `${parsed.route} is signed in to a free ChatGPT plan, on which Codex does not serve ${parsed.model}`;
}

/** The offered models each route's plan serves (#296); with no accounts read, every model. */
export function servedModels(offered: readonly OfferedModel[], accounts: RouteAccounts,
  added: readonly AddedRoute[] = readAddedRoutes()): OfferedModel[] {
  return offered.filter((model) => planRefusal(model.id, accounts, added) === undefined);
}

const gatewayNames: Partial<Record<RouteKind, string>> = { openrouter: "OpenRouter", opencode: "OpenCode Zen", "opencode-go": "OpenCode Go" };

/** Who pays for a model, and its list price: what an API key is billed, or on a plan a way to compare models. */
export function modelCost(model: OfferedModel | undefined): string {
  if (model === undefined) return "not offered";
  const billing = ROUTE_BILLING[model.kind];
  // An added route is paid by its own account, named after the route.
  const payer = model.route === model.kind ? billing.payer : `${billing.payer} (${model.route})`;
  if (model.free === true) {
    const notice = dataNotice(model.id);
    return `free on ${gatewayNames[model.kind] ?? model.kind}${notice === undefined ? "" : `; ${notice}`}`;
  }
  if (model.listPrice === undefined) {
    return model.kind === "openrouter" ? `${payer}; the price is the model it picks` : payer;
  }
  const price = `$${model.listPrice.input} in and $${model.listPrice.output} out`;
  return billing.metered ? `${payer}, ${price} per million tokens` : `${payer}; list price ${price}`;
}

/** A route with more models than this is listed by count; `tesota models <route>` lists them. */
const LISTED_AT_MOST = 40;

/** Each route's offered models, one line per route: the kinds', then the added routes'. */
export function routeListing(offered: readonly OfferedModel[]): string {
  const routes = [...new Set([...ROUTE_KINDS, ...offered.map((model) => model.route)])];
  return routes.map((route) => {
    const models = offered.filter((model) => model.route === route);
    if (models.length > LISTED_AT_MOST) {
      const free = models.filter((model) => model.free === true).length;
      return `  ${route}: ${models.length} models, ${free} of them free; tesota models ${route} lists them`;
    }
    return `  ${route}: ${models.map((model) => model.id.slice(route.length + 1)).join(", ")}`;
  }).join("\n");
}

/** One route's models, each with who pays for it and its price. */
function modelsOf(route: string, offered: readonly OfferedModel[]): string {
  return `${route}:\n${offered.filter((model) => model.route === route)
    .map((model) => `  ${model.id.slice(route.length + 1).padEnd(44)}${modelCost(model)}`).join("\n")}\n`;
}

const offText: Partial<Record<string, string>> = { triage: "no first pass; every answer gets the full check",
  namer: "no titles; a session keeps its first request as its name",
  explorer: "no explorers; choose a model to turn them on",
  advisor: "no advisor; choose a model to turn it on",
  searcher: "no hosted search; only Exa and Parallel, with your consent, search" };

/** Each route's account, as its sign-in records it, for telling roles that draw on one account. */
export type RouteAccounts = readonly { readonly route: string; readonly account?: RouteAccount | undefined }[];

/** Where roles on different routes draw on one account (#235); with a role, only the note naming its route. */
function roleAccountNotes(choices: ModelChoices, accounts: RouteAccounts, added: readonly AddedRoute[], role?: ModelRole): string[] {
  const usedBy = (route: string): ModelRole[] =>
    MODEL_ROLES.filter((each) => choices[each] !== ROLE_OFF && accountRoute(choices[each], added) === route);
  const route = role === undefined ? undefined : accountRoute(choices[role], added);
  return sharedRoleGroups(accounts, usedBy).filter((group) => role === undefined || route !== undefined && group.includes(route))
    .map((group) => sharedRoleNote(group, usedBy));
}

function rolesListing(offered: readonly OfferedModel[], path: string, accounts: RouteAccounts, added: readonly AddedRoute[]): string {
  const choices = readModelChoices(path);
  const rows = MODEL_ROLES.map((role) => {
    const detail = choices[role] === ROLE_OFF ? offText[role] ?? "off" : isDecisionModel(choices[role]) ? DECISION_COST
      : planRefusal(choices[role], accounts, added) ?? modelCost(offered.find((model) => model.id === choices[role]?.split("@")[0]));
    return `  ${role.padEnd(10)}${choices[role].padEnd(30)}${detail}\n  ${"".padEnd(10)}${ROLE_DESCRIPTIONS[role]}`;
  });
  const warnings = [describeJudgeWarnings(judgeWarnings(choices)), ...roleAccountNotes(choices, accounts, added)]
    .filter((text) => text !== "").join("\n");
  return `Models by role (${path}):\n${rows.join("\n")}\n${warnings === "" ? "" : `\n${warnings}\n`}` +
    "\nChange one with tesota roles <role> <route:model>; default restores that role's built-in choice. " +
    "tesota roles triage off checks every answer in full. " +
    "Use tesota models to see available models and reasoning levels.\n";
}

/**
 * The `/roles` picker's choices: at `/roles ` each role with its model, and
 * at `/roles <role> ` the models that role may use, with `default` and, for a
 * role that can be off, `off`. The triage role's typed decision models come
 * first, since they answer its question faster than any session.
 */
export function rolePicker(prefix: string, offered: readonly OfferedModel[], path: string = DEFAULT_MODELS_FILE): ModelPickerData | undefined {
  if (!prefix.startsWith("/roles ")) return undefined;
  const choices = readModelChoices(path);
  const role = prefix.slice("/roles ".length).trim();
  if (role === "") {
    return { title: "Role", completes: true, current: "",
      entries: MODEL_ROLES.map((name) => ({ id: name, detail: `${choices[name]} · ${ROLE_DESCRIPTIONS[name]}`, reasoning: [] })) };
  }
  if (!isModelRole(role)) return undefined;
  return { title: `The ${role}'s model, for every session`, current: choices[role], entries: [
    ...role === "triage" ? DECISION_MODELS.map((id) => ({ id, detail: DECISION_COST, reasoning: [] })) : [],
    // The searcher needs a provider that searches itself.
    ...offered.filter((model) => role !== "searcher" || HOSTED_SEARCH_KINDS.includes(model.kind))
      .map((model) => ({ id: model.id, detail: modelCost(model), reasoning: model.reasoning })),
    { id: "default", detail: "Tesota's default for this role", reasoning: [] },
    ...OPTIONAL_ROLES.includes(role) ? [{ id: ROLE_OFF, detail: offText[role] ?? "off", reasoning: [] }] : [],
  ] };
}

/**
 * `tesota models` lists the catalog; `tesota models <route>` lists one route.
 */
export function runModelsCommand(args: readonly string[], write: (text: string) => void,
  catalog: readonly OfferedModel[] = offeredModels(), accounts: RouteAccounts = []): number {
  const offered = servedModels(catalog, accounts);
  if (args.length === 0) {
    write(`Available models, as route:model:\n${routeListing(offered)}\n  typesafe, for triage only: ${DECISION_MODELS.join(", ")}\n` +
      "Use tesota models <route> for prices, or tesota roles to assign models.\n");
    return 0;
  }
  if (args.length === 1 && offered.some((model) => model.route === args[0])) {
    const route = args[0] ?? "";
    const withheld = catalog.filter((model) => model.route === route && !offered.includes(model))
      .map((model) => model.id.slice(route.length + 1));
    write(modelsOf(route, offered) + (withheld.length === 0 ? ""
      : `  Not listed: ${withheld.join(", ")}; Codex does not serve them on ${route}'s free ChatGPT plan.\n`));
    return 0;
  }
  write(`Usage: tesota models [<${ROUTE_KINDS.join("|")}>]\n`);
  return 2;
}

/** The model each Tesota role uses across sessions. */
export function runRolesCommand(args: readonly string[], write: (text: string) => void,
  offered: readonly OfferedModel[] = offeredModels(), path: string = DEFAULT_MODELS_FILE, accounts: RouteAccounts = [],
  added: readonly AddedRoute[] = readAddedRoutes()): number {
  if (args.length === 0) { write(rolesListing(offered, path, accounts, added)); return 0; }
  const [role, model] = args;
  if (args.length !== 2 || role === undefined || model === undefined || !isModelRole(role)) {
    write(`Usage: tesota roles [<${MODEL_ROLES.join("|")}> <route:model|default|off>]\n`);
    return 2;
  }
  const refusal = planRefusal(model, accounts, added);
  if (refusal !== undefined) {
    write(`${refusal}. Choose another model, or a route on a paid plan.\n`);
    return 1;
  }
  try {
    const choices = chooseModel(role, model, offeredChoices(servedModels(offered, accounts, added), role), path);
    write(choices[role] === ROLE_OFF ? (role === "explorer" ? "Explorers are off.\n"
      : role === "triage" ? "The first pass is off: every answer gets the full check.\n" : `The ${role} is off.\n`)
      : `The ${role} now uses ${choices[role]}.\n`);
    const notice = dataNotice(choices[role]);
    if (notice !== undefined) write(`Free model: ${notice}. Choose a paid model for code you would not share.\n`);
    if (isDecisionModel(choices[role])) {
      write("TypeSafe receives each such turn's requests and the agent's reply, and says it does not train on them. " +
        "It uses your key from tesota auth login typesafe or TYPESAFE_API_KEY; without one, every answer gets the full check.\n");
    }
    const warnings = describeJudgeWarnings(judgeWarnings(choices).filter((warning) => warning.author === role || warning.judge === role));
    if (warnings !== "") write(`${warnings}\n`);
    for (const note of roleAccountNotes(choices, accounts, added, role)) write(`${note}\n`);
    return 0;
  } catch (error) {
    write(`${error instanceof Error ? error.message : "The choice could not be saved"}.\n`);
    return 1;
  }
}
