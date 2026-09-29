import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { browserSignInAuth, deviceCodeAuth, deviceCodeTerminalRenderer, loginToCodex, loginToOpenRouter,
  type LoginResult } from "./integrations/codex-login.js";
import { claudeCodeRouteDirectory } from "./integrations/model-session.js";
import { TesotaCredentials } from "./integrations/tesota-credentials.js";
import { ACCOUNT_KINDS, type AddedRoute, addRoute, MODEL_ROLES, parseModelChoice, readAddedRoutes, readModelChoices, removeRoute,
  type RouteKind } from "./model-roles.js";
import { windowsSystemProgram } from "./windows-system.js";

/**
 * `tesota auth` for each route (decisions 021 and 031). Tesota stores Codex's
 * OAuth login, an Anthropic API key, an OpenRouter key, one OpenCode key,
 * which Zen and Go share, and a TypeSafe key (decision 035). It never holds a
 * Claude subscription login: for the `claude-code` route it runs Claude Code's
 * own sign-in and status, and reads only whether Claude Code is signed in and
 * how. The operator can add routes of the `codex` and `claude-code` kinds,
 * one account each (decision 050): a Codex route keeps its login in a file
 * of its own, and a Claude Code route signs in with Claude Code in a
 * configuration folder of its own.
 */

export const AUTH_ROUTES = ["codex", "anthropic", "claude-code", "openrouter", "opencode", "typesafe"] as const;
const routes = AUTH_ROUTES;
type AuthRoute = typeof routes[number];

/** A route whose credential is a key the operator pastes: its name, Pi's provider, the key's environment variable, and where to get one. */
interface KeyRoute {
  readonly label: string;
  readonly provider: string;
  readonly variable: string;
  readonly source: string;
}

type KeyRouteName = "anthropic" | "openrouter" | "opencode" | "typesafe";
const keyRoutes: Readonly<Record<KeyRouteName, KeyRoute>> = {
  anthropic: { label: "Anthropic API", provider: "anthropic", variable: "ANTHROPIC_API_KEY", source: "https://console.anthropic.com" },
  openrouter: { label: "OpenRouter", provider: "openrouter", variable: "OPENROUTER_API_KEY", source: "https://openrouter.ai/settings/keys" },
  opencode: { label: "OpenCode (Zen and Go)", provider: "opencode", variable: "OPENCODE_API_KEY", source: "https://opencode.ai/auth" },
  typesafe: { label: "TypeSafe (Jev)", provider: "typesafe", variable: "TYPESAFE_API_KEY", source: "https://console.typesafe.ai" },
};

/** The Claude Code program bundled with the Claude Agent SDK for this platform, unmodified. */
export function claudeCodeExecutable(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
  const executable = join(dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude");
  if (!existsSync(executable)) throw new Error("Claude Code is not installed with Tesota for this platform");
  return executable;
}

/** What Claude Code says about its own sign-in, without any credential in it. */
export function claudeCodeStatus(output: string): string {
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null) return "Claude Code: status unavailable.";
  if (Reflect.get(value, "loggedIn") !== true) return "Claude Code: signed out. Run tesota auth login claude-code.";
  const method = Reflect.get(value, "authMethod");
  return `Claude Code: signed in${typeof method === "string" ? ` (${method})` : ""}. Tesota does not hold this login.`;
}

/**
 * Read a line from the terminal, shown as it is typed or, for a secret, not
 * at all; a secret is never printed. The signal withdraws the question.
 */
async function readLine(prompt: string, options: { hidden: boolean; signal?: AbortSignal }): Promise<string> {
  const input = process.stdin;
  if (input.isTTY !== true || typeof input.setRawMode !== "function") throw new Error("An interactive terminal is required");
  options.signal?.throwIfAborted();
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((settle, fail) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      options.signal?.removeEventListener("abort", withdrawn);
      process.stdout.write("\n");
      if (error === undefined) settle(value); else fail(error);
    };
    const withdrawn = (): void => { finish(new DOMException("cancelled", "AbortError")); };
    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u0003") { finish(new Error("Cancelled")); return; }
        if (character === "\u007f" || character === "\b") {
          if (!options.hidden && value.length > 0) process.stdout.write("\b \b");
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
          if (!options.hidden) process.stdout.write(character);
        }
      }
    };
    options.signal?.addEventListener("abort", withdrawn, { once: true });
    input.on("data", onData);
  });
}

const readSecret = (prompt: string): Promise<string> => readLine(prompt, { hidden: true });

/** Open an address in the operator's browser; the address is also shown, so a failure here is not an error. */
function openInBrowser(url: string): void {
  const [program, args] = process.platform === "win32"
    ? [windowsSystemProgram("rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => {});
  child.unref();
}

async function codex(action: string, credentials: TesotaCredentials, route: string = "codex"): Promise<number> {
  const label = route === "codex" ? "Codex" : `Codex (${route})`;
  if (action === "status") {
    console.log(await credentials.read("openai-codex") !== undefined
      ? `${label}: saved login available. Model access is checked when used.`
      : `${label}: logged out. Run tesota auth login ${route}.`);
    return 0;
  }
  if (action === "logout") {
    const models = createModels({ credentials });
    models.setProvider(openaiCodexProvider());
    await models.logout("openai-codex");
    console.log(`${label}: local Tesota credentials removed.`);
    return 0;
  }
  if (await credentials.read("openai-codex") !== undefined) {
    console.log(`${label}: already logged in. To change accounts, run tesota auth logout ${route} first.`);
    return 0;
  }
  const cancel = new AbortController();
  const watchdog = setTimeout(() => process.exit(1), 185_000);
  try {
    if (await loginToCodex(deviceCodeAuth(deviceCodeTerminalRenderer(), cancel.signal), credentials) !== "succeeded") {
      throw new Error("Login did not complete");
    }
    console.log(`${label}: login saved for future Tesota runs.`);
    return 0;
  } finally { cancel.abort(); clearTimeout(watchdog); }
}

async function pastedKey(route: KeyRouteName, action: string, credentials: TesotaCredentials): Promise<number> {
  const { label, provider, variable, source } = keyRoutes[route];
  if (action === "status") {
    const saved = await credentials.read(provider);
    const ambient = (process.env[variable] ?? "").length > 0;
    console.log(saved !== undefined ? `${label}: saved ${saved.type === "oauth" ? "key from your sign-in" : "key"} available.` : ambient
      ? `${label}: ${variable} is set; no key saved.` : `${label}: no key. Run tesota auth login ${route}.`);
    return 0;
  }
  if (action === "logout") {
    await credentials.delete(provider);
    console.log(`${label}: saved key removed.`);
    return 0;
  }
  console.log(`Create a key at ${source}.`);
  const key = (await readSecret(`${label} key (not shown): `)).trim();
  if (key.length === 0) { console.error("No key entered; nothing was saved."); return 1; }
  await credentials.modify(provider, async () => ({ type: "api_key", key }));
  console.log(`${label}: key saved for future Tesota runs.`);
  return 0;
}

/** Sign in to OpenRouter in the browser, or save a key the operator already has (decision 031). */
async function openRouter(action: string, credentials: TesotaCredentials): Promise<number> {
  if (action !== "login") return pastedKey("openrouter", action, credentials);
  const answer = (await readLine("OpenRouter: sign in with your [b]rowser (default), or paste a [k]ey you have: ",
    { hidden: false })).trim().toLowerCase();
  if (answer === "k" || answer === "key") return pastedKey("openrouter", action, credentials);
  const cancel = new AbortController();
  let result: LoginResult;
  try {
    result = await loginToOpenRouter(browserSignInAuth({ open: openInBrowser, write: (text) => { process.stdout.write(text); },
      readLine: (prompt, signal) => readLine(prompt, { hidden: true, signal }) }, cancel.signal), credentials);
  } finally { cancel.abort(); }
  if (result !== "succeeded") {
    console.error(result === "timed_out" ? "OpenRouter: the sign-in timed out; nothing was saved." : "OpenRouter: the sign-in did not complete; nothing was saved.");
    return 1;
  }
  console.log("OpenRouter: signed in; the key OpenRouter issued is saved for future Tesota runs. You can revoke it at " +
    "https://openrouter.ai/settings/keys. Free models' providers may keep your code: tesota models openrouter marks them.");
  return 0;
}

/**
 * Claude Code's own sign-in, status and sign-out. An added route runs them in
 * its own configuration folder, so they touch only that account; the default
 * route is the operator's own Claude Code, which Tesota never signs out.
 */
async function claudeCode(action: string, route: string = "claude-code"): Promise<number> {
  const added = route !== "claude-code";
  if (action === "logout" && !added) {
    console.log("Claude Code: Tesota does not hold this login, and signing out here would also sign out your own Claude " +
      "Code. Use claude auth logout if that is what you want.");
    return 0;
  }
  const executable = claudeCodeExecutable();
  const directory = claudeCodeRouteDirectory(route);
  if (added) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = added ? { ...process.env, CLAUDE_CONFIG_DIR: directory } : process.env;
  if (action === "status") {
    const result = spawnSync(executable, ["auth", "status"], { encoding: "utf8", windowsHide: true, timeout: 30_000, env });
    const label = added ? `Claude Code (${route})` : "Claude Code";
    if (result.status !== 0) { console.log(`${label}: status unavailable.`); return 1; }
    console.log(claudeCodeStatus(result.stdout).replace(/^Claude Code/u, label).replace("tesota auth login claude-code",
      `tesota auth login ${route}`));
    return 0;
  }
  // Anthropic's own sign-in and sign-out, in the operator's terminal; nothing passes through Tesota.
  return new Promise((settle) => {
    const child = spawn(executable, ["auth", action], { stdio: "inherit", env });
    child.once("error", () => { settle(1); });
    child.once("close", (code) => { settle(code ?? 1); });
  });
}

/** The roles whose chosen model is on this route, which keep it from being removed. */
function rolesOn(route: string, added: readonly AddedRoute[]): string[] {
  const choices = readModelChoices();
  return MODEL_ROLES.filter((role) => parseModelChoice(choices[role], added)?.route === route);
}

/** Sign an added route in, show its status, or sign it out and remove it when no role uses it. */
async function addedRoute(action: string, route: AddedRoute): Promise<number> {
  if (action === "logout") {
    const roles = rolesOn(route.name, readAddedRoutes());
    if (roles.length > 0) {
      console.error(`${route.name} is in use by ${roles.join(", ")}; choose other models for them with tesota roles first.`);
      return 1;
    }
  }
  const code = route.kind === "codex" ? await codex(action, TesotaCredentials.forRoute(route.name, "openai-codex"), route.name)
    : await claudeCode(action, route.name);
  if (action === "logout" && code === 0) {
    removeRoute(route.name);
    console.log(`${route.name}: route removed.`);
  }
  return code;
}

/** Every route's sign-in: each kind's default route, then the routes the operator added. */
async function statusOfAll(credentials: TesotaCredentials): Promise<number> {
  for (const route of routes) {
    await runAuthCommand("status", route, credentials);
  }
  for (const route of readAddedRoutes()) await addedRoute("status", route);
  return 0;
}

/**
 * Add a route of a kind, signed in to another account: `tesota auth login
 * codex --as codex-work` (decision 050).
 */
export async function addAccount(kind: string, name: string): Promise<number> {
  if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) {
    console.error(`Other accounts can be added for ${ACCOUNT_KINDS.join(" and ")}, not ${kind}.`);
    return 2;
  }
  const existing = readAddedRoutes().find((route) => route.name === name);
  if (existing !== undefined && existing.kind !== kind) {
    console.error(`${name} is already a ${existing.kind} route.`);
    return 2;
  }
  try {
    if (existing === undefined) addRoute(name, kind as RouteKind);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The route could not be added.");
    return 2;
  }
  console.log(`${name}: a ${kind} route; choose its models as ${name}:<model> with tesota roles.`);
  return addedRoute("login", { name, kind: kind as RouteKind });
}

export async function runAuthCommand(action: string, route?: string,
  credentials: TesotaCredentials = new TesotaCredentials()): Promise<number> {
  if (action === "status" && route === undefined) return statusOfAll(credentials);
  const chosen = route ?? "codex";
  const added = readAddedRoutes().find((entry) => entry.name === chosen);
  if (["login", "status", "logout"].includes(action) && added !== undefined) {
    try { return await addedRoute(action, added); } catch {
      console.error(`${chosen} authentication operation failed. Credentials were not printed. Check private storage or retry after resolving the failure.`);
      return 1;
    }
  }
  if (!["login", "status", "logout"].includes(action) || !(routes as readonly string[]).includes(chosen)) {
    console.error(`Usage: tesota auth <login|status|logout> [${routes.join("|")}|<added route>] [--as <name>]`);
    return 2;
  }
  try {
    switch (chosen as AuthRoute) {
      case "codex": return await codex(action, credentials);
      case "claude-code": return await claudeCode(action);
      case "openrouter": return await openRouter(action, credentials);
      case "anthropic": case "opencode": case "typesafe": return await pastedKey(chosen as KeyRouteName, action, credentials);
    }
  } catch {
    console.error(`${chosen} authentication operation failed. Credentials were not printed. Check private storage or retry after resolving the failure.`);
    return 1;
  }
}
