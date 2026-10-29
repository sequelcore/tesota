import { type Api, type CredentialStore, createModels, type LoginOptions, type Model, type Models, type MutableModels,
  type Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { fileCredentialStore } from "./credentials.ts";
import { claudeCodeProvider, claudeCodeProviderId, claudeCodeStatus } from "./providers/claude-code.ts";
import { type Account, deviceId, readSettings, type Settings } from "./settings.ts";

/**
 * Each of pi-ai's built-in providers, loaded on its own (#743), so the shell can
 * start with only those its saved model needs: a static `import()` each, which
 * the compiled binary keeps in a chunk of its own until it is loaded. A test
 * holds it to pi-ai's `builtinProviders()`.
 */
export const providerLoaders: Readonly<Record<string, () => Promise<Provider>>> = {
  "amazon-bedrock": async () => (await import("@earendil-works/pi-ai/providers/amazon-bedrock")).amazonBedrockProvider(),
  "ant-ling": async () => (await import("@earendil-works/pi-ai/providers/ant-ling")).antLingProvider(),
  "anthropic": async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider(),
  "azure": async () => (await import("@earendil-works/pi-ai/providers/azure")).azureProvider(),
  "baseten": async () => (await import("@earendil-works/pi-ai/providers/baseten")).basetenProvider(),
  "cerebras": async () => (await import("@earendil-works/pi-ai/providers/cerebras")).cerebrasProvider(),
  "cloudflare-ai-gateway": async () => (await import("@earendil-works/pi-ai/providers/cloudflare-ai-gateway")).cloudflareAIGatewayProvider(),
  "cloudflare-workers-ai": async () => (await import("@earendil-works/pi-ai/providers/cloudflare-workers-ai")).cloudflareWorkersAIProvider(),
  "deepseek": async () => (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider(),
  "fireworks": async () => (await import("@earendil-works/pi-ai/providers/fireworks")).fireworksProvider(),
  "github-copilot": async () => (await import("@earendil-works/pi-ai/providers/github-copilot")).githubCopilotProvider(),
  "google": async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider(),
  "google-vertex": async () => (await import("@earendil-works/pi-ai/providers/google-vertex")).googleVertexProvider(),
  "groq": async () => (await import("@earendil-works/pi-ai/providers/groq")).groqProvider(),
  "huggingface": async () => (await import("@earendil-works/pi-ai/providers/huggingface")).huggingfaceProvider(),
  "kimi-coding": async () => (await import("@earendil-works/pi-ai/providers/kimi-coding")).kimiCodingProvider(),
  "meta": async () => (await import("@earendil-works/pi-ai/providers/meta")).metaProvider(),
  "minimax": async () => (await import("@earendil-works/pi-ai/providers/minimax")).minimaxProvider(),
  "minimax-cn": async () => (await import("@earendil-works/pi-ai/providers/minimax-cn")).minimaxCnProvider(),
  "mistral": async () => (await import("@earendil-works/pi-ai/providers/mistral")).mistralProvider(),
  "moonshotai": async () => (await import("@earendil-works/pi-ai/providers/moonshotai")).moonshotaiProvider(),
  "moonshotai-cn": async () => (await import("@earendil-works/pi-ai/providers/moonshotai-cn")).moonshotaiCnProvider(),
  "nvidia": async () => (await import("@earendil-works/pi-ai/providers/nvidia")).nvidiaProvider(),
  "openai": async () => (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider(),
  "openai-codex": async () => (await import("@earendil-works/pi-ai/providers/openai-codex")).openaiCodexProvider(),
  "opencode": async () => (await import("@earendil-works/pi-ai/providers/opencode")).opencodeProvider(),
  "opencode-go": async () => (await import("@earendil-works/pi-ai/providers/opencode-go")).opencodeGoProvider(),
  "openrouter": async () => (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider(),
  "qwen-token-plan": async () => (await import("@earendil-works/pi-ai/providers/qwen-token-plan")).qwenTokenPlanProvider(),
  "qwen-token-plan-cn": async () => (await import("@earendil-works/pi-ai/providers/qwen-token-plan-cn")).qwenTokenPlanCnProvider(),
  "qwen-token-plan-individual": async () => (await import("@earendil-works/pi-ai/providers/qwen-token-plan-individual")).qwenTokenPlanIndividualProvider(),
  "radius": async () => (await import("@earendil-works/pi-ai/providers/radius")).radiusProvider(),
  "together": async () => (await import("@earendil-works/pi-ai/providers/together")).togetherProvider(),
  "typesafe": async () => (await import("@earendil-works/pi-ai/providers/typesafe")).typesafeProvider(),
  "vercel-ai-gateway": async () => (await import("@earendil-works/pi-ai/providers/vercel-ai-gateway")).vercelAIGatewayProvider(),
  "xai": async () => (await import("@earendil-works/pi-ai/providers/xai")).xaiProvider(),
  "xiaomi": async () => (await import("@earendil-works/pi-ai/providers/xiaomi")).xiaomiProvider(),
  "xiaomi-token-plan-ams": async () => (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-ams")).xiaomiTokenPlanAmsProvider(),
  "xiaomi-token-plan-cn": async () => (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn")).xiaomiTokenPlanCnProvider(),
  "xiaomi-token-plan-sgp": async () => (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp")).xiaomiTokenPlanSgpProvider(),
  "zai": async () => (await import("@earendil-works/pi-ai/providers/zai")).zaiProvider(),
  "zai-coding-cn": async () => (await import("@earendil-works/pi-ai/providers/zai-coding-cn")).zaiCodingCnProvider(),
};

/** pi-ai's whole catalog, loaded when first asked, never on import (#743). */
const catalog = async (): Promise<readonly Provider[]> => (await import("@earendil-works/pi-ai/providers/all")).builtinProviders();

/**
 * The models a Tesota session runs on (#443): pi-ai's built-in providers,
 * authorized by the engine's own credentials and, as pi-ai resolves them,
 * API keys in the environment, and Claude through the operator's own Claude
 * Code (`claude-code`, #546), on pi-ai's Anthropic catalog. Logging in and
 * out is `Models.login` and `Models.logout` with `loginOptions`. Pi's remote
 * catalog refresh is left out until something needs it.
 */
export async function engineModels(credentials: CredentialStore = fileCredentialStore(), accounts: readonly Account[] = readSettings().settings.accounts ?? []): Promise<MutableModels> {
  // pi-ai imports each sign-in flow by a path a compiled `tesota` does not have, so they are embedded instead (#372).
  // pi-ai registers its flows only all at once; Anthropic's is never reached, since no provider here offers it.
  registerBunOAuthFlows();
  const models = createModels({ credentials });
  fill(models, await catalog(), accounts);
  return models;
}

/**
 * Adds to `models` each of `providers` it doesn't hold yet, Anthropic's with
 * its API key alone, then what is built on them: `claude-code` on Anthropic's
 * models, and each account on the provider it is an instance of. Run again as
 * more providers load, it adds only what is new (#743).
 */
function fill(models: MutableModels, providers: readonly Provider[], accounts: readonly Account[]): void {
  for (const provider of providers) {
    if (models.getProvider(provider.id) === undefined) models.setProvider(provider.id === "anthropic" ? anthropicKeyOnly(provider) : provider);
  }
  if (models.getProvider("anthropic") !== undefined && models.getProvider(claudeCodeProviderId) === undefined) {
    models.setProvider(claudeCodeProvider(models.getModels("anthropic")));
  }
  for (const account of accounts) {
    if (models.getProvider(builtOn(account.provider)) !== undefined && models.getProvider(accountId(account)) === undefined) setAccountProvider(models, account);
  }
}

/** The built-in provider `provider` is built on: `claude-code` on Anthropic's models, any other on itself. */
const builtOn = (provider: string): string => provider === claudeCodeProviderId ? "anthropic" : provider;

/** The async uses of pi-ai's `Models` that can reach any provider: the shell's models load the whole catalog before each (#743). */
const catalogUses = new Set(["refresh", "checkAuth", "getAvailable", "getAvailableOfType", "getAllAvailable", "getAuth", "login", "logout",
  "complete", "completeSimple", "fetchDeferred", "cancelDeferred", "generateImages", "classify"]);

/**
 * The shell's models (#743): at first only the providers its saved model
 * (`saved`, `provider/id`) and `accounts` are built on, so the shell draws its
 * first frame without pi-ai's whole catalog, about 35 ms and 12 MB. `rest()`
 * loads the rest once, and every async use that can reach any provider waits
 * for it first; a synchronous read before then sees what is loaded. With no
 * saved model, or one whose provider can't be loaded alone, everything loads
 * at once.
 */
export async function shellModels(credentials: CredentialStore, accounts: readonly Account[], saved: string | undefined):
  Promise<{ readonly models: MutableModels; readonly rest: () => Promise<void> }> {
  registerBunOAuthFlows();
  const models = createModels({ credentials });
  let loaded: Promise<void> | undefined;
  const rest = (): Promise<void> => loaded ??= catalog().then((providers) => { fill(models, providers, accounts); });
  const base = builtOn(saved?.split("/")[0]?.split("@")[0] ?? "");
  const startup = new Set([base, ...accounts.map(({ provider }) => builtOn(provider))]);
  const loaders = [...startup].flatMap((id) => providerLoaders[id] ?? []);
  if (providerLoaders[base] === undefined) await rest();
  else fill(models, await Promise.all(loaders.map((load) => load())), accounts);
  const waiting = new Proxy(models, { get: (target, key) => {
    const value: unknown = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    const method = value as (...args: unknown[]) => unknown;
    return catalogUses.has(String(key)) ? async (...args: unknown[]) => { await rest(); return method.apply(target, args); } : method.bind(target);
  } });
  return { models: waiting, rest };
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

/** An account as it stands: its sign-in, and whom it is signed in to when the provider says (non-secret). */
export interface AccountState {
  readonly id: string;
  readonly provider: Account["provider"];
  readonly folder?: string;
  readonly signedIn: boolean;
  readonly identity?: string;
  /** The earlier account that is the same one, when another is. */
  readonly sameAs?: string;
  /** The label account pickers and runs show. */
  readonly label: string;
  /** Its sign-in is still being checked: not signed in as far as is known yet. */
  readonly checking?: true;
}

type Instance = { readonly id: string; readonly provider: Account["provider"]; readonly folder?: string };
type SignIn = { readonly signedIn: boolean; readonly identity?: string };

/** One account's sign-in, from Claude Code's status or the ChatGPT credential's account id. */
async function signInOf(credentials: CredentialStore, instance: Instance, status: typeof claudeCodeStatus, signal: AbortSignal | undefined): Promise<SignIn> {
  if (instance.provider === "claude-code") {
    const info = await status(instance.folder, undefined, signal);
    return info.loggedIn ? { signedIn: true, ...info.email === undefined ? {} : { identity: info.email } } : { signedIn: false };
  }
  const credential = await credentials.read(instance.id);
  if (credential?.type !== "oauth") return { signedIn: false };
  return { signedIn: true, ...typeof credential["accountId"] === "string" ? { identity: credential["accountId"] } : {} };
}

/** The accounts with their sign-ins as far as known, in order, each identity's later accounts naming its first. */
function labelled(instances: readonly Instance[], signIns: readonly (SignIn | undefined)[]): AccountState[] {
  const seen = new Map<string, string>();
  return instances.map((instance, index) => {
    const signIn = signIns[index];
    const place = { id: instance.id, provider: instance.provider, ...instance.folder === undefined ? {} : { folder: instance.folder } };
    if (signIn === undefined) return { ...place, signedIn: false, label: "checking sign-in…", checking: true as const };
    const { signedIn, identity } = signIn;
    let label = signedIn ? identity ?? "signed in · account identity unavailable" : "not signed in";
    let sameAs: string | undefined;
    if (identity !== undefined) {
      const key = `${instance.provider}/${identity.toLowerCase()}`;
      sameAs = seen.get(key);
      if (sameAs !== undefined) label += ` · same account as ${sameAs}`;
      else seen.set(key, instance.id);
    }
    return { ...place, signedIn, ...identity === undefined ? {} : { identity }, ...sameAs === undefined ? {} : { sameAs }, label };
  });
}

/** How many sign-ins `accountStates` checks at once, what stops it, and who hears of the accounts as each check returns. */
export interface AccountStatesOptions {
  /** One at a time unless given. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  /** The accounts as far as known: first at once, before any check, as `checking`, then again as each check returns. */
  readonly onUpdate?: (states: readonly AccountState[]) => void;
}

/**
 * Each account's sign-in, in order: a provider's default sign-in when an
 * account of that provider is declared, or when `also` names it (the one a
 * session runs on), then the declared accounts. Identity comes from Claude
 * Code's status or the ChatGPT credential's account id.
 */
export async function accountStates(credentials: CredentialStore, accounts: readonly Account[],
  status: typeof claudeCodeStatus = claudeCodeStatus, also: readonly string[] = [],
  { concurrency = 1, signal, onUpdate }: AccountStatesOptions = {}): Promise<readonly AccountState[]> {
  const wanted = (provider: Account["provider"]): boolean => accounts.some((account) => account.provider === provider) || also.includes(provider);
  const instances: readonly Instance[] = [
    ...wanted("claude-code") ? [{ id: "claude-code", provider: "claude-code" as const }] : [],
    ...wanted("openai-codex") ? [{ id: "openai-codex", provider: "openai-codex" as const }] : [],
    ...accounts.map((account) => ({ ...account, id: accountId(account) })),
  ];
  const signIns: (SignIn | undefined)[] = instances.map(() => undefined);
  onUpdate?.(labelled(instances, signIns));
  let next = 0;
  const checker = async (): Promise<void> => {
    for (let index = next++; index < instances.length; index = next++) {
      signal?.throwIfAborted();
      const instance = instances[index];
      if (instance === undefined) continue;
      signIns[index] = await signInOf(credentials, instance, status, signal);
      if (signal?.aborted !== true) onUpdate?.(labelled(instances, signIns));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, instances.length)) }, checker));
  signal?.throwIfAborted();
  return labelled(instances, signIns);
}

/** Non-secret labels for account pickers and runs, checking `concurrency` sign-ins at once, one unless given. */
export async function accountLabels(credentials: CredentialStore, accounts: readonly Account[],
  status: typeof claudeCodeStatus = claudeCodeStatus, { concurrency }: Pick<AccountStatesOptions, "concurrency"> = {}): Promise<ReadonlyMap<string, string>> {
  return new Map((await accountStates(credentials, accounts, status, [], concurrency === undefined ? {} : { concurrency }))
    .map(({ id, label }) => [id, label]));
}

/** A Claude plan's OAuth token, which pi-ai's Anthropic API would send as Claude Code does. */
const planToken = (value: string | undefined): boolean => value?.includes("sk-ant-oat") === true;
const noPlanToken = "Tesota takes no Claude plan token: use an Anthropic API key, or Claude through your own Claude Code (claude-code).";

/**
 * pi-ai's Anthropic provider with its API key alone: no Claude sign-in, and
 * no Claude plan's token, from the environment (`ANTHROPIC_OAUTH_TOKEN`) or
 * entered as a key, since Tesota offers no Claude login (`docs/guides/models.md`).
 * Claude on a plan is the `claude-code` provider.
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
 * lists them, ChatGPT's list asked while the sign-ins are checked (#744).
 * Throws when the ChatGPT sign-in's list cannot be fetched.
 */
export async function runnableModels(models: Models): Promise<readonly Model<Api>[]> {
  const [available, served] = await Promise.all([models.getAvailable(), servedByChatGPT(models)]);
  return narrowed(available, served);
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
