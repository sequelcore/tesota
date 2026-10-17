import { type Api, type CredentialStore, createModels, type LoginOptions, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fileCredentialStore } from "./credentials.ts";
import { deviceId, type Settings } from "./settings.ts";

/**
 * The models a Tesota session runs on (#443): pi-ai's built-in providers,
 * authorized by the engine's own credentials and, as pi-ai resolves them,
 * API keys in the environment. Logging in and out is `Models.login` and
 * `Models.logout` with `loginOptions`. Pi's remote catalog refresh and
 * custom providers are left out until something needs them.
 */
export function engineModels(credentials: CredentialStore = fileCredentialStore()): MutableModels {
  const models = createModels({ credentials });
  for (const provider of builtinProviders()) models.setProvider(provider);
  return models;
}

/** How Tesota introduces itself to a provider's login, with this installation's id. */
export const loginOptions = (settingsPath?: string): LoginOptions => ({ agentName: "Tesota", getDeviceId: () => deviceId(settingsPath) });

/** The model the operator chose, if it still exists, else the first one with a credential, else none. */
export async function chosenModel(models: MutableModels, settings: Settings): Promise<Model<Api> | undefined> {
  const [provider, ...id] = settings.model?.split("/") ?? [];
  const named = provider === undefined ? undefined : models.getModel(provider, id.join("/"));
  return named ?? (await models.getAvailable())[0];
}
