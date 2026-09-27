import { createModels, type AuthInteraction, type CredentialStore, type Models, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/**
 * `tesota auth login` for the routes that sign in through Pi: Codex OAuth
 * through Pi's device-code flow, and OpenRouter's browser sign-in (decision
 * 031), which issues a lasting key. Login never reaches a model: every
 * inference entry point is replaced before the flow starts, and an attempt
 * fails the login even when something catches it.
 */

/** A login that has not finished by then is abandoned. */
export const LOGIN_TIME_LIMIT_MS: number = 180_000;

export type LoginResult = "succeeded" | "failed" | "timed_out";

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
async function isolatedLogin(provider: Provider, interaction: AuthInteraction, credentials?: CredentialStore): Promise<LoginResult> {
  let inferenceAttempted = false;
  try {
    const models = loginModels(provider, credentials, (): never => {
      inferenceAttempted = true;
      throw new Error("Inference is not allowed during login");
    });
    await runOAuthLogin((auth) => models.login(provider.id, "oauth", auth), interaction);
    return inferenceAttempted ? "failed" : "succeeded";
  } catch (error) {
    return error instanceof LoginTimeout ? "timed_out" : "failed";
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

/** Log in to Codex and save the credential; succeeds only if no inference was attempted. */
export async function loginToCodex(interaction: AuthInteraction, credentials?: CredentialStore): Promise<LoginResult> {
  const provider = openaiCodexProvider();
  // Codex is reached only with its OAuth login, never with an API key.
  if (provider.id !== "openai-codex" || provider.auth.apiKey !== undefined) return "failed";
  return isolatedLogin(provider, interaction, credentials);
}

/**
 * Sign in to OpenRouter in the browser and save the key it issues (decision
 * 031); succeeds only if no inference was attempted.
 */
export async function loginToOpenRouter(interaction: AuthInteraction, credentials?: CredentialStore): Promise<LoginResult> {
  return isolatedLogin(openrouterProvider(), interaction, credentials);
}

/** How the browser sign-in reaches the operator: the browser, the terminal, and a line they may paste. */
export interface BrowserSignInTerminal {
  readonly open: (url: string) => void;
  readonly write: (text: string) => void;
  /** Read a line, which stays hidden; the signal withdraws the question once the browser has returned. */
  readonly readLine: (prompt: string, signal: AbortSignal) => Promise<string>;
}

/**
 * OpenRouter's sign-in, through Pi's PKCE flow: it opens OpenRouter's own
 * sign-in page, which returns to a server on this computer; when the browser
 * cannot reach it, such as on another computer, the operator pastes the
 * address it ended on. Any other address or request fails the sign-in.
 */
export function browserSignInAuth(terminal: BrowserSignInTerminal, signal: AbortSignal): AuthInteraction {
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
      if (address?.origin !== "https://openrouter.ai" || address.pathname !== "/auth") return reject();
      terminal.write(`Sign in with OpenRouter in your browser. If it does not open, go to:\n${address.href}\n`);
      try { terminal.open(address.href); } catch { /* the address is shown; the operator can open it */ }
    },
  };
}

/** The only presentation data taken from Pi's device notification. */
export interface DeviceCodePresentation {
  readonly verificationUri: string;
  readonly userCode: string;
}

/** Requires every standard stream to be interactive; the code is never written to a log. */
export function deviceCodeTerminalRenderer(
  terminal: {
    readonly stdin: { readonly isTTY?: boolean };
    readonly stdout: { readonly isTTY?: boolean };
    readonly stderr: { readonly isTTY?: boolean; write(text: string): unknown };
  } = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): (presentation: DeviceCodePresentation) => void {
  const requireTerminal = (): void => {
    if (terminal.stdin.isTTY !== true || terminal.stdout.isTTY !== true || terminal.stderr.isTTY !== true) {
      throw new Error("Device-code login requires an interactive, unrecorded terminal; captured execution is disabled.");
    }
  };
  requireTerminal();
  return ({ verificationUri, userCode }) => {
    requireTerminal();
    terminal.stderr.write(`Open ${verificationUri} manually. Enter this temporary code only on that website: ${userCode}\n`);
  };
}

/** Selects Pi's device-code option once and shows only the official address and the code; anything else fails. */
export function deviceCodeAuth(render: (presentation: DeviceCodePresentation) => void, signal: AbortSignal): AuthInteraction {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  let selected = false;
  let presented = false;
  const rejectInteraction = (): never => {
    const error = new Error("Device-code interaction unavailable or unexpected");
    cancellation.abort(error);
    throw error;
  };
  return {
    signal: combined,
    prompt: async (prompt) => {
      if (combined.aborted || selected || prompt.signal?.aborted || prompt.type !== "select" ||
          !prompt.options.some((option) => option.id === "device_code")) return rejectInteraction();
      selected = true;
      return "device_code";
    },
    notify: (event) => {
      if (combined.aborted) return rejectInteraction();
      if (event.type === "info" || event.type === "progress") return;
      if (event.type !== "device_code" || !selected || presented ||
          event.verificationUri !== "https://auth.openai.com/codex/device" ||
          typeof event.userCode !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(event.userCode)) return rejectInteraction();
      presented = true;
      // Explicit two-field projection. Never forward, serialize or spread the notification.
      try { render({ verificationUri: event.verificationUri, userCode: event.userCode }); }
      catch { rejectInteraction(); }
    },
  };
}
