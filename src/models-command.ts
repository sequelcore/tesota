import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { chooseModel, DEFAULT_MODEL, DEFAULT_MODELS_FILE, isModelRole, MODEL_ROLES, readModelChoices,
  ROLE_DESCRIPTIONS } from "./model-roles.js";

/** A model the Codex route offers, with its price in dollars per million tokens. */
export interface OfferedModel {
  readonly id: string;
  readonly name: string;
  readonly input: number;
  readonly output: number;
}

/** The Codex route's models from Pi's catalogue; no login is needed to list them. */
export function codexModels(): OfferedModel[] {
  const models = createModels();
  models.setProvider(openaiCodexProvider());
  return models.getModels("openai-codex").map((model) =>
    ({ id: model.id, name: model.name, input: model.cost.input, output: model.cost.output }));
}

function price(model: OfferedModel | undefined): string {
  return model === undefined ? "price unknown" : `$${model.input} in, $${model.output} out per million tokens`;
}

function listing(offered: readonly OfferedModel[], path: string): string {
  const choices = readModelChoices(path);
  const rows = MODEL_ROLES.map((role) => {
    const chosen = offered.find((model) => model.id === choices[role]);
    return `  ${role.padEnd(10)}${choices[role].padEnd(22)}${price(chosen)}\n  ${"".padEnd(10)}${ROLE_DESCRIPTIONS[role]}`;
  });
  return `Models by role (${path}):\n${rows.join("\n")}\n\nOffered: ${offered.map((model) => model.id).join(", ")}\n` +
    `Change one with tesota models <role> <model>, or <role> default for ${DEFAULT_MODEL}.\n`;
}

/**
 * `tesota models` lists each role's model; `tesota models <role> <model>`
 * chooses one. Prices are the catalogue's; a subscription counts usage
 * against its limits instead of billing them.
 */
export function runModelsCommand(args: readonly string[], write: (text: string) => void,
  offered: readonly OfferedModel[] = codexModels(), path: string = DEFAULT_MODELS_FILE): number {
  if (args.length === 0) { write(listing(offered, path)); return 0; }
  const [role, model] = args;
  if (args.length !== 2 || role === undefined || model === undefined || !isModelRole(role)) {
    write(`Usage: tesota models [<${MODEL_ROLES.join("|")}> <model|default>]\n`);
    return 2;
  }
  try {
    const choices = chooseModel(role, model, offered.map((entry) => entry.id), path);
    write(`The ${role} now uses ${choices[role]}.\n`);
    return 0;
  } catch (error) {
    write(`${error instanceof Error ? error.message : "The choice could not be saved"}.\n`);
    return 1;
  }
}
