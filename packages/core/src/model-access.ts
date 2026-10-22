import { type Api, type CredentialStore, createModels, type LoginOptions, type Model, type Models, type MutableModels,
  type Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
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
  // pi-ai imports each sign-in flow by a path a compiled `tesota` does not have, so they are embedded instead (#372).
  // pi-ai registers its flows only all at once; Anthropic's is never reached, since no provider here offers it.
  registerBunOAuthFlows();
  const models = createModels({ credentials });
  for (const provider of builtinProviders()) models.setProvider(provider.id === "anthropic" ? anthropicKeyOnly(provider) : provider);
  models.setProvider(claudeCodeProvider(models.getModels("anthropic")));
  return models;
}

/** A Claude plan's OAuth token, which pi-ai's Anthropic API would send as Claude Code does. */
const planToken = (value: string | undefined): boolean => value?.includes("sk-ant-oat") === true;
const noPlanToken = "Tesota takes no Claude plan token: use an Anthropic API key, or Claude through your own Claude Code (claude-code).";

/**
 * pi-ai's Anthropic provider with its API key alone: no Claude sign-in, and
 * no Claude plan's token, from the environment (`ANTHROPIC_OAUTH_TOKEN`) or
 * entered as a key, since Tesota offers no Claude login
 * (`docs/decisions/claude-code-route-terms.md`). Claude on a plan is the
 * `claude-code` provider.
 */
export function anthropicKeyOnly(provider: Provider): Provider {
  const key = provider.auth.apiKey;
  if (key === undefined) throw new Error("pi-ai's Anthropic provider has no API key auth");
  const login = key.login;
  return { ...provider, auth: { apiKey: {
    name: key.name,
    ...login === undefined ? {} : { login: async (interaction) => {
      const credential = await login(interaction);
      if (planToken(credential.key)) throw new Error(noPlanToken);
      return credential;
    } },
    resolve: async (input) => {
      if (planToken(input.credential?.key)) return undefined;
      const ctx = { env: (name: string) => name === "ANTHROPIC_OAUTH_TOKEN" ? Promise.resolve(undefined) : input.ctx.env(name),
        fileExists: (path: string) => input.ctx.fileExists(path) };
      const resolved = await key.resolve({ ...input, ctx });
      const headers = Object.values(resolved?.auth.headers ?? {}).map(String);
      return [resolved?.auth.apiKey, ...headers].some(planToken) ? undefined : resolved;
    },
  } } };
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
