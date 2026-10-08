import { createModels, type AuthInteraction, type CredentialStore, type LoginOptions, type Models, type Provider } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { CHATGPT_AGENT_NAME, chatgptProvider } from "./chatgpt-provider.js";

/**
 * `tesota auth login` for the routes that sign in through Pi in the browser:
 * Sign in with ChatGPT (#191), and OpenRouter's sign-in (decision 031), which
 * issues a lasting key. Login never reaches a model: every inference entry
 * point is replaced before the flow starts, and an attempt fails the login
 * even when something catches it.
 */

/** A login that has not finished by then is abandoned. */
export const LOGIN_TIME_LIMIT_MS: number = 180_000;

/**
 * How a login ended. `not_granted`: OpenAI signed the account in but did not
 * grant the API access a plan's route needs. `refused`: the provider refused
 * the code exchange. `declined`: the sign-in was declined in the browser.
 */
export type LoginResult = "succeeded" | "failed" | "timed_out" | "not_granted" | "refused" | "declined";

/** Pi's known sign-in failures, by the words of its error; anything else is a plain failure, never shown raw. */
const knownFailures: readonly (readonly [RegExp, LoginResult])[] = [
  [/did not include chatgpt\.tokens\.use\.direct/u, "not_granted"],
  [/OAuth token request failed \(\d{3}\)/u, "refused"],
  [/authorization failed: /u, "declined"],
];

function failureOf(error: unknown): LoginResult {
  const message = error instanceof Error ? error.message : "";
  return knownFailures.find(([pattern]) => pattern.test(message))?.[1] ?? "failed";
}

class LoginTimeout extends Error {
  constructor() { super("Login timed out"); }
}

/** A Pi model registry holding only this provider, with OAuth, in which any inference attempt calls `deny`. */
function loginModels(provider: Provider, credentials: CredentialStore | undefined, deny: () => never): Models {
  const models = createModels(credentials === undefined ? {} : { credentials });
  for (const method of ["stream", "streamSimple", "complete", "completeSimple",
    "streamDeferred", "fetchDeferred", "cancelDeferred"] as const satisfies readonly (keyof Models)[]) {
    Object.defineProperty(models, method, { value: deny, writable: false, configurable: false });
  }
  for (const method of ["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const) {
    Object.defineProperty(provider, method, { value: deny, writable: false, configurable: false });
  }
  models.setProvider(provider);
  if (models.getProviders().length !== 1 || provider.auth.oauth === undefined) throw new Error("Login is not isolated to OAuth");
  return models;
}

/** Sign in to one provider and save the credential; succeeds only if no inference was attempted. */
async function isolatedLogin(provider: Provider, interaction: AuthInteraction, credentials?: CredentialStore,
  options?: LoginOptions): Promise<LoginResult> {
  let inferenceAttempted = false;
  try {
    const models = loginModels(provider, credentials, (): never => {
      inferenceAttempted = true;
      throw new Error("Inference is not allowed during login");
    });
    await runOAuthLogin((auth) => models.login(provider.id, "oauth", auth, options), interaction);
    return inferenceAttempted ? "failed" : "succeeded";
  } catch (error) {
    return error instanceof LoginTimeout ? "timed_out" : failureOf(error);
  }
}

/**
 * Run a login within the time limit. The first outcome wins: once it has
 * timed out or been cancelled, the flow can no longer prompt or notify.
 */
export async function runOAuthLogin(login: (interaction: AuthInteraction) => Promise<unknown>,
  interaction: AuthInteraction): Promise<void> {
  const cancellation = new AbortController();
  const signal = interaction.signal === undefined ? cancellation.signal : AbortSignal.any([interaction.signal, cancellation.signal]);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "succeeded" | "failed", error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (outcome === "succeeded") resolve();
      else reject(error);
    };
    const aborted = (): void => finish("failed", signal.reason);
    const timer = setTimeout(() => {
      const failure = new LoginTimeout();
      finish("failed", failure);
      cancellation.abort(failure);
    }, LOGIN_TIME_LIMIT_MS);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    try {
      void login({
        signal,
        prompt: (prompt) => {
          if (settled || signal.aborted) return Promise.reject(new Error("Login interaction closed"));
          return interaction.prompt(prompt);
        },
        notify: (event) => {
          if (settled || signal.aborted) throw new Error("Login interaction closed");
          interaction.notify(event);
        },
      }).then(() => finish("succeeded"), (error: unknown) => finish("failed", error));
    } catch (error) { finish("failed", error); }
  });
}

/**
 * Sign in with ChatGPT and save the credential, naming Tesota and this
 * installation to OpenAI; succeeds only if no inference was attempted.
 */
export async function loginToChatGPT(interaction: AuthInteraction, deviceId: string, credentials?: CredentialStore): Promise<LoginResult> {
  const provider = chatgptProvider();
  // The route is reached only with its sign-in, never with an API key.
  if (provider.auth.apiKey !== undefined) return "failed";
  return isolatedLogin(provider, interaction, credentials, { getDeviceId: () => deviceId, agentName: CHATGPT_AGENT_NAME });
}

/**
 * Sign in to OpenRouter in the browser and save the key it issues (decision
 * 031); succeeds only if no inference was attempted.
 */
export async function loginToOpenRouter(interaction: AuthInteraction, credentials?: CredentialStore): Promise<LoginResult> {
  return isolatedLogin(openrouterProvider(), interaction, credentials);
}

/** A site Tesota signs in to in the browser, and the only address its sign-in may open. */
export interface BrowserSignInSite {
  readonly name: string;
  readonly origin: string;
  readonly pathname: string;
}

export const OPENROUTER_SIGN_IN: BrowserSignInSite = { name: "OpenRouter", origin: "https://openrouter.ai", pathname: "/auth" };
export const CHATGPT_SIGN_IN: BrowserSignInSite = { name: "ChatGPT", origin: "https://auth.openai.com", pathname: "/api/accounts/authorize" };

/** How the browser sign-in reaches the operator: the browser, the terminal, and a line they may paste. */
export interface BrowserSignInTerminal {
  readonly open: (url: string) => void;
  readonly write: (text: string) => void;
  /** Read a line, which stays hidden; the signal withdraws the question once the browser has returned. */
  readonly readLine: (prompt: string, signal: AbortSignal) => Promise<string>;
}

/**
 * A browser sign-in through Pi's PKCE flow: it opens the site's own sign-in
 * page, which returns to a server on this computer; when the browser cannot
 * reach it, such as on another computer, the operator pastes the address it
 * ended on. Any other address or request fails the sign-in.
 */
export function browserSignInAuth(site: BrowserSignInSite, terminal: BrowserSignInTerminal, signal: AbortSignal): AuthInteraction {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  const reject = (): never => {
    const error = new Error("Sign-in interaction unavailable or unexpected");
    cancellation.abort(error);
    throw error;
  };
  return {
    signal: combined,
    prompt: async (prompt) => {
      if (combined.aborted || prompt.type !== "manual_code") return reject();
      return terminal.readLine("If the browser is on another computer, paste the address it ended on (not shown): ",
        prompt.signal === undefined ? combined : AbortSignal.any([combined, prompt.signal]));
    },
    notify: (event) => {
      if (combined.aborted) return reject();
      if (event.type === "info" || event.type === "progress") return;
      let address: URL | undefined;
      try { address = event.type === "auth_url" ? new URL(event.url) : undefined; } catch { address = undefined; }
      if (address?.origin !== site.origin || address.pathname !== site.pathname) return reject();
      terminal.write(`Sign in with ${site.name} in your browser. If it does not open, go to:\n${address.href}\n`);
      try { terminal.open(address.href); } catch { /* the address is shown; the operator can open it */ }
    },
  };
}
