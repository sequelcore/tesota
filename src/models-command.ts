import { type Api, createModels, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { describeJudgeWarnings, judgeWarnings } from "./judge-warnings.js";
import { chooseModel, isReasoningLevel, type ReasoningLevel, ROLE_OFF, DEFAULT_MODEL, DEFAULT_MODELS_FILE, isModelRole, MODEL_ROLES,
  MODEL_ROUTES, type ModelRoute, parseModelChoice, readModelChoices, ROLE_DESCRIPTIONS, ROUTE_BILLING } from "./model-roles.js";

/**
 * A model a route offers, as `route:model`, with the catalogue's list price
 * in dollars per million tokens when the catalogue has one. Who pays is the
 * route's (`ROUTE_BILLING`): a list price is what an API key is billed, and
 * on a plan only a way to compare models.
 */
export interface OfferedModel {
  readonly id: string;
  readonly route: ModelRoute;
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
  const { route, model } = parsed;
  const free = route === "openrouter" && (model.endsWith(":free") || model === "openrouter/free");
  const contributor = (route === "opencode" || route === "opencode-go") && model.includes("-contributor");
  if (!free && !contributor) return undefined;
  return "its provider may keep your prompts and code, and use them to train models";
}

/** Every choice the routes offer: each model, and each model at each reasoning level it accepts. */
export function offeredChoices(offered: readonly OfferedModel[]): string[] {
  return offered.flatMap((model) => [model.id, ...model.reasoning.map((level) => `${model.id}@${level}`)]);
}

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
function gatewayModel(route: ModelRoute, model: Model<Api>): OfferedModel {
  const offered: OfferedModel = { id: `${route}:${model.id}`, route, name: model.name, reasoning: levels(model) };
  if (route === "openrouter" && isOpenRouterRouter(model.id)) return offered;
  const listPrice = { input: model.cost.input, output: model.cost.output };
  return listPrice.input === 0 && listPrice.output === 0 ? { ...offered, listPrice, free: true } : { ...offered, listPrice };
}

/** Every route's models, from Pi's catalogues and Claude Code's aliases; no login is needed to list them. */
export function offeredModels(): OfferedModel[] {
  const models = createModels();
  for (const provider of [openaiCodexProvider(), anthropicProvider(), openrouterProvider(), opencodeProvider(), opencodeGoProvider()]) {
    models.setProvider(provider);
  }
  const priced = (route: ModelRoute, provider: string, accepted: (model: Model<Api>) => ReasoningLevel[]): OfferedModel[] =>
    models.getModels(provider).map((model) => ({ id: `${route}:${model.id}`, route, name: model.name,
      listPrice: { input: model.cost.input, output: model.cost.output }, reasoning: accepted(model) }));
  // OpenRouter's `:batch` variants answer within a day through its Batch API, too late for any role. Zen's free
  // models answer only OpenCode's own client: any other gets 403 "OpenCode's free tier can only be used from within
  // OpenCode" (observed 2026-09-26; not in Zen's documentation).
  const gateway = (route: ModelRoute, provider: string): OfferedModel[] => models.getModels(provider)
    .filter((model) => !model.id.endsWith(":batch")).map((model) => gatewayModel(route, model))
    .filter((model) => !(route === "opencode" && model.free === true));
  const claude = models.getModels("anthropic");
  const aliases = claudeCodeAliases.map((alias): OfferedModel => {
    const newest = newestOf(alias, claude);
    return { id: `claude-code:${alias}`, route: "claude-code", name: `Claude Code's ${alias}`,
      reasoning: newest === undefined ? [] : effortLevels(newest) };
  });
  return [...priced("codex", "openai-codex", levels), ...priced("anthropic", "anthropic", levels), ...aliases,
    ...priced("claude-code", "anthropic", effortLevels), ...gateway("openrouter", "openrouter"), ...gateway("opencode", "opencode"),
    ...gateway("opencode-go", "opencode-go")];
}

const gatewayNames: Partial<Record<ModelRoute, string>> = { openrouter: "OpenRouter", opencode: "OpenCode Zen", "opencode-go": "OpenCode Go" };

/** Who pays for a model, and its list price: what an API key is billed, or on a plan a way to compare models. */
export function modelCost(model: OfferedModel | undefined): string {
  if (model === undefined) return "not offered";
  const billing = ROUTE_BILLING[model.route];
  if (model.free === true) {
    const notice = dataNotice(model.id);
    return `free on ${gatewayNames[model.route] ?? model.route}${notice === undefined ? "" : `; ${notice}`}`;
  }
  if (model.listPrice === undefined) {
    return model.route === "openrouter" ? `${billing.payer}; the price is the model it picks` : billing.payer;
  }
  const price = `$${model.listPrice.input} in and $${model.listPrice.output} out`;
  return billing.metered ? `${billing.payer}, ${price} per million tokens` : `${billing.payer}; list price ${price}`;
}

/** A route with more models than this is listed by count; `tesota models <route>` lists them. */
const LISTED_AT_MOST = 40;

/** Each route's offered models, one line per route. */
export function routeListing(offered: readonly OfferedModel[]): string {
  return MODEL_ROUTES.map((route) => {
    const models = offered.filter((model) => model.route === route);
    if (models.length > LISTED_AT_MOST) {
      const free = models.filter((model) => model.free === true).length;
      return `  ${route}: ${models.length} models, ${free} of them free; tesota models ${route} lists them`;
    }
    return `  ${route}: ${models.map((model) => model.id.slice(route.length + 1)).join(", ")}`;
  }).join("\n");
}

/** One route's models, each with who pays for it and its price. */
function modelsOf(route: ModelRoute, offered: readonly OfferedModel[]): string {
  return `${route}:\n${offered.filter((model) => model.route === route)
    .map((model) => `  ${model.id.slice(route.length + 1).padEnd(44)}${modelCost(model)}`).join("\n")}\n`;
}

const offText: Partial<Record<string, string>> = { triage: "no first pass; every answer gets the full check",
  explorer: "no explorers; choose a model to turn them on",
  advisor: "no advisor; choose a model to turn it on" };

function listing(offered: readonly OfferedModel[], path: string): string {
  const choices = readModelChoices(path);
  const rows = MODEL_ROLES.map((role) => {
    const detail = choices[role] === ROLE_OFF ? offText[role] ?? "off"
      : modelCost(offered.find((model) => model.id === choices[role]?.split("@")[0]));
    return `  ${role.padEnd(10)}${choices[role].padEnd(30)}${detail}\n  ${"".padEnd(10)}${ROLE_DESCRIPTIONS[role]}`;
  });
  const warnings = describeJudgeWarnings(judgeWarnings(choices));
  return `Models by role (${path}):\n${rows.join("\n")}\n${warnings === "" ? "" : `\n${warnings}\n`}` +
    `\nOffered, as route:model:\n${routeListing(offered)}\n` +
    "Add @low, @medium, @high, @xhigh or @max for a reasoning level the model accepts, such as codex:gpt-6-astra@high; " +
    "without one, Pi's models reason at medium and Claude Code's at their default.\n" +
    `Change one with tesota models <role> <route:model>; <role> default restores ${DEFAULT_MODEL}, ` +
    "and turns explorers and the advisor off; tesota models triage off checks every answer in full.\n";
}

/**
 * `tesota models` lists each role's model, who pays for it and its list
 * price; `tesota models <role> <route:model>` chooses one.
 */
export function runModelsCommand(args: readonly string[], write: (text: string) => void,
  offered: readonly OfferedModel[] = offeredModels(), path: string = DEFAULT_MODELS_FILE): number {
  if (args.length === 0) { write(listing(offered, path)); return 0; }
  const [role, model] = args;
  if (args.length === 1 && (MODEL_ROUTES as readonly string[]).includes(role ?? "")) {
    write(modelsOf(role as ModelRoute, offered));
    return 0;
  }
  if (args.length !== 2 || role === undefined || model === undefined || !isModelRole(role)) {
    write(`Usage: tesota models [<route> | <${MODEL_ROLES.join("|")}> <route:model|default|off>]\n`);
    return 2;
  }
  try {
    const choices = chooseModel(role, model, offeredChoices(offered), path);
    write(choices[role] === ROLE_OFF ? (role === "explorer" ? "Explorers are off.\n"
      : role === "triage" ? "The first pass is off: every answer gets the full check.\n" : `The ${role} is off.\n`)
      : `The ${role} now uses ${choices[role]}.\n`);
    const notice = dataNotice(choices[role]);
    if (notice !== undefined) write(`Free model: ${notice}. Choose a paid model for code you would not share.\n`);
    const warnings = describeJudgeWarnings(judgeWarnings(choices).filter((warning) => warning.author === role || warning.judge === role));
    if (warnings !== "") write(`${warnings}\n`);
    return 0;
  } catch (error) {
    write(`${error instanceof Error ? error.message : "The choice could not be saved"}.\n`);
    return 1;
  }
}
