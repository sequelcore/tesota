import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { chooseModel, DEFAULT_MODEL, DEFAULT_MODELS_FILE, EXPLORERS_OFF, isModelRole, MODEL_ROLES, type ModelRoute,
  readModelChoices, ROLE_DESCRIPTIONS, ROUTE_BILLING } from "./model-roles.js";

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
}

/** Claude Code's own aliases, which follow the newest model of each family. */
const claudeCodeAliases = ["opus", "sonnet", "fable", "haiku"] as const;

/** Every route's models, from Pi's catalogues and Claude Code's aliases; no login is needed to list them. */
export function offeredModels(): OfferedModel[] {
  const models = createModels();
  models.setProvider(openaiCodexProvider());
  models.setProvider(anthropicProvider());
  const priced = (route: ModelRoute, provider: string): OfferedModel[] => models.getModels(provider).map((model) =>
    ({ id: `${route}:${model.id}`, route, name: model.name, listPrice: { input: model.cost.input, output: model.cost.output } }));
  const anthropic = priced("anthropic", "anthropic");
  return [...priced("codex", "openai-codex"), ...anthropic,
    ...claudeCodeAliases.map((alias): OfferedModel => ({ id: `claude-code:${alias}`, route: "claude-code", name: `Claude Code's ${alias}` })),
    ...anthropic.map((model): OfferedModel => ({ ...model, id: `claude-code:${model.id.slice("anthropic:".length)}`, route: "claude-code" }))];
}

/** Who pays for a model, and its list price: what an API key is billed, or on a plan a way to compare models. */
function cost(model: OfferedModel | undefined): string {
  if (model === undefined) return "not offered";
  const billing = ROUTE_BILLING[model.route];
  if (model.listPrice === undefined) return billing.payer;
  const price = `$${model.listPrice.input} in and $${model.listPrice.output} out`;
  return billing.metered ? `${billing.payer}, ${price} per million tokens` : `${billing.payer}; list price ${price}`;
}

function listing(offered: readonly OfferedModel[], path: string): string {
  const choices = readModelChoices(path);
  const rows = MODEL_ROLES.map((role) => {
    const detail = choices[role] === EXPLORERS_OFF ? "no explorers; choose a model to turn them on"
      : cost(offered.find((model) => model.id === choices[role]));
    return `  ${role.padEnd(10)}${choices[role].padEnd(30)}${detail}\n  ${"".padEnd(10)}${ROLE_DESCRIPTIONS[role]}`;
  });
  const routes = (["codex", "anthropic", "claude-code"] as const).map((route) =>
    `  ${route}: ${offered.filter((model) => model.route === route).map((model) => model.id.slice(route.length + 1)).join(", ")}`);
  return `Models by role (${path}):\n${rows.join("\n")}\n\nOffered, as route:model:\n${routes.join("\n")}\n` +
    `Change one with tesota models <role> <route:model>; <role> default restores ${DEFAULT_MODEL}, and explorers off.\n`;
}

/**
 * `tesota models` lists each role's model, who pays for it and its list
 * price; `tesota models <role> <route:model>` chooses one.
 */
export function runModelsCommand(args: readonly string[], write: (text: string) => void,
  offered: readonly OfferedModel[] = offeredModels(), path: string = DEFAULT_MODELS_FILE): number {
  if (args.length === 0) { write(listing(offered, path)); return 0; }
  const [role, model] = args;
  if (args.length !== 2 || role === undefined || model === undefined || !isModelRole(role)) {
    write(`Usage: tesota models [<${MODEL_ROLES.join("|")}> <route:model|default|off>]\n`);
    return 2;
  }
  try {
    const choices = chooseModel(role, model, offered.map((entry) => entry.id), path);
    write(choices[role] === EXPLORERS_OFF ? "Explorers are off.\n" : `The ${role} now uses ${choices[role]}.\n`);
    return 0;
  } catch (error) {
    write(`${error instanceof Error ? error.message : "The choice could not be saved"}.\n`);
    return 1;
  }
}
