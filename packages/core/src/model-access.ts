import { type Api, type CredentialStore, createModels, type LoginOptions, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
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

/**
 * The model the operator chose, if it still exists, else none. Tesota never
 * picks one for them (#425): the first a credential reaches may be one the
 * sign-in does not serve, which failed with a provider's error; with none,
 * the shell and `-p` say how to choose one.
 */
export function chosenModel(models: MutableModels, settings: Settings): Model<Api> | undefined {
  const [provider, ...id] = settings.model?.split("/") ?? [];
  return provider === undefined ? undefined : models.getModel(provider, id.join("/"));
}

const label = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/**
 * The models Tesota can run (#563, #566): those of the providers it is
 * signed in to, but with ChatGPT sign-in only the OpenAI models it serves,
 * as `GET /models` on its token lists them; OpenAI refuses the rest of its
 * catalog at the first request. `/model`, `-p` and the `agent` tool read it.
 */
export async function runnableModels(models: Models): Promise<readonly Model<Api>[]> {
  const available = await models.getAvailable();
  if ((await models.checkAuth("openai"))?.type !== "oauth") return available;
  const token = (await models.getAuth("openai"))?.auth.apiKey;
  const response = await fetch(`${models.getProvider("openai")?.baseUrl}/models`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OpenAI did not list the models the ChatGPT sign-in serves (${response.status}).`);
  const listed = (await response.json() as { models?: readonly { slug?: unknown }[] }).models ?? [];
  const served = new Set(listed.map(({ slug }) => slug));
  return available.filter((model) => model.provider !== "openai" || served.has(model.id));
}

/** The model `named`, as `provider/id`, among those Tesota can run, or why it is not one. */
export async function runnableModel(models: Models, named: string): Promise<Model<Api> | string> {
  let available: readonly Model<Api>[];
  try { available = await runnableModels(models); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return available.find((model) => label(model) === named)
    ?? `no model ${named} among those Tesota can run: ${available.map(label).join(", ") || "none"}.`;
}
