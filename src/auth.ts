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
import { ACCOUNT_KINDS, type AddedRoute, addRoute, isDecisionModel, MODEL_ROLES, parseModelChoice, readAddedRoutes, readModelChoices,
  removeRoute, type RouteKind } from "./model-roles.js";
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

/** What Claude Code says about a route's sign-in, without any credential in it. */
export function claudeCodeSignIn(output: string, route: string = "claude-code"): string {
  let value: unknown;
  try { value = JSON.parse(output); } catch { value = undefined; }
  if (typeof value !== "object" || value === null) return "status unavailable";
  if (Reflect.get(value, "loggedIn") !== true) return `signed out: tesota auth login ${route}`;
  const method = Reflect.get(value, "authMethod");
  return `signed in${typeof method === "string" ? ` with ${method}` : ""}${route === "claude-code" ? " (your own Claude Code)" : ""}`;
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
  const { label, provider, source } = keyRoutes[route];
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
  if (action === "status") return statusOf([route.name], new TesotaCredentials());
  const code = route.kind === "codex" ? await codex(action, TesotaCredentials.forRoute(route.name, "openai-codex"), route.name)
    : await claudeCode(action, route.name);
  if (action === "logout" && code === 0) {
    removeRoute(route.name);
    console.log(`${route.name}: route removed.`);
  }
  return code;
}

/** One route's line in `tesota auth status`. */
export interface RouteStatus {
  readonly route: string;
  readonly kind: string;
  readonly signIn: string;
}

const kindLabels: Readonly<Record<string, string>> = { codex: "Codex", "claude-code": "Claude Code", anthropic: "Anthropic API",
  openrouter: "OpenRouter", opencode: "OpenCode", typesafe: "TypeSafe" };

/** A key route's sign-in: a saved key, one from the environment, or none. */
async function keySignIn(route: KeyRouteName, credentials: TesotaCredentials): Promise<string> {
  const { provider, variable } = keyRoutes[route];
  const saved = await credentials.read(provider);
  if (saved !== undefined) return `key saved${saved.type === "oauth" ? " from your sign-in" : ""}${route === "opencode" ? ", for Zen and Go" : ""}`;
  return (process.env[variable] ?? "").length > 0 ? `key from ${variable}` : `no key: tesota auth login ${route}`;
}

/** A route's sign-in, as its status line shows it. */
async function signInOf(route: string, kind: string, credentials: TesotaCredentials): Promise<string> {
  if (kind === "codex") {
    const store = route === "codex" ? credentials : TesotaCredentials.forRoute(route, "openai-codex");
    return await store.read("openai-codex") !== undefined ? "signed in" : `signed out: tesota auth login ${route}`;
  }
  if (kind === "claude-code") {
    const env = route === "claude-code" ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: claudeCodeRouteDirectory(route) };
    const result = spawnSync(claudeCodeExecutable(), ["auth", "status"], { encoding: "utf8", windowsHide: true, timeout: 30_000, env });
    return result.status === 0 ? claudeCodeSignIn(result.stdout, route) : "status unavailable";
  }
  return keySignIn(kind as KeyRouteName, credentials);
}

/**
 * The status table: each route, its kind, its sign-in and the roles that use
 * it, then what a sign-in does not show. A plan's models are known only when
 * a role uses them, so the table never claims one.
 */
export function statusTable(rows: readonly RouteStatus[], usedBy: (route: string) => readonly string[]): string {
  const width = (pick: (row: RouteStatus) => string, heading: string): number =>
    Math.max(heading.length, ...rows.map((row) => pick(row).length)) + 2;
  const [route, kind, signIn] = [width((row) => row.route, "Route"), width((row) => row.kind, "Kind"),
    width((row) => row.signIn, "Sign-in")];
  const line = (a: string, b: string, c: string, d: string): string => `${a.padEnd(route)}${b.padEnd(kind)}${c.padEnd(signIn)}${d}`.trimEnd();
  return [line("Route", "Kind", "Sign-in", "Used by"),
    ...rows.map((row) => line(row.route, row.kind, row.signIn, usedBy(row.route).join(", ") || "—")), "",
    "A plan's models are checked when a role first uses them. Claude Code keeps its own sign-ins; Tesota keeps the rest in " +
    "~/.tesota/auth.", ""].join("\n");
}

/** The roles using each route; the triage role's typed decision model counts for TypeSafe, OpenCode Go's for OpenCode. */
function usedByRoute(added: readonly AddedRoute[]): (route: string) => string[] {
  const choices = readModelChoices();
  return (route) => MODEL_ROLES.filter((role) => {
    const choice = choices[role];
    if (isDecisionModel(choice)) return route === "typesafe";
    const parsed = parseModelChoice(choice, added)?.route;
    return parsed === route || route === "opencode" && parsed === "opencode-go";
  });
}

/** The status of these routes, every route when none is named, as one table. */
async function statusOf(names: readonly string[], credentials: TesotaCredentials): Promise<number> {
  const added = readAddedRoutes();
  const rows = await Promise.all(names.map(async (route): Promise<RouteStatus> => {
    const kind = added.find((entry) => entry.name === route)?.kind ?? route;
    return { route, kind: kindLabels[kind] ?? kind, signIn: await signInOf(route, kind, credentials) };
  }));
  process.stdout.write(statusTable(rows, usedByRoute(added)));
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
  if (action === "status" && route === undefined) {
    // Each kind's default route, followed by the routes added for it.
    const added = readAddedRoutes();
    const names = routes.flatMap((kind) => [kind, ...added.filter((entry) => entry.kind === kind).map((entry) => entry.name)]);
    try { return await statusOf(names, credentials); } catch {
      console.error("The routes' status could not be read. Credentials were not printed. Check private storage and retry.");
      return 1;
    }
  }
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
  if (action === "status") return statusOf([chosen], credentials);
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
