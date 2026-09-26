import { createModels, type AuthInteraction, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/**
 * `tesota auth login`: Codex OAuth through Pi's device-code flow. Login never
 * reaches a model: every inference entry point is replaced before the flow
 * starts, and an attempt fails the login even when something catches it.
 */

/** A login that has not finished by then is abandoned. */
export const LOGIN_TIME_LIMIT_MS: number = 180_000;

export type LoginResult = "succeeded" | "failed" | "timed_out";

class LoginTimeout extends Error {
  constructor() { super("Codex login timed out"); }
}

/** A Pi model registry holding only Codex over OAuth, in which any inference attempt calls `deny`. */
function loginModels(credentials: CredentialStore | undefined, deny: () => never): Models {
  const models = createModels(credentials === undefined ? {} : { credentials });
  const provider = openaiCodexProvider();
  for (const method of ["stream", "streamSimple", "complete", "completeSimple",
    "streamDeferred", "fetchDeferred", "cancelDeferred"] as const satisfies readonly (keyof Models)[]) {
    Object.defineProperty(models, method, { value: deny, writable: false, configurable: false });
  }
  for (const method of ["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const) {
    Object.defineProperty(provider, method, { value: deny, writable: false, configurable: false });
  }
  models.setProvider(provider);
  if (models.getProviders().length !== 1 || provider.id !== "openai-codex" ||
      provider.auth.apiKey !== undefined || provider.auth.oauth === undefined) {
    throw new Error("Codex login is not isolated to OAuth");
  }
  return models;
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
  let inferenceAttempted = false;
  try {
    const models = loginModels(credentials, (): never => {
      inferenceAttempted = true;
      throw new Error("Inference is not allowed during login");
    });
    await runOAuthLogin((auth) => models.login("openai-codex", "oauth", auth), interaction);
    return inferenceAttempted ? "failed" : "succeeded";
  } catch (error) {
    return error instanceof LoginTimeout ? "timed_out" : "failed";
  }
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
