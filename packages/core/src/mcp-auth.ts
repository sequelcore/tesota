import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AuthProvider, McpAuthRequiredError, type McpFetch } from "@earendil-works/pi-mcp";
import {
  authorizeMcp, McpOAuthAuthorizationRequiredError, McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore,
  type OAuthChallenge, type OAuthClientInformationMixed, OAuthCallbackServer, parseWwwAuthenticate, stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
import { tesotaHome } from "../../../src/home.ts";
import type { McpOAuthConfig } from "./mcp-config.ts";
import { withLock, withLockWhile } from "./session-lock.ts";
import { parseJson } from "../../../src/json.ts";
import { writeWholeJson } from "./whole-file.ts";

/**
 * OAuth sign-in for remote MCP servers (#459), as Pi's coding agent signs in
 * (`extensions/mcp/oauth.ts`), smaller: no Client ID Metadata Documents and no
 * configured authorization server. A connection never opens a browser: it
 * sends the stored token and refreshes it; when it cannot, it fails as
 * needing sign-in, which the operator does with `/mcp`.
 */

const callbackHost = "127.0.0.1";
const callbackPath = "/callback";
/** Tokens this close to their expiry are refreshed before they are sent. */
const refreshSkewMs = 30_000;
/** Each request to the authorization server is bounded, so one that does not answer holds nothing up for long. */
const requestTimeoutMs = 15_000;
/** How long a refresh waits for another shell's refresh of the same account: longer than one request may take. */
const refreshWaitMs = 25_000;

/** Where the callback listens, and the redirect URI when its port is fixed. */
function callbackFor(oauth: McpOAuthConfig): { host: string; redirectHost: string; port: number | undefined; path: string; fixed: string | undefined } {
  const url = new URL(oauth.callbackUrl ?? `http://${callbackHost}${callbackPath}`);
  const address = url.hostname.replace(/^\[|\]$/gu, "");
  const port = url.port === "" ? oauth.callbackPort : Number(url.port);
  let fixed: string | undefined;
  // A configured URI with a port goes exactly as written, since servers compare it as text.
  if (url.port !== "") fixed = oauth.callbackUrl;
  else if (port !== undefined) { url.port = String(port); fixed = url.href; }
  // `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
  return { host: address === "localhost" ? callbackHost : address, redirectHost: address, port, path: url.pathname, fixed };
}

const authFile = (home: string): string => join(home, "mcp-auth.json");
/** A server's credentials are its name's and its URL's: servers sharing a URL keep separate accounts. */
const keyOf = (server: string, url: string): string => `${server}|${new URL(url).href}`;

function readStates(home: string): Record<string, McpOAuthState> {
  try {
    const read: unknown = parseJson(readFileSync(authFile(home), "utf8"));
    return typeof read === "object" && read !== null && !Array.isArray(read) ? read as Record<string, McpOAuthState> : {};
  } catch {
    return {};
  }
}

/** Changes the stored credentials under a lock, so two shells signing in at once each keep the other's; readable by its owner only. */
function changeStates(home: string, change: (states: Record<string, McpOAuthState>) => void): void {
  withLock(`${authFile(home)}.lock`, () => {
    const states = readStates(home);
    change(states);
    writeWholeJson(authFile(home), states, 0o600);
  });
}

function storeFor(server: string, url: string, home: string): McpOAuthStateStore {
  const key = keyOf(server, url);
  return {
    load: () => readStates(home)[key],
    save: (state) => { changeStates(home, (states) => { states[key] = state; }); },
  };
}

/** `fetch` bounded per request, on top of the request's own signal. */
const timedFetch = (fetch: McpFetch = globalThis.fetch): McpFetch => (input, init) => {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return fetch(input, { ...init, signal: init?.signal === undefined || init.signal === null ? timeout : AbortSignal.any([init.signal, timeout]) });
};

const redirectsOf = (client: OAuthClientInformationMixed | undefined): string[] =>
  client !== undefined && "redirect_uris" in client ? client.redirect_uris : [];

function provider(url: string, store: McpOAuthStateStore, oauth: McpOAuthConfig, redirectUrl: string, onRedirect: (url: URL) => void): McpOAuthProvider {
  return new McpOAuthProvider({ serverUrl: url, redirectUrl, clientMetadata: { client_name: oauth.clientName ?? "tesota" },
    ...oauth.clientId === undefined ? {} : { clientId: oauth.clientId },
    ...oauth.clientSecret === undefined ? {} : { clientSecret: oauth.clientSecret }, store, onRedirect });
}

/** Whether connecting failed because the operator must sign in to the server first. */
export const needsSignIn = (error: unknown): boolean =>
  error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError;

/** A remote server's stored credentials, as its connections send them. */
export interface StoredAuth extends AuthProvider {
  /** Settles once no refresh is running, so signing out or closing does not race a token being saved. */
  settled(): Promise<void>;
  /** What the server last said when it refused a request, for the next sign-in: where its metadata is and the scope it wants. */
  challenge(): OAuthChallenge | undefined;
}

/**
 * The transport's credentials from what is stored: the access token,
 * refreshed when about to expire or after a 401. One refresh runs at a time
 * for the account, in this shell and across shells, since a server that
 * replaces refresh tokens refuses the second. With none stored, or a refresh
 * refused, connecting fails as `needsSignIn`. A server asking for more scope
 * needs a new sign-in.
 */
export function storedAuth(server: string, url: string, oauth: McpOAuthConfig, home: string = tesotaHome()): StoredAuth {
  const store = storeFor(server, url, home);
  let refreshing: Promise<void> | undefined;
  let refused: OAuthChallenge | undefined;
  /** Replaces `stale`, the token that expired or was refused; tokens that changed meanwhile, here or in another shell, are kept. */
  const refresh = (stale: string | undefined, fetch: McpFetch = globalThis.fetch, scope?: string): Promise<void> => refreshing ??= withLockWhile(
    `${authFile(home)}.${createHash("sha256").update(keyOf(server, url)).digest("hex").slice(0, 16)}.refresh`, async () => {
    const state = await store.load();
    if (state?.tokens?.access_token !== stale) return;
    if (state?.tokens?.refresh_token === undefined) throw new McpOAuthAuthorizationRequiredError();
    const redirectUrl = callbackFor(oauth).fixed ?? redirectsOf(state.clientInformation)[0] ?? `http://${callbackHost}${callbackPath}`;
    // Not stopped once sent: a refresh the server answered may have replaced the refresh token, so its answer is kept.
    const result = await authorizeMcp(provider(url, store, oauth, redirectUrl, () => undefined),
      { serverUrl: url, fetch: timedFetch(fetch), ...scope === undefined ? {} : { scope } });
    if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
  }, refreshWaitMs).finally(() => { refreshing = undefined; });
  return {
    token: async () => {
      await refreshing?.catch(() => undefined);
      const state = await store.load();
      const token = state?.tokens?.access_token;
      const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - refreshSkewMs <= Date.now();
      if (!expired || state?.tokens?.refresh_token === undefined) return token;
      // A failed refresh sends the old token: the server's 401 then decides.
      await refresh(token).catch(() => undefined);
      return (await store.load())?.tokens?.access_token;
    },
    onUnauthorized: async (context) => {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
      refused = challenge;
      if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
      await refresh(context.token, context.fetch, challenge.scope);
    },
    settled: async () => { await refreshing?.catch(() => undefined); },
    challenge: () => refused,
  };
}

/**
 * Signs in to the server at `url`: a stored refresh token when it still
 * works, else the browser's authorization code flow with PKCE and, without
 * a configured client, dynamic registration, answered on a loopback
 * callback. `open` shows the operator the page. Stopping `signal` stops
 * it, and its callback closes either way.
 */
export async function signIn(server: string, url: string, oauth: McpOAuthConfig, open: (page: URL) => void, signal: AbortSignal,
  home: string = tesotaHome(), challenge?: OAuthChallenge): Promise<void> {
  if (signal.aborted) throw new Error("Sign-in cancelled.");
  const store = storeFor(server, url, home);
  const stored = await store.load();
  const callback = callbackFor(oauth);
  // The registered redirect URI's port is used again, so the registered client stays valid.
  const registered = redirectsOf(stored?.clientInformation)[0];
  const port = callback.port ?? (registered === undefined ? undefined : Number(new URL(registered).port) || undefined);
  const listen = (at: number | undefined) => OAuthCallbackServer.listen({ host: callback.host, redirectHost: callback.redirectHost,
    path: callback.path, port: at ?? 0 });
  const listener = await listen(port).catch((error: unknown) => {
    if (callback.port !== undefined || port === undefined) throw error;
    return listen(undefined);
  });
  const redirectUrl = callback.fixed ?? listener.redirectUrl;
  try {
    if (stored !== undefined) await store.save(fresh(stored, oauth, redirectUrl));
    let page: URL | undefined;
    const flow = provider(url, store, oauth, redirectUrl, (at) => { page = at; });
    // A server asking for more scope gets it beside what was granted, through the browser: a refresh keeps the old scope.
    const more = challenge?.error === "insufficient_scope";
    const options = { serverUrl: url, fetch: timedFetch(), signal, ...asked(oauth, stored, challenge) };
    if (await authorizeMcp(flow, { ...options, skipRefresh: more }) === "AUTHORIZED") return;
    if (page === undefined) throw new Error("The server's sign-in gave no page to open.");
    const state = await flow.state();
    const expected = new URL(page.searchParams.get("redirect_uri") ?? redirectUrl);
    open(page);
    const { code, iss } = await answered(listener, state, expected, signal);
    await authorizeMcp(flow, { ...options, authorizationCode: code, ...iss === undefined ? {} : { iss } });
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in cancelled.", { cause: error });
    throw error;
  } finally {
    await listener.close();
  }
}

/** What a new sign-in keeps of `stored`: never its last `state`; a registered client and its tokens only while its redirect URI still holds. */
function fresh(stored: McpOAuthState, oauth: McpOAuthConfig, redirectUrl: string): McpOAuthState {
  const next: McpOAuthState = { ...stored };
  delete next.oauthState;
  if (oauth.clientId === undefined && !redirectsOf(stored.clientInformation).includes(redirectUrl)) {
    delete next.clientInformation;
    delete next.tokens;
    delete next.tokensExpireAt;
  }
  return next;
}

/** Where the server said its metadata is, and the scopes to ask for: configured, challenged, and for more scope what was granted too. */
function asked(oauth: McpOAuthConfig, stored: McpOAuthState | undefined, challenge: OAuthChallenge | undefined): { resourceMetadataUrl?: URL; scope?: string } {
  const more = challenge?.error === "insufficient_scope";
  const words = [oauth.scope, more ? stepUpScope(stored?.tokens?.scope, challenge.scope) : challenge?.scope]
    .flatMap((each) => each?.split(/\s+/u).filter((word) => word !== "") ?? []);
  return { ...challenge?.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl },
    ...words.length === 0 ? {} : { scope: [...new Set(words)].join(" ") } };
}

/** The browser's redirect to the callback, or the sign-in's stop. */
async function answered(callback: OAuthCallbackServer, state: string, expected: URL, signal: AbortSignal): Promise<{ code: string; iss?: string }> {
  const fromBrowser = callback.waitForCallback(state, expected.pathname);
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = (): void => { reject(new Error("Sign-in cancelled.")); };
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([fromBrowser, stopped]);
  } finally {
    if (stop !== undefined) signal.removeEventListener("abort", stop);
    fromBrowser.catch(() => undefined);
    stopped.catch(() => undefined);
  }
}

/** Forgets the server's credentials. */
export function signOut(server: string, url: string, home: string = tesotaHome()): void {
  const key = keyOf(server, url);
  if (readStates(home)[key] === undefined) return;
  changeStates(home, (states) => { delete states[key]; });
}

/** Whether tokens are stored for the server. */
export const signedIn = (server: string, url: string, home: string = tesotaHome()): boolean =>
  readStates(home)[keyOf(server, url)]?.tokens?.access_token !== undefined;
