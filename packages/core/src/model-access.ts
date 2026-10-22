import { type Api, type CredentialStore, createModels, type LoginOptions, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fileCredentialStore } from "./credentials.ts";
import { claudeCodeProvider } from "./providers/claude-code.ts";
import { deviceId, type Settings } from "./settings.ts";

/**
 * The models a Tesota session runs on (#443): pi-ai's built-in providers,
 * authorized by the engine's own credentials and, as pi-ai resolves them,
 * API keys in the environment, and Claude through the operator's own Claude
 * Code (`claude-code`, #546), on pi-ai's Anthropic catalog. Logging in and
 * out is `Models.login` and `Models.logout` with `loginOptions`. Pi's remote
 * catalog refresh is left out until something needs it.
 */
export function engineModels(credentials: CredentialStore = fileCredentialStore()): MutableModels {
  const models = createModels({ credentials });
  for (const provider of builtinProviders()) models.setProvider(provider);
  models.setProvider(claudeCodeProvider(models.getModels("anthropic")));
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
 * The OpenAI models a ChatGPT sign-in serves, as `GET /models` on its token
 * lists them (#563, #566), or none when OpenAI is not signed in with
 * ChatGPT. Throws when the list cannot be fetched.
 */
async function servedByChatGPT(models: Models): Promise<ReadonlySet<unknown> | undefined> {
  if ((await models.checkAuth("openai"))?.type !== "oauth") return undefined;
  const token = (await models.getAuth("openai"))?.auth.apiKey;
  let listed: readonly { slug?: unknown }[];
  try {
    const response = await fetch(`${models.getProvider("openai")?.baseUrl}/models`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`OpenAI answered ${response.status}`);
    listed = (await response.json() as { models?: readonly { slug?: unknown }[] }).models ?? [];
  } catch (error) {
    throw new Error(`the list of the models the ChatGPT sign-in serves could not be fetched (${error instanceof Error ? error.message : String(error)})`);
  }
  return new Set(listed.map(({ slug }) => slug));
}

const narrowed = (available: readonly Model<Api>[], served: ReadonlySet<unknown> | undefined): readonly Model<Api>[] =>
  served === undefined ? available : available.filter((model) => model.provider !== "openai" || served.has(model.id));

/**
 * The models Tesota can run (#563, #566): those of the providers it is
 * signed in to, but with ChatGPT sign-in only the OpenAI models it serves;
 * OpenAI refuses the rest of its catalog at the first request. `/model`
 * lists them. Throws when the ChatGPT sign-in's list cannot be fetched.
 */
export async function runnableModels(models: Models): Promise<readonly Model<Api>[]> {
  return narrowed(await models.getAvailable(), await servedByChatGPT(models));
}

/**
 * The model `named`, as `provider/id`, among those Tesota can run, or why it
 * is not one; `-p`, the shell's saved model and the `agent` tool read it. It
 * is refused only when the ChatGPT sign-in's list arrived without it: when
 * the list cannot be fetched, it is kept with `unchecked` saying why, since
 * OpenAI still refuses one it does not serve at the first request (#567).
 */
export async function runnableModel(models: Models, named: string): Promise<{ readonly model: Model<Api>; readonly unchecked?: string } | string> {
  const available = await models.getAvailable();
  let served: ReadonlySet<unknown> | undefined;
  let failed: string | undefined;
  try { served = await servedByChatGPT(models); } catch (error) { failed = error instanceof Error ? error.message : String(error); }
  const runnable = narrowed(available, served);
  const model = runnable.find((candidate) => label(candidate) === named);
  if (model === undefined) return `no model ${named} among those Tesota can run: ${runnable.map(label).join(", ") || "none"}.`;
  return failed === undefined || model.provider !== "openai" ? { model }
    : { model, unchecked: `${named} was not checked against the models the ChatGPT sign-in serves: ${failed}.` };
}
