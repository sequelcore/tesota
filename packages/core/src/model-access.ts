import { type Api, type CredentialStore, createModels, type LoginOptions, type Model, type Models, type MutableModels,
  type Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fileCredentialStore } from "./credentials.ts";
import { claudeCodeProvider, claudeCodeStatus } from "./providers/claude-code.ts";
import { type Account, deviceId, readSettings, type Settings } from "./settings.ts";

/**
 * The models a Tesota session runs on (#443): pi-ai's built-in providers,
 * authorized by the engine's own credentials and, as pi-ai resolves them,
 * API keys in the environment, and Claude through the operator's own Claude
 * Code (`claude-code`, #546), on pi-ai's Anthropic catalog. Logging in and
 * out is `Models.login` and `Models.logout` with `loginOptions`. Pi's remote
 * catalog refresh is left out until something needs it.
 */
export function engineModels(credentials: CredentialStore = fileCredentialStore(), accounts: readonly Account[] = readSettings().settings.accounts ?? []): MutableModels {
  // pi-ai imports each sign-in flow by a path a compiled `tesota` does not have, so they are embedded instead (#372).
  // pi-ai registers its flows only all at once; Anthropic's is never reached, since no provider here offers it.
  registerBunOAuthFlows();
  const models = createModels({ credentials });
  for (const provider of builtinProviders()) models.setProvider(provider.id === "anthropic" ? anthropicKeyOnly(provider) : provider);
  models.setProvider(claudeCodeProvider(models.getModels("anthropic")));
  for (const account of accounts) setAccountProvider(models, account);
  return models;
}

/** `account`'s provider ID, `<provider>@<name>`. */
export const accountId = (account: Account): string => `${account.provider}@${account.name}`;

/** Adds `account`'s provider instance to `models`, as `engineModels` does for each declared one and adding an account does (#642). */
export function setAccountProvider(models: MutableModels, account: Account): void {
  const id = accountId(account);
  if (account.provider === "claude-code") {
    models.setProvider(claudeCodeProvider(models.getModels("anthropic"), { id, configDir: account.folder }));
    return;
  }
  const provider = models.getProvider("openai-codex");
  if (provider?.auth.oauth === undefined) throw new Error("pi-ai's Codex provider has no ChatGPT auth");
  // Same pi-ai transport and OAuth flow, but auth resolves and refreshes under this instance's id only.
  models.setProvider({ ...provider, id, name: id, auth: { oauth: provider.auth.oauth },
    getModels: () => provider.getModels().map((model) => ({ ...model, provider: id })),
    getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map((model) => ({ ...model, provider: id })) });
}

/** Non-secret labels for account pickers and runs. Identity comes from Claude Code's status or the ChatGPT credential's account id. */
export async function accountLabels(credentials: CredentialStore, accounts: readonly Account[],
  status: typeof claudeCodeStatus = claudeCodeStatus): Promise<ReadonlyMap<string, string>> {
  const labels = new Map<string, string>();
  const seen = new Map<string, string>();
  const instances: readonly { readonly id: string; readonly provider: Account["provider"]; readonly folder?: string }[] = [
    ...accounts.some(({ provider }) => provider === "claude-code") ? [{ id: "claude-code", provider: "claude-code" as const }] : [],
    ...accounts.some(({ provider }) => provider === "openai-codex") ? [{ id: "openai-codex", provider: "openai-codex" as const }] : [],
    ...accounts.map((account) => ({ ...account, id: accountId(account) })),
  ];
  for (const instance of instances) {
    let identity: string | undefined;
    let signedIn = false;
    if (instance.provider === "claude-code") {
      const info = await status(instance.folder);
      signedIn = info.loggedIn;
      if (signedIn) identity = info.email;
    } else {
      const credential = await credentials.read(instance.id);
      signedIn = credential?.type === "oauth";
      if (credential?.type === "oauth" && typeof credential["accountId"] === "string") identity = credential["accountId"];
    }
    let label = signedIn ? identity ?? "signed in · account identity unavailable" : "not signed in";
    if (identity !== undefined) {
      const key = `${instance.provider}/${identity.toLowerCase()}`;
      const previous = seen.get(key);
      if (previous !== undefined) label += ` · same account as ${previous}`;
      else seen.set(key, instance.id);
    }
    labels.set(instance.id, label);
  }
  return labels;
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
